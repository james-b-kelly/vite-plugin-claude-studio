import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKS,
  DEFAULT_PANEL,
  isProtectedBranch,
  panelConfigPayload,
  resolveOptions,
} from "./config";

describe("resolveOptions", () => {
  it("applies defaults when called with nothing", () => {
    const r = resolveOptions();
    expect(r.protectedBranches).toEqual(["main", "release-*"]);
    expect(r.checks).toEqual(DEFAULT_CHECKS);
    expect(r.systemPrompt).toBe("");
    expect(r.panel).toEqual(DEFAULT_PANEL);
  });

  it("merges partial panel options over panel defaults", () => {
    const r = resolveOptions({ panel: { accent: "#ff0000" } });
    expect(r.panel.accent).toBe("#ff0000");
    expect(r.panel.buttonLabel).toBe(DEFAULT_PANEL.buttonLabel);
    expect(r.panel.position).toBe("bottom-right");
    expect(r.panel.appRootSelector).toBe("#root");
  });

  it("round-trips bottom-left through resolveOptions", () => {
    const r = resolveOptions({ panel: { position: "bottom-left" } });
    expect(r.panel.position).toBe("bottom-left");
    expect(r.panel.buttonLabel).toBe(DEFAULT_PANEL.buttonLabel);
    expect(r.panel.accent).toBe(DEFAULT_PANEL.accent);
  });

  it("keeps user checks and trims the system prompt", () => {
    const checks = [{ label: "typecheck", command: ["npx", "tsc", "--noEmit"] }];
    const r = resolveOptions({ checks, systemPrompt: "  house rules  " });
    expect(r.checks).toEqual(checks);
    expect(r.systemPrompt).toBe("house rules");
  });

  it("falls back to default checks when given an empty checks array", () => {
    expect(resolveOptions({ checks: [] }).checks).toEqual(DEFAULT_CHECKS);
  });
});

describe("isProtectedBranch", () => {
  const patterns = ["main", "release-*"];
  it("always protects null (git error) and detached HEAD", () => {
    expect(isProtectedBranch(null, [])).toBe(true);
    expect(isProtectedBranch("HEAD", [])).toBe(true);
  });
  it("matches exact names", () => {
    expect(isProtectedBranch("main", patterns)).toBe(true);
    expect(isProtectedBranch("develop", patterns)).toBe(false);
  });
  it("matches * suffix as a prefix wildcard", () => {
    expect(isProtectedBranch("release-1.2", patterns)).toBe(true);
    expect(isProtectedBranch("released-feature", patterns)).toBe(false);
    expect(isProtectedBranch("release-", patterns)).toBe(true);
  });
});

describe("panelConfigPayload", () => {
  it("exposes panel options and check labels only", () => {
    const payload = panelConfigPayload(
      resolveOptions({ checks: [{ label: "lint", command: ["npm", "run", "lint"] }] }),
    );
    expect(payload).toEqual({ panel: DEFAULT_PANEL, checkLabels: ["lint"] });
  });
});
