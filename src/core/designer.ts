import fs from "node:fs";
import path from "node:path";

/**
 * Designer mode — an optional, gated permission profile for the Studio.
 *
 * Developer mode (the default, and the only mode when `designer` is not
 * configured) runs Claude ungated with full tool access. Designer mode is the
 * restricted front-end-only subset for a non-developer teammate:
 *   - work is pinned to a dedicated design branch, kept in sync with a base
 *     branch (see `syncDesignerBranch` in git.ts),
 *   - a PreToolUse hook (dist/gate.js, config passed as base64 argv) hard-denies
 *     shell, notebook edits, non-allow-listed MCP servers, and writes outside
 *     the configured front-end area,
 *   - only allow-listed MCP servers from the repo's .mcp.json are even LOADED
 *     (an MCP server connects and runs auth at CLI startup, before any hook can
 *     fire — filtering the config is the only way to keep it out),
 *   - a preamble teaches the mock-data + stub-tag convention so missing
 *     data/logic is faked locally and flagged for a developer to wire up.
 */

export interface DesignerOptions {
  /** The dedicated branch designer work is pinned to (e.g. "develop-design"). */
  branch: string;
  /** Branch the design branch is created from and kept in sync with. */
  baseBranch?: string;
  /**
   * Regex sources (matched against the repo-relative path, case-insensitively)
   * for the front-end editable area. Defaults to everything not denied — scope
   * this down to make Designer mode meaningfully safe.
   */
  allowWrites?: string[];
  /** Regex sources for hard-denied paths. Takes precedence over allowWrites. */
  denyWrites?: string[];
  /** MCP server names (from the repo's .mcp.json) a designer run may load/use. */
  mcpAllow?: string[];
  /** Comment tag marking mocked data/logic for developer handoff. */
  stubTag?: string;
  /** Replaces the default designer preamble entirely when given. */
  preamble?: string;
}

export interface ResolvedDesignerOptions {
  branch: string;
  baseBranch: string;
  allowWrites: string[];
  denyWrites: string[];
  mcpAllow: string[];
  stubTag: string;
  preamble: string;
}

/** Generic config/infra paths no designer should edit, whatever the project. */
export const DEFAULT_DENY_WRITES: string[] = [
  "^\\.env",
  "^package(-lock)?\\.json$",
  "^(yarn|pnpm)-lock\\.(yaml|lock)$",
  "^tsconfig[^/]*\\.json$",
  "\\.config\\.(js|ts|cjs|mjs)$",
  "^node_modules/",
];

function defaultPreamble(stubTag: string): string {
  return (
    "You are in DESIGNER MODE — a fast, focused assistant editing this app's front-end live.\n\n" +
    "HOW TO WORK:\n" +
    "- Most requests are small, targeted UI tweaks (colour, spacing, text, layout). Make the " +
    "smallest change that satisfies the request, then stop. Don't over-investigate.\n" +
    "- Shell/Bash is DISABLED and you don't need it. To find code, use the Read, Grep, and Glob " +
    "tools directly — they work normally (Grep searches file contents; Glob finds files by name). " +
    "Never guess file paths blindly; Grep/Glob will locate things.\n" +
    "- Do the work YOURSELF in this session. Do NOT spawn subagents to search or edit — that tool " +
    "is disabled here, and it only wastes time and tokens for changes this size.\n\n" +
    "SCOPE:\n" +
    "- Only edit front-end presentational code (feature components/pages, shared components, CSS " +
    "modules). Do NOT edit the data/backend layer, logic, hooks, config, or design tokens — " +
    "a path gate hard-blocks those writes. If the design needs data or behaviour that doesn't exist " +
    "yet, build it with LOCAL state + realistic MOCK data and mark each spot with a " +
    `"// ${stubTag}: <what real data/logic is needed>" comment so a developer can wire it up.\n\n`
  );
}

export function resolveDesigner(options: DesignerOptions): ResolvedDesignerOptions {
  if (!options || typeof options.branch !== "string" || !options.branch.trim()) {
    throw new Error("claudeStudio: designer.branch is required when designer mode is configured.");
  }
  const stubTag = options.stubTag?.trim() || "@design-stub";
  return {
    branch: options.branch.trim(),
    baseBranch: options.baseBranch?.trim() || "main",
    allowWrites: options.allowWrites && options.allowWrites.length > 0 ? options.allowWrites : [".*"],
    denyWrites: options.denyWrites ?? DEFAULT_DENY_WRITES,
    mcpAllow: options.mcpAllow ?? [],
    stubTag,
    preamble: options.preamble ?? defaultPreamble(stubTag),
  };
}

// ── gate evaluation ──────────────────────────────────────────────────────────

/** The self-contained config the gate hook needs (rides along as base64 argv). */
export type GateConfig = {
  allowWrites: string[];
  denyWrites: string[];
  mcpAllow: string[];
  stubTag: string;
};

export function gateConfig(designer: ResolvedDesignerOptions): GateConfig {
  return {
    allowWrites: designer.allowWrites,
    denyWrites: designer.denyWrites,
    mcpAllow: designer.mcpAllow,
    stubTag: designer.stubTag,
  };
}

export type GateInput = {
  tool_name?: unknown;
  tool_input?: Record<string, unknown> | null;
  cwd?: unknown;
};

// Case-insensitive: macOS/APFS treats "Src/Api/x" and "src/api/x" as the same
// file, so the gate must too — otherwise a case-mangled path could dodge a DENY
// rule. (Done per-regex so mixed-case pattern literals still match.)
function matchesAny(sources: string[], s: string): boolean {
  return sources.some((src) => new RegExp(src, "i").test(s));
}

/**
 * Decide a PreToolUse call in Designer mode: returns the deny reason, or null
 * to allow (deferring to the run's normal acceptEdits flow). Reads are never
 * gated — Claude must be able to study real patterns anywhere in the repo.
 */
export function evaluateGate(input: GateInput, cfg: GateConfig): string | null {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  if (tool === "Bash") {
    return "Designer mode: shell commands are disabled. Edit front-end files directly, or ask to switch to Developer mode.";
  }
  if (tool === "NotebookEdit") {
    return "Designer mode: notebook edits are disabled. Edit front-end files directly, or ask to switch to Developer mode.";
  }

  // MCP allow-list (fail-closed): any server not explicitly allowed is denied.
  // This must run BEFORE the read/search fall-through below, or MCP tools would
  // slip through as "not a write tool" and reach the app's data/backend layer.
  if (typeof tool === "string" && tool.startsWith("mcp__")) {
    const allowed = cfg.mcpAllow.some((name) => new RegExp(`^mcp__${name}`, "i").test(tool));
    if (!allowed) {
      return (
        "Designer mode: that integration is disabled here (only project tooling is allowed). " +
        `Reading the codebase is fine. Use mock data + a "// ${cfg.stubTag}" comment, or switch to Developer mode.`
      );
    }
    return null;
  }

  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") {
    return null; // reads / search / web / allowed tooling are fine
  }

  const fp = (ti as Record<string, unknown>).file_path;
  if (typeof fp !== "string" || !fp) {
    // Fail CLOSED: a write tool with no resolvable target is not provably safe.
    return "Designer mode: could not determine the write target — blocking for safety.";
  }

  const rel = path.relative(cwd, path.resolve(cwd, fp)).split(path.sep).join("/");
  if (rel === ".." || rel.startsWith("../")) {
    return `Designer mode: writing outside the project ("${rel}") is not allowed.`;
  }
  if (matchesAny(cfg.denyWrites, rel)) {
    return (
      `Designer mode: "${rel}" is backend/data/config — not editable here. Use local mock data + a ` +
      `"// ${cfg.stubTag}: <what real data is needed>" comment so a developer can wire it up.`
    );
  }
  if (matchesAny(cfg.allowWrites, rel)) {
    return null;
  }
  return `Designer mode: "${rel}" is outside the front-end editable area. Switch to Developer mode for anything else.`;
}

/**
 * The gate CLI's whole contract: raw stdin (the tool-call JSON) + the base64
 * config argv in, the string to print out — a PreToolUse deny decision to
 * block, or "" to allow (exit 0 with no output defers to acceptEdits). Any
 * unparsable input fails CLOSED: if we can't read the call, we can't prove
 * it's safe.
 */
export function gateDecision(rawInput: string, cfgB64: string): string {
  const deny = (reason: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  let cfg: GateConfig;
  try {
    cfg = JSON.parse(Buffer.from(cfgB64, "base64").toString("utf8"));
    if (!Array.isArray(cfg.allowWrites) || !Array.isArray(cfg.denyWrites)) throw new Error("bad config");
  } catch {
    return deny("Designer mode: the gate could not read its configuration — blocking for safety.");
  }
  let input: GateInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return deny("Designer mode: the gate could not parse the tool input — blocking the call for safety.");
  }
  const reason = evaluateGate(input, cfg);
  return reason === null ? "" : deny(reason);
}

// ── CLI wiring ───────────────────────────────────────────────────────────────

/**
 * Allow-listed MCP servers only, read from the repo's .mcp.json. Missing or
 * invalid file → no MCP at all (fail-closed). Paired with --strict-mcp-config
 * on the spawn so the repo config can't add servers back.
 */
export function designerMcpConfig(root: string, mcpAllow: string[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  try {
    const all = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"))?.mcpServers ?? {};
    for (const [name, cfg] of Object.entries(all)) {
      if (mcpAllow.includes(name)) mcpServers[name] = cfg;
    }
  } catch {
    /* no/invalid .mcp.json → no MCP in Designer mode */
  }
  return { mcpServers };
}

/**
 * Extra `claude` CLI args for a Designer-mode run: the PreToolUse gate hook via
 * a per-run settings override (never touches the repo's .claude/settings.json),
 * the filtered strict MCP config, and no Task fan-out (subagents inherit the
 * Bash-deny gate and just flail; designer tweaks don't need them).
 */
export function designerCliArgs(args: {
  root: string;
  designer: ResolvedDesignerOptions;
  gatePath: string;
}): string[] {
  const { root, designer, gatePath } = args;
  const cfgB64 = Buffer.from(JSON.stringify(gateConfig(designer)), "utf8").toString("base64");
  const settings = {
    hooks: {
      PreToolUse: [
        {
          // Match every tool so no write-capable tool (NotebookEdit, future
          // additions, MCP writers) can slip past unexamined — the gate itself
          // decides allow/deny by tool name and allows reads/search.
          matcher: ".*",
          hooks: [{ type: "command", command: `node ${JSON.stringify(gatePath)} ${cfgB64}` }],
        },
      ],
    },
  };
  return [
    "--settings",
    JSON.stringify(settings),
    "--mcp-config",
    JSON.stringify(designerMcpConfig(root, designer.mcpAllow)),
    "--strict-mcp-config",
    "--disallowedTools",
    "Task",
  ];
}
