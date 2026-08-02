import { resolveDesigner, type DesignerOptions, type ResolvedDesignerOptions } from "./designer";

/** A named quality-gate command, e.g. { label: "lint", command: ["npm", "run", "lint"] }. */
export type CheckSpec = { label: string; command: string[] };

export type PanelPosition = "bottom-right" | "top-right" | "bottom-left" | "top-left";

export interface PanelOptions {
  /** Text on the floating launch button. */
  buttonLabel?: string;
  /** Accent colour for primary actions (any CSS colour value). */
  accent?: string;
  /** Corner for the floating launch button. */
  position?: PanelPosition;
  /** Selector for the app's root element — the panel docks by shrinking it. */
  appRootSelector?: string;
}

export interface StudioOptions {
  /**
   * Branches the Studio refuses to run or commit on. Exact names, or a `*`
   * suffix as a prefix wildcard (e.g. "release-*"). A detached HEAD and a git
   * error are always treated as protected.
   */
  protectedBranches?: string[];
  /** Quality gate run by "Check" and re-run server-side before any commit. */
  checks?: CheckSpec[];
  /** Extra project context appended to every prompt (house rules, conventions). */
  systemPrompt?: string;
  panel?: PanelOptions;
  /**
   * Enables the gated Designer permission profile (branch pinning, write gate,
   * MCP allow-list, stub-tag convention). Absent = developer-only Studio.
   */
  designer?: DesignerOptions;
}

export interface ResolvedStudioOptions {
  protectedBranches: string[];
  checks: CheckSpec[];
  systemPrompt: string;
  panel: Required<PanelOptions>;
  designer: ResolvedDesignerOptions | null;
}

export const DEFAULT_CHECKS: CheckSpec[] = [
  { label: "lint", command: ["npm", "run", "lint"] },
  { label: "build", command: ["npx", "vite", "build"] },
];

export const DEFAULT_PANEL: Required<PanelOptions> = {
  buttonLabel: "◳ Studio",
  accent: "#3b6fe0",
  position: "bottom-right",
  appRootSelector: "#root",
};

export function resolveOptions(options: StudioOptions = {}): ResolvedStudioOptions {
  return {
    protectedBranches: options.protectedBranches ?? ["main", "release-*"],
    checks: options.checks && options.checks.length > 0 ? options.checks : DEFAULT_CHECKS,
    systemPrompt: options.systemPrompt?.trim() ?? "",
    panel: { ...DEFAULT_PANEL, ...(options.panel ?? {}) },
    designer: options.designer ? resolveDesigner(options.designer) : null,
  };
}

/**
 * `null` = git error; "HEAD" = detached HEAD (`rev-parse --abbrev-ref` returns
 * the literal "HEAD") — never run/commit there. Otherwise match the patterns:
 * a trailing `*` is a prefix wildcard, anything else is an exact name.
 */
export function isProtectedBranch(branch: string | null, patterns: string[]): boolean {
  if (branch === null || branch === "HEAD") return true;
  return patterns.some((p) =>
    p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p,
  );
}

/** The subset of config the browser panel needs, served by GET /__studio/config. */
export function panelConfigPayload(resolved: ResolvedStudioOptions): {
  panel: Required<PanelOptions>;
  checkLabels: string[];
  designer: { branch: string; stubTag: string } | null;
} {
  return {
    panel: resolved.panel,
    checkLabels: resolved.checks.map((c) => c.label),
    designer: resolved.designer
      ? { branch: resolved.designer.branch, stubTag: resolved.designer.stubTag }
      : null,
  };
}
