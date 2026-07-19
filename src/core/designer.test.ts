import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_WRITES,
  designerCliArgs,
  designerMcpConfig,
  evaluateGate,
  gateConfig,
  gateDecision,
  resolveDesigner,
} from "./designer";

describe("resolveDesigner", () => {
  it("requires a branch", () => {
    expect(() => resolveDesigner({} as any)).toThrowError(/branch/);
  });

  it("applies defaults around the branch", () => {
    const d = resolveDesigner({ branch: "design" });
    expect(d.branch).toBe("design");
    expect(d.baseBranch).toBe("main");
    expect(d.allowWrites).toEqual([".*"]);
    expect(d.denyWrites).toEqual(DEFAULT_DENY_WRITES);
    expect(d.mcpAllow).toEqual([]);
    expect(d.stubTag).toBe("@design-stub");
    // The default preamble must teach the stub convention using the configured tag.
    expect(d.preamble).toContain("@design-stub");
  });

  it("keeps explicit options and interpolates a custom stub tag into the default preamble", () => {
    const d = resolveDesigner({
      branch: "develop-design",
      baseBranch: "develop",
      allowWrites: ["^src/components/"],
      denyWrites: ["^src/api/"],
      mcpAllow: ["linear"],
      stubTag: "@mock-me",
    });
    expect(d.baseBranch).toBe("develop");
    expect(d.allowWrites).toEqual(["^src/components/"]);
    expect(d.denyWrites).toEqual(["^src/api/"]);
    expect(d.mcpAllow).toEqual(["linear"]);
    expect(d.preamble).toContain("@mock-me");
    expect(d.preamble).not.toContain("@design-stub");
  });

  it("uses a custom preamble verbatim when given", () => {
    const d = resolveDesigner({ branch: "design", preamble: "my rules" });
    expect(d.preamble).toBe("my rules");
  });
});

describe("evaluateGate", () => {
  const cfg = gateConfig(
    resolveDesigner({
      branch: "design",
      allowWrites: ["^src/components/", "\\.module\\.css$"],
      denyWrites: ["^src/api/", "^src/components/secret/"],
      mcpAllow: ["linear", "notion"],
    }),
  );
  const cwd = "/repo";

  it("denies Bash and NotebookEdit outright", () => {
    expect(evaluateGate({ tool_name: "Bash", tool_input: { command: "ls" }, cwd }, cfg)).toMatch(/shell/i);
    expect(evaluateGate({ tool_name: "NotebookEdit", tool_input: {}, cwd }, cfg)).toMatch(/notebook/i);
  });

  it("allows reads, search and non-write tools", () => {
    expect(evaluateGate({ tool_name: "Read", tool_input: { file_path: "/repo/src/api/x.ts" }, cwd }, cfg)).toBeNull();
    expect(evaluateGate({ tool_name: "Grep", tool_input: {}, cwd }, cfg)).toBeNull();
    expect(evaluateGate({ tool_name: "WebSearch", tool_input: {}, cwd }, cfg)).toBeNull();
  });

  it("fails closed on MCP tools not in the allow-list, case-insensitively", () => {
    expect(evaluateGate({ tool_name: "mcp__supabase__execute_sql", tool_input: {}, cwd }, cfg)).toMatch(/disabled/i);
    expect(evaluateGate({ tool_name: "mcp__unknown__thing", tool_input: {}, cwd }, cfg)).toMatch(/disabled/i);
    expect(evaluateGate({ tool_name: "mcp__linear__save_issue", tool_input: {}, cwd }, cfg)).toBeNull();
    expect(evaluateGate({ tool_name: "mcp__Notion__search", tool_input: {}, cwd }, cfg)).toBeNull();
  });

  it("allows writes inside allowWrites and denies outside", () => {
    expect(
      evaluateGate({ tool_name: "Write", tool_input: { file_path: "/repo/src/components/A.tsx" }, cwd }, cfg),
    ).toBeNull();
    expect(
      evaluateGate({ tool_name: "Edit", tool_input: { file_path: "/repo/src/hooks/useX.ts" }, cwd }, cfg),
    ).toMatch(/outside/i);
  });

  it("denyWrites wins over allowWrites and mentions the stub tag", () => {
    const reason = evaluateGate(
      { tool_name: "Write", tool_input: { file_path: "/repo/src/components/secret/S.tsx" }, cwd },
      cfg,
    );
    expect(reason).toMatch(/@design-stub/);
  });

  it("matches paths case-insensitively (macOS/APFS)", () => {
    expect(
      evaluateGate({ tool_name: "Write", tool_input: { file_path: "/repo/Src/Api/x.ts" }, cwd }, cfg),
    ).toMatch(/@design-stub/);
  });

  it("denies writes outside the project and writes with no resolvable target", () => {
    expect(
      evaluateGate({ tool_name: "Write", tool_input: { file_path: "/elsewhere/x.ts" }, cwd }, cfg),
    ).toMatch(/outside the project/i);
    expect(evaluateGate({ tool_name: "Write", tool_input: {}, cwd }, cfg)).toMatch(/safety/i);
  });
});

describe("gateDecision (the gate CLI's whole contract)", () => {
  const cfgB64 = (over: Partial<ReturnType<typeof gateConfig>> = {}) =>
    Buffer.from(
      JSON.stringify({
        ...gateConfig(resolveDesigner({ branch: "design", allowWrites: ["^src/"] })),
        ...over,
      }),
    ).toString("base64");

  it("prints nothing to allow", () => {
    const out = gateDecision(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/r/x.ts" }, cwd: "/r" }),
      cfgB64(),
    );
    expect(out).toBe("");
  });

  it("prints a PreToolUse deny decision to block", () => {
    const out = gateDecision(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf" }, cwd: "/r" }),
      cfgB64(),
    );
    const decision = JSON.parse(out).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/shell/i);
  });

  it("fails closed when the tool input or the config cannot be parsed", () => {
    expect(JSON.parse(gateDecision("not json", cfgB64())).hookSpecificOutput.permissionDecision).toBe("deny");
    const out = gateDecision(JSON.stringify({ tool_name: "Read", tool_input: {} }), "%%%not-base64-json%%%");
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("designerMcpConfig", () => {
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("filters .mcp.json to the allowed servers only", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-mcp-"));
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          linear: { url: "https://linear.example" },
          supabase: { command: "npx", args: ["supabase-mcp"] },
        },
      }),
    );
    expect(designerMcpConfig(dir, ["linear"])).toEqual({
      mcpServers: { linear: { url: "https://linear.example" } },
    });
  });

  it("fails closed to no servers when .mcp.json is missing or invalid", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-mcp-"));
    expect(designerMcpConfig(dir, ["linear"])).toEqual({ mcpServers: {} });
    fs.writeFileSync(path.join(dir, ".mcp.json"), "not json");
    expect(designerMcpConfig(dir, ["linear"])).toEqual({ mcpServers: {} });
  });
});

describe("designerCliArgs", () => {
  it("wires the gate hook, strict filtered MCP, and disables Task fan-out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cli-"));
    try {
      const designer = resolveDesigner({ branch: "design", mcpAllow: ["linear"] });
      const args = designerCliArgs({ root: dir, designer, gatePath: "/pkg/dist/gate.js" });

      const settingsIdx = args.indexOf("--settings");
      expect(settingsIdx).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(args[settingsIdx + 1]);
      const hook = settings.hooks.PreToolUse[0];
      expect(hook.matcher).toBe(".*");
      const command: string = hook.hooks[0].command;
      expect(command).toContain('"/pkg/dist/gate.js"');
      // The gate's config rides along as a base64 argv so the hook is self-contained.
      const b64 = command.split(" ").pop()!;
      const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      expect(decoded.stubTag).toBe("@design-stub");
      expect(decoded.mcpAllow).toEqual(["linear"]);

      const mcpIdx = args.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(args[mcpIdx + 1])).toEqual({ mcpServers: {} });
      expect(args).toContain("--strict-mcp-config");
      const dt = args.indexOf("--disallowedTools");
      expect(args[dt + 1]).toBe("Task");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
