# vite-plugin-claude-studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the in-repo Studio source (a dev-only Vite middleware + React panel that drives local Claude Code against the running app) into an installable npm package with a configurable Vite plugin entry (`vite-plugin-claude-studio`) and a browser panel entry (`vite-plugin-claude-studio/panel`).

**Architecture:** Single package, two build outputs. `src/core/` holds bundler-agnostic Node logic (config resolution, git operations, check runner, Claude CLI spawning/streaming, HTTP helpers). `src/vite/` is a thin Vite adapter registering `/__studio/*` dev-server middleware plus the production-exclusion stub and bundle assertion. `src/panel/` is the React panel, which fetches its runtime configuration from a `GET /__studio/config` endpoint so consumers configure everything in `vite.config.ts`.

**Tech Stack:** TypeScript (strict), Vite lib mode (two configs: node + browser), Vitest + Testing Library (jsdom), React 18+ as peer dependency, zero runtime dependencies.

## Global Constraints

- **Standalone project:** no file, comment, commit message, or doc may reference any other application, company project, or issue-tracker ticket. Write everything as original to this repo.
- **Dev-only guarantee:** the four production-exclusion layers (serve-only middleware, consumer DEV gate, build-time panel stub, `generateBundle` marker assertion) must all survive this restructure intact.
- **Zero runtime dependencies.** Peer deps: `react >=18`, `react-dom >=18`, `vite >=5`. Node `>=20.19`.
- **TDD:** every new module lands with its test written first. The full suite (`npx vitest run`) and `npx tsc --noEmit` must be green at every commit.
- **Prerequisite:** the repo already contains the initial source drop — `src/vite/dev-plugin.ts` (the monolithic dev plugin) and `src/panel/` (StudioPanel.tsx/.module.css/.test.tsx, useStudioRun.ts, captureContext.ts, ElementPicker.tsx, fiberSource.ts + .test.ts, Markdown.tsx/.module.css, mount.tsx). Tasks below restructure that source; do not re-create it from scratch.
- Commit messages: conventional commits (`feat:`, `chore:`, `test:`, `docs:`), no scope required.
- `npm run prepare` is added only in Task 9 (it would break `npm install` before the build pipeline exists).

---

### Task 1: Package scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `test/setup.ts`

**Interfaces:**
- Consumes: the seeded source at `src/vite/dev-plugin.ts` and `src/panel/*` (must typecheck and its two seeded test files must pass under this scaffolding).
- Produces: `npm install`, `npx vitest run`, `npx tsc --noEmit` all working — every later task relies on these three commands.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "vite-plugin-claude-studio",
  "version": "0.1.0",
  "description": "Dev-only in-app Studio for Vite + React: chat with your local Claude Code from inside the running app, then review, check, revert, or commit the change.",
  "type": "module",
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/james-b-kelly/vite-plugin-claude-studio.git"
  },
  "engines": {
    "node": ">=20.19"
  },
  "files": [
    "dist"
  ],
  "main": "./dist/vite.js",
  "types": "./dist/types/vite/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/types/vite/index.d.ts",
      "import": "./dist/vite.js"
    },
    "./vite": {
      "types": "./dist/types/vite/index.d.ts",
      "import": "./dist/vite.js"
    },
    "./panel": {
      "types": "./dist/types/panel/index.d.ts",
      "import": "./dist/panel.js"
    }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "react": ">=18",
    "react-dom": ">=18",
    "vite": ">=5"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@types/node": "^24.12.3",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "jsdom": "^29.1.1",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "typescript": "~6.0.2",
    "vite": "^8.0.12",
    "vite-plugin-css-injected-by-js": "^3.5.2",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `test/setup.ts`**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] },
});
```

`test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Install and verify the seeded source is green under the scaffolding**

Run: `npm install`
Expected: completes without errors (no `prepare` script yet, so no build is attempted).

Run: `npx vitest run`
Expected: PASS — 2 test files (`src/panel/StudioPanel.test.tsx`, `src/panel/fiberSource.test.ts`), all tests green.

Run: `npx tsc --noEmit`
Expected: no output (clean). If the seeded source trips `noUnusedLocals`/`noUnusedParameters`, fix by removing the unused symbol (do not loosen the compiler options).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts test/setup.ts
git commit -m "chore: package scaffolding (typescript, vitest, package.json exports)"
```

---

### Task 2: `src/core/config.ts` — options, defaults, branch protection

**Files:**
- Create: `src/core/config.ts`
- Test: `src/core/config.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by Tasks 5, 7, 8):
  - `type CheckSpec = { label: string; command: string[] }`
  - `type PanelPosition = "bottom-right" | "top-right"`
  - `interface PanelOptions { buttonLabel?: string; accent?: string; position?: PanelPosition; appRootSelector?: string }`
  - `interface StudioOptions { protectedBranches?: string[]; checks?: CheckSpec[]; systemPrompt?: string; panel?: PanelOptions }`
  - `interface ResolvedStudioOptions { protectedBranches: string[]; checks: CheckSpec[]; systemPrompt: string; panel: Required<PanelOptions> }`
  - `const DEFAULT_CHECKS: CheckSpec[]`, `const DEFAULT_PANEL: Required<PanelOptions>`
  - `function resolveOptions(options?: StudioOptions): ResolvedStudioOptions`
  - `function isProtectedBranch(branch: string | null, patterns: string[]): boolean`
  - `function panelConfigPayload(resolved: ResolvedStudioOptions): { panel: Required<PanelOptions>; checkLabels: string[] }`

- [ ] **Step 1: Write the failing test**

`src/core/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Write the implementation**

`src/core/config.ts`:

```ts
/** A named quality-gate command, e.g. { label: "lint", command: ["npm", "run", "lint"] }. */
export type CheckSpec = { label: string; command: string[] };

export type PanelPosition = "bottom-right" | "top-right";

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
}

export interface ResolvedStudioOptions {
  protectedBranches: string[];
  checks: CheckSpec[];
  systemPrompt: string;
  panel: Required<PanelOptions>;
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
} {
  return { panel: resolved.panel, checkLabels: resolved.checks.map((c) => c.label) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/config.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts
git commit -m "feat: studio options — defaults, branch protection, panel config payload"
```

---

### Task 3: `src/core/http.ts` — HTTP helpers (moved from the dev plugin)

**Files:**
- Create: `src/core/http.ts`
- Test: `src/core/http.test.ts`
- (Leave `src/vite/dev-plugin.ts` untouched — it keeps its own copies until Task 7 deletes it.)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6, 7):
  - `class HttpError extends Error { status: number; constructor(status: number, message: string) }`
  - `function sendJson(res: ServerResponse, status: number, body: unknown): void`
  - `function writeFrame(res: ServerResponse, frame: unknown): void`
  - `function readBody(req: IncomingMessage): Promise<string>` (throws `HttpError(413)` over 1 MiB)
  - `function isLocalSameOriginRequest(req: IncomingMessage): boolean`

- [ ] **Step 1: Write the failing test**

`src/core/http.test.ts`:

```ts
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpError, isLocalSameOriginRequest } from "./http";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isLocalSameOriginRequest", () => {
  it("allows plain localhost requests", () => {
    expect(isLocalSameOriginRequest(req({ host: "localhost:5173" }))).toBe(true);
    expect(isLocalSameOriginRequest(req({ host: "127.0.0.1:5173" }))).toBe(true);
    expect(isLocalSameOriginRequest(req({ host: "[::1]:5173" }))).toBe(true);
  });
  it("blocks LAN hosts (vite --host exposure)", () => {
    expect(isLocalSameOriginRequest(req({ host: "192.168.1.20:5173" }))).toBe(false);
  });
  it("blocks cross-origin by Origin header", () => {
    expect(
      isLocalSameOriginRequest(req({ host: "localhost:5173", origin: "http://evil.example" })),
    ).toBe(false);
    expect(
      isLocalSameOriginRequest(req({ host: "localhost:5173", origin: "http://localhost:5173" })),
    ).toBe(true);
  });
  it("blocks cross-site fetch metadata", () => {
    expect(
      isLocalSameOriginRequest(
        req({ host: "localhost:5173", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    expect(
      isLocalSameOriginRequest(
        req({ host: "localhost:5173", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
  });
});

describe("HttpError", () => {
  it("carries a status code", () => {
    const e = new HttpError(413, "too big");
    expect(e.status).toBe(413);
    expect(e.message).toBe("too big");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/http.test.ts`
Expected: FAIL — cannot resolve `./http`.

- [ ] **Step 3: Create the module by moving code from `src/vite/dev-plugin.ts`**

Create `src/core/http.ts` containing, **verbatim from `src/vite/dev-plugin.ts`** (copy the full bodies including their comments; do not rewrite them):

- the `MAX_BODY_BYTES` constant
- the `HttpError` class (add `export`)
- the `LOCAL_HOSTS` constant and `hostnameOf` function (not exported)
- `isLocalSameOriginRequest` (add `export`)
- `writeFrame` (add `export`)
- `sendJson` (add `export`)
- `readBody` (add `export`)

The module's only imports:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/http.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/http.ts src/core/http.test.ts
git commit -m "feat: http helpers — local same-origin guard, ndjson frames, body reader"
```

---

### Task 4: `src/core/git.ts` — git operations (moved from the dev plugin)

**Files:**
- Create: `src/core/git.ts`
- Test: `src/core/git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6, 7):
  - `type ChangedStatus = "new" | "modified" | "deleted"`
  - `type ChangedFile = { path: string; status: ChangedStatus; orig?: string }`
  - `function currentBranch(root: string): string | null`
  - `function isDirty(root: string): boolean`
  - `function refExists(root: string, ref: string): boolean`
  - `function aheadBehind(root: string, branch: string | null): { behind: number; ahead: number } | null`
  - `function listChanges(root: string): ChangedFile[]`
  - `function fullDiff(root: string): Promise<string>`
  - `function doRevert(root: string, requested: string[]): { restored: string[]; deleted: string[]; skipped: string[] }`
  - `function gitErr(e: unknown): string`

- [ ] **Step 1: Write the failing test**

`src/core/git.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentBranch, doRevert, isDirty, listChanges } from "./git";

let dir = "";

function initRepo(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("currentBranch / isDirty", () => {
  it("reads the branch and dirtiness of a repo", () => {
    const root = initRepo();
    expect(currentBranch(root)).toBe("main");
    expect(isDirty(root)).toBe(false);
    fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
    expect(isDirty(root)).toBe(true);
  });
});

describe("listChanges", () => {
  it("reports new, modified and deleted files", () => {
    const root = initRepo();
    fs.writeFileSync(path.join(root, "b.txt"), "new\n");
    fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
    const changes = listChanges(root);
    expect(changes).toContainEqual({ path: "b.txt", status: "new" });
    expect(changes).toContainEqual({ path: "a.txt", status: "modified" });

    fs.rmSync(path.join(root, "a.txt"));
    expect(listChanges(root)).toContainEqual({ path: "a.txt", status: "deleted" });
  });
});

describe("doRevert", () => {
  it("restores tracked edits, deletes new files, skips paths outside the repo", () => {
    const root = initRepo();
    fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(root, "b.txt"), "new\n");
    const result = doRevert(root, ["a.txt", "b.txt", "../outside.txt"]);
    expect(result.restored).toEqual(["a.txt"]);
    expect(result.deleted).toEqual(["b.txt"]);
    expect(result.skipped).toEqual(["../outside.txt"]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/git.test.ts`
Expected: FAIL — cannot resolve `./git`.

- [ ] **Step 3: Create the module by moving code from `src/vite/dev-plugin.ts`**

Create `src/core/git.ts` containing, **verbatim from `src/vite/dev-plugin.ts`** (full bodies and comments), all with `export` added:

- the `ChangedStatus` and `ChangedFile` types
- `gitErr`
- `currentBranch`
- `isDirty`
- `refExists`
- `aheadBehind`
- `listChanges`
- `fullDiff`
- `doRevert`

The module's only imports:

```ts
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
```

(Do NOT move `isProtected` — branch protection now lives in `src/core/config.ts` as `isProtectedBranch`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/git.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.ts src/core/git.test.ts
git commit -m "feat: git ops — status, diff, revert, branch/ahead-behind helpers"
```

---

### Task 5: `src/core/checks.ts` — configurable check runner

**Files:**
- Create: `src/core/checks.ts`
- Test: `src/core/checks.test.ts`

**Interfaces:**
- Consumes: `CheckSpec` from `./config` (Task 2).
- Produces (used by Task 7):
  - `type CheckResult = { ok: boolean; output: string }`
  - `function runChecks(root: string, checks: CheckSpec[]): Promise<CheckResult>`

Behavioural contract (generalizes the old hardcoded lint+build runner): run every check **sequentially**, never short-circuit (so the report always covers all checks), label each line `<label>: PASS ✓` / `<label>: FAIL ✗`, append a capped output tail only for failures, cap the whole report at 6000 chars, 180 s timeout and 8 MiB buffer per check.

- [ ] **Step 1: Write the failing test**

`src/core/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runChecks } from "./checks";

const pass = { label: "alpha", command: ["node", "-e", "process.exit(0)"] };
const fail = { label: "beta", command: ["node", "-e", "console.error('boom'); process.exit(1)"] };

describe("runChecks", () => {
  it("passes when every check passes", async () => {
    const r = await runChecks(process.cwd(), [pass]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("alpha: PASS ✓");
  });

  it("fails when any check fails, still reporting the rest", async () => {
    const r = await runChecks(process.cwd(), [fail, pass]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("beta: FAIL ✗");
    expect(r.output).toContain("boom");
    expect(r.output).toContain("alpha: PASS ✓");
  });

  it("treats an empty command as a failure, not a crash", async () => {
    const r = await runChecks(process.cwd(), [{ label: "empty", command: [] }]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("empty: FAIL ✗");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/checks.test.ts`
Expected: FAIL — cannot resolve `./checks`.

- [ ] **Step 3: Write the implementation**

`src/core/checks.ts`:

```ts
import { execFile } from "node:child_process";
import type { CheckSpec } from "./config";

export type CheckResult = { ok: boolean; output: string };

const RUN_OPTS = { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 } as const;

const tail = (s: string) => s.split("\n").slice(0, 60).join("\n").trim();

function runOne(root: string, check: CheckSpec): Promise<{ ok: boolean; output: string }> {
  const [cmd, ...args] = check.command;
  if (!cmd) return Promise.resolve({ ok: false, output: "empty check command" });
  return new Promise((resolve) => {
    execFile(cmd, args, { ...RUN_OPTS, cwd: root }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Run the configured quality gate. Checks run sequentially and are ALL run
 * even after a failure, so the report always shows the full picture. Output
 * tails are included for failures only; the whole report is capped.
 */
export async function runChecks(root: string, checks: CheckSpec[]): Promise<CheckResult> {
  const parts: string[] = [];
  let ok = true;
  for (const check of checks) {
    const r = await runOne(root, check);
    parts.push(`${check.label}: ${r.ok ? "PASS ✓" : "FAIL ✗"}`);
    if (!r.ok) {
      ok = false;
      if (r.output.trim()) parts.push(tail(r.output));
    }
  }
  return { ok, output: parts.join("\n").slice(0, 6000) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/checks.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/checks.ts src/core/checks.test.ts
git commit -m "feat: configurable check runner (sequential, full report, capped output)"
```

---

### Task 6: `src/core/claude.ts` — prompt building + CLI spawn/stream

**Files:**
- Create: `src/core/claude.ts`
- Test: `src/core/claude.test.ts`

**Interfaces:**
- Consumes: `HttpError` from `./http` (Task 3); `listChanges` from `./git` (Task 4).
- Produces (used by Task 7):
  - `type PinInfo = { component?: string; file?: string; line?: number; tag?: string; id?: string; classes?: string; text?: string; cssPath?: string }`
  - `type GenerateRequest = { instruction: string; resumeSessionId?: string; route?: string; screen?: string; pin?: PinInfo }`
  - `function parseGenerateBody(raw: string): GenerateRequest` (throws `HttpError(400)` on bad input)
  - `function buildPrompt(request: GenerateRequest, systemPrompt: string): string`
  - `type GenerateSink = { writeRaw(line: string): void; writeFrame(frame: unknown): void; end(): void }`
  - `function isGenerationRunning(): boolean`
  - `function stopGeneration(): boolean` — kills the active run, returns whether one was running
  - `function killActiveGeneration(): void` — for dev-server shutdown
  - `function startGeneration(args: { root: string; branch: string; request: GenerateRequest; systemPrompt: string; sink: GenerateSink }): void`

- [ ] **Step 1: Write the failing test (pure parts only — spawning is exercised via the real dev server, not unit tests)**

`src/core/claude.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPrompt, parseGenerateBody } from "./claude";

describe("parseGenerateBody", () => {
  it("requires an instruction", () => {
    expect(() => parseGenerateBody("{}")).toThrowError(/instruction is required/);
    expect(() => parseGenerateBody("not json")).toThrowError(/Invalid JSON/);
  });
  it("validates resumeSessionId as a UUID", () => {
    expect(() =>
      parseGenerateBody(JSON.stringify({ instruction: "x", resumeSessionId: "nope" })),
    ).toThrowError(/UUID/);
    const ok = parseGenerateBody(
      JSON.stringify({
        instruction: "x",
        resumeSessionId: "12345678-1234-1234-1234-123456789abc",
      }),
    );
    expect(ok.resumeSessionId).toBe("12345678-1234-1234-1234-123456789abc");
  });
  it("sanitises pins and drops unusable ones", () => {
    const req = parseGenerateBody(
      JSON.stringify({ instruction: "x", pin: { tag: "button", text: 'say "hi"\nnow' } }),
    );
    expect(req.pin?.tag).toBe("button");
    expect(req.pin?.text).toBe("say  hi  now");
    expect(parseGenerateBody(JSON.stringify({ instruction: "x", pin: {} })).pin).toBeUndefined();
  });
});

describe("buildPrompt", () => {
  it("returns the bare instruction when there is no context", () => {
    expect(buildPrompt({ instruction: "do it" }, "")).toBe("do it");
  });
  it("prepends route/screen context when present", () => {
    const p = buildPrompt({ instruction: "do it", route: "/settings", screen: "Dialog: Rename" }, "");
    expect(p).toContain("Route: `/settings`");
    expect(p).toContain("Dialog: Rename");
    expect(p).toContain("Request: do it");
  });
  it("includes the configured system prompt, with and without other context", () => {
    expect(buildPrompt({ instruction: "do it" }, "use css modules")).toContain("use css modules");
    const p = buildPrompt({ instruction: "do it", route: "/x" }, "use css modules");
    expect(p).toContain("use css modules");
    expect(p).toContain("Request: do it");
  });
  it("leads with the pinned element when one is set", () => {
    const p = buildPrompt(
      { instruction: "make it red", pin: { component: "SaveButton", file: "src/Save.tsx", line: 12 } },
      "",
    );
    expect(p).toContain("<SaveButton> at `src/Save.tsx:12`");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/claude.test.ts`
Expected: FAIL — cannot resolve `./claude`.

- [ ] **Step 3: Create the module**

`src/core/claude.ts`. Move **verbatim from `src/vite/dev-plugin.ts`**: the `GENERATE_MODEL`, `MAX_INSTRUCTION`, and `SESSION_ID_RE` constants; the `PinInfo` type (add `export`); `parsePin`; `pinContext`; `claudeErrorMessage`. Then add the reshaped pieces below (`parseGenerateBody` and `buildPrompt` are the old functions re-signatured; `startGeneration` is the old `handleGenerate` body with the HTTP response abstracted into a sink):

```ts
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { HttpError } from "./http";
import { listChanges } from "./git";

// … moved constants + PinInfo + parsePin + pinContext + claudeErrorMessage here …

export type GenerateRequest = {
  instruction: string;
  resumeSessionId?: string;
  route?: string;
  screen?: string;
  pin?: PinInfo;
};

export function parseGenerateBody(raw: string): GenerateRequest {
  let obj: any;
  try {
    obj = JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const instruction = typeof obj.instruction === "string" ? obj.instruction.trim() : "";
  if (!instruction) throw new HttpError(400, "instruction is required");
  if (instruction.length > MAX_INSTRUCTION) throw new HttpError(400, "instruction too long");
  let resumeSessionId: string | undefined;
  if (obj.resumeSessionId != null) {
    if (typeof obj.resumeSessionId !== "string" || !SESSION_ID_RE.test(obj.resumeSessionId)) {
      throw new HttpError(400, "resumeSessionId must be a UUID");
    }
    resumeSessionId = obj.resumeSessionId;
  }
  // Current app route (where the user is looking), to anchor "this page" requests.
  const route = typeof obj.route === "string" ? obj.route.slice(0, 2000) : undefined;
  // A snapshot of the visible UI (open dialogs, headings) captured from the DOM.
  const screen = typeof obj.screen === "string" ? obj.screen.slice(0, 8000) : undefined;
  const pin = parsePin(obj.pin);
  return { instruction, resumeSessionId, route, screen, pin };
}

/** Prepend project notes + route/screen/pin context so Claude knows scope and target. */
export function buildPrompt(request: GenerateRequest, systemPrompt: string): string {
  const { instruction, route, screen, pin } = request;
  const ctx: string[] = [];
  if (pin) ctx.push(pinContext(pin));
  if (route) ctx.push(`Route: \`${route}\``);
  if (screen) ctx.push(`Visible UI right now (captured live from the DOM):\n${screen}`);
  const notes = systemPrompt
    ? `Project notes from the app's Studio configuration:\n${systemPrompt}\n\n`
    : "";
  if (ctx.length === 0) return notes ? `${notes}Request: ${instruction}` : instruction;
  return (
    notes +
    `Context — what the user is looking at in the running app:\n${ctx.join("\n\n")}\n\n` +
    `Use this to find the relevant component(s): match the visible text/dialog titles above ` +
    `against the source (the app's route configuration, feature pages/components, and ` +
    `shared modal/dialog components), then make the change there.\n\n` +
    `Request: ${instruction}`
  );
}

// ── run management ───────────────────────────────────────────────────────────

let activeRun: ChildProcess | null = null;

export function isGenerationRunning(): boolean {
  return activeRun !== null;
}

/** Explicit cancellation (POST /__studio/stop). Returns whether a run was live. */
export function stopGeneration(): boolean {
  const wasRunning = activeRun !== null;
  // Clear eagerly; the close handler's clearActive() is identity-guarded + idempotent.
  if (activeRun) {
    activeRun.kill("SIGTERM");
    activeRun = null;
  }
  return wasRunning;
}

/** Dev-server shutdown: don't orphan a child that keeps editing files. */
export function killActiveGeneration(): void {
  if (activeRun && !activeRun.killed) activeRun.kill("SIGTERM");
}

export type GenerateSink = {
  writeRaw(line: string): void;
  writeFrame(frame: unknown): void;
  end(): void;
};

export function startGeneration(args: {
  root: string;
  branch: string;
  request: GenerateRequest;
  systemPrompt: string;
  sink: GenerateSink;
}): void {
  const { root, branch, request, systemPrompt, sink } = args;

  // Prompt via stdin (not argv) so nothing can be option-smuggled.
  const cliArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--model",
    GENERATE_MODEL,
  ];
  if (request.resumeSessionId) cliArgs.push("--resume", request.resumeSessionId);

  const child = spawn("claude", cliArgs, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  activeRun = child;

  let sessionId: string | undefined;
  let stdoutBuf = "";
  let stderrBuf = "";
  const decoder = new StringDecoder("utf8");

  const clearActive = () => {
    if (activeRun === child) activeRun = null;
  };

  child.on("error", (err) => {
    sink.writeFrame({ type: "studio_error", message: claudeErrorMessage(err) });
    clearActive();
    sink.end();
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += decoder.write(chunk);
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
      } catch {
        /* forward raw anyway */
      }
      sink.writeRaw(line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
  });

  child.on("close", (code) => {
    try {
      const tailOut = stdoutBuf + decoder.end();
      if (tailOut.trim()) sink.writeRaw(tailOut.trim());
      const exitCode = code ?? 0;
      if (exitCode !== 0 && stderrBuf.trim()) {
        sink.writeFrame({ type: "studio_error", message: stderrBuf.trim().slice(0, 500) });
      }
      sink.writeFrame({ type: "studio_diff", branch, files: listChanges(root) });
      sink.writeFrame({ type: "studio_done", exitCode, sessionId });
    } finally {
      clearActive();
      sink.end();
    }
  });

  // NB: the child is deliberately NOT killed when the client disconnects. An
  // edit can trigger an HMR full-reload mid-run, which would otherwise abort
  // the run and leave a half-applied change. The run finishes on disk
  // regardless; the sink is a no-op once the response is closed. Explicit
  // cancellation goes through stopGeneration().

  child.stdin?.write(buildPrompt(request, systemPrompt));
  child.stdin?.end();
}
```

Note the one deliberate wording change vs the old `buildPrompt`: the hint about where to look now says "the app's route configuration" instead of naming a specific source directory, since consumers lay out routes differently.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/claude.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/claude.ts src/core/claude.test.ts
git commit -m "feat: claude runner — prompt building, request parsing, sink-based streaming"
```

---

### Task 7: `src/vite/index.ts` — the Vite adapter (replaces the monolith)

**Files:**
- Create: `src/vite/index.ts`
- Test: `src/vite/index.test.ts`
- Delete: `src/vite/dev-plugin.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2–6 (exact names as listed there).
- Produces (the package's main entry):
  - `export default function claudeStudio(options?: StudioOptions): Plugin`
  - `export type { CheckSpec, PanelOptions, StudioOptions }` (re-exported from core/config)
  - HTTP surface: `GET /__studio/status`, `GET /__studio/config` (new), `GET /__studio/diff`, `POST /__studio/generate|stop|check|revert|commit`

- [ ] **Step 1: Write the failing test**

`src/vite/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import claudeStudio from "./index";

type Handler = (req: any, res: any, next: () => void) => Promise<void> | void;

function makeServer() {
  const handlers: Handler[] = [];
  return {
    middlewares: { use: (fn: Handler) => handlers.push(fn) },
    httpServer: { once: () => {} },
    handlers,
  };
}

function makeRes() {
  return {
    statusCode: 0,
    body: "",
    writableEnded: false,
    setHeader() {},
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk?: string) {
      this.body += chunk ?? "";
      this.writableEnded = true;
    },
  };
}

async function dispatch(server: ReturnType<typeof makeServer>, req: any) {
  const res = makeRes();
  let nextCalled = false;
  for (const h of server.handlers) await h(req, res, () => (nextCalled = true));
  return { res, nextCalled };
}

function makePlugin(options = {}) {
  const plugin = claudeStudio(options) as any;
  plugin.configResolved({ root: process.cwd(), command: "serve" });
  const server = makeServer();
  plugin.configureServer(server);
  return { plugin, server };
}

describe("claudeStudio middleware", () => {
  it("passes non-studio URLs through", async () => {
    const { server } = makePlugin();
    const { nextCalled } = await dispatch(server, {
      url: "/app",
      method: "GET",
      headers: { host: "localhost:5173" },
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects non-local hosts with 403", async () => {
    const { server } = makePlugin();
    const { res } = await dispatch(server, {
      url: "/__studio/config",
      method: "GET",
      headers: { host: "192.168.1.20:5173" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves the panel config with defaults and custom check labels", async () => {
    const { server } = makePlugin({
      checks: [{ label: "typecheck", command: ["npx", "tsc", "--noEmit"] }],
      panel: { buttonLabel: "✦ Dev" },
    });
    const { res } = await dispatch(server, {
      url: "/__studio/config",
      method: "GET",
      headers: { host: "localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checkLabels).toEqual(["typecheck"]);
    expect(body.panel.buttonLabel).toBe("✦ Dev");
    expect(body.panel.appRootSelector).toBe("#root");
  });
});

describe("claudeStudio build hooks", () => {
  it("stubs the panel module in build mode", () => {
    const plugin = claudeStudio() as any;
    plugin.configResolved({ root: process.cwd(), command: "build" });
    const stub = plugin.load("/x/node_modules/vite-plugin-claude-studio/dist/panel.js");
    expect(stub).toContain("mountStudioPanel = () => {}");
    expect(plugin.load("/x/src/App.tsx")).toBeNull();
  });

  it("leaves the panel module alone in dev", () => {
    const plugin = claudeStudio() as any;
    plugin.configResolved({ root: process.cwd(), command: "serve" });
    expect(plugin.load("/x/node_modules/vite-plugin-claude-studio/dist/panel.js")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/vite/index.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write `src/vite/index.ts`**

This is the old `src/vite/dev-plugin.ts` reduced to routing + build hooks, delegating to core. The `route`, `handleGenerate`, and `handleCommit` structures are preserved; the diffs from the old file are: options parameter, `isProtectedBranch(branch, resolved.protectedBranches)` replacing `isProtected(branch)`, `runChecks(root, resolved.checks)` replacing `runCheck(root)`, the new `/__studio/config` endpoint, `startGeneration` with a sink replacing the inline spawn, and the panel-module stub regex.

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";
import {
  isProtectedBranch,
  panelConfigPayload,
  resolveOptions,
  type ResolvedStudioOptions,
  type StudioOptions,
} from "../core/config";
import {
  HttpError,
  isLocalSameOriginRequest,
  readBody,
  sendJson,
  writeFrame,
} from "../core/http";
import {
  aheadBehind,
  currentBranch,
  doRevert,
  fullDiff,
  gitErr,
  isDirty,
  listChanges,
  refExists,
} from "../core/git";
import { runChecks } from "../core/checks";
import {
  isGenerationRunning,
  killActiveGeneration,
  parseGenerateBody,
  startGeneration,
  stopGeneration,
} from "../core/claude";

export type { CheckSpec, PanelOptions, PanelPosition, StudioOptions } from "../core/config";

/**
 * In-App Studio — DEV-ONLY Vite middleware.
 *
 * Exposes endpoints that drive local Claude Code against THIS repo so a panel
 * inside the running app can edit the real application. The `configureServer`
 * hook is serve-only, so the spawn endpoint never exists in a production build.
 *
 * Developer-only: full tool access, ungated.
 */

// One review check at a time; one commit-and-push at a time (per dev server).
let checkRunning = false;
let committing = false;

export default function claudeStudio(options: StudioOptions = {}): Plugin {
  const resolved = resolveOptions(options);
  let root = process.cwd();
  let isBuild = false;
  return {
    name: "claude-studio",
    // NB: not `apply: "serve"` — the `load` hook below must run in build so it
    // can stub out the panel. `configureServer` is a serve-only hook, so the
    // middleware (the spawn endpoint) still never exists in production.
    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
    },
    load(id) {
      // In production builds, replace the panel entry with an empty stub so no
      // panel/CSS/endpoint-client code can ship. Dev is untouched.
      if (isBuild && /vite-plugin-claude-studio[\\/](dist[\\/])?panel/.test(id)) {
        return "export const mountStudioPanel = () => {};\n";
      }
      return null;
    },
    generateBundle(_options, bundle) {
      // Belt-and-braces: if anything Studio-specific ever leaks into a production
      // chunk (a broken DEV gate, a stray static import), FAIL the build loudly
      // rather than shipping a dev tool that runs `claude`.
      if (!isBuild) return;
      const FORBIDDEN = ["/__studio/", "In-App Studio"];
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const marker of FORBIDDEN) {
          if (chunk.code.includes(marker)) {
            this.error(
              `In-App Studio code leaked into the production bundle (${file}): found "${marker}". ` +
                "The dev-only panel/endpoint must never ship — check the import.meta.env.DEV gate and the panel stub.",
            );
          }
        }
      }
    },
    configureServer(server) {
      // Kill any in-flight run when the dev server stops, so a SIGTERM/Ctrl+C
      // doesn't orphan a `claude` process that keeps editing files.
      const killActive = () => killActiveGeneration();
      server.httpServer?.once("close", killActive);
      process.once("exit", killActive);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/__studio/")) return next();
        // The studio runs an agent with file-write access and has no auth, so
        // it must only ever be driven from this machine, same-origin. This
        // blocks the `vite --host` LAN-exposure case and cross-origin CSRF.
        if (!isLocalSameOriginRequest(req)) {
          return sendJson(res, 403, { error: "Studio endpoints are localhost + same-origin only." });
        }
        try {
          await route(req, res, url.pathname, root, resolved);
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          sendJson(res, status, {
            error: err instanceof Error ? err.message : "Studio error",
          });
        }
      });
    },
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  root: string,
  resolved: ResolvedStudioOptions,
): Promise<void> {
  const method = req.method ?? "GET";

  if (pathname === "/__studio/status" && method === "GET") {
    const branch = currentBranch(root);
    const ab = aheadBehind(root, branch);
    return sendJson(res, 200, {
      branch,
      protectedBranch: isProtectedBranch(branch, resolved.protectedBranches),
      running: isGenerationRunning(),
      dirty: isDirty(root),
      behind: ab?.behind ?? null,
      ahead: ab?.ahead ?? null,
    });
  }

  // Panel runtime config — lets the browser side run with zero inline config.
  if (pathname === "/__studio/config" && method === "GET") {
    return sendJson(res, 200, panelConfigPayload(resolved));
  }

  if (pathname === "/__studio/generate" && method === "POST") {
    return handleGenerate(req, res, root, resolved);
  }

  if (pathname === "/__studio/stop" && method === "POST") {
    return sendJson(res, 200, { stopped: stopGeneration() });
  }

  // Review loop: see the diff, check it passes the gate, keep or revert.
  if (pathname === "/__studio/diff" && method === "GET") {
    return sendJson(res, 200, { files: listChanges(root), diff: await fullDiff(root) });
  }

  if (pathname === "/__studio/check" && method === "POST") {
    if (committing) throw new HttpError(409, "A commit is in progress.");
    if (checkRunning) throw new HttpError(409, "A check is already running.");
    checkRunning = true;
    try {
      return sendJson(res, 200, await runChecks(root, resolved.checks));
    } finally {
      checkRunning = false;
    }
  }

  if (pathname === "/__studio/revert" && method === "POST") {
    let parsed: any;
    try {
      parsed = JSON.parse((await readBody(req)) || "{}");
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (files.length === 0) throw new HttpError(400, "No files to revert.");
    return sendJson(res, 200, doRevert(root, files));
  }

  if (pathname === "/__studio/commit" && method === "POST") {
    return handleCommit(req, res, root, resolved);
  }

  throw new HttpError(404, "Not found");
}

async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  resolved: ResolvedStudioOptions,
): Promise<void> {
  const request = parseGenerateBody(await readBody(req));

  const branch = currentBranch(root);
  if (branch === null) {
    throw new HttpError(400, "Could not determine the git branch — refusing for safety.");
  }
  if (isProtectedBranch(branch, resolved.protectedBranches)) {
    throw new HttpError(
      400,
      `Refusing to run on protected branch "${branch}". Switch to a working branch first.`,
    );
  }
  if (isGenerationRunning()) {
    throw new HttpError(409, "A generation is already running.");
  }

  // Begin streaming NDJSON. Past here, problems are studio_error frames.
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  startGeneration({
    root,
    branch,
    request,
    systemPrompt: resolved.systemPrompt,
    sink: {
      writeRaw: (line) => {
        if (!res.writableEnded) res.write(line + "\n");
      },
      writeFrame: (frame) => writeFrame(res, frame),
      end: () => {
        if (!res.writableEnded) res.end();
      },
    },
  });
}

/**
 * Commit & push. Working-branch-direct model: the safety is a quality gate,
 * not a branch gate. Re-runs the configured checks server-side and refuses to
 * commit if they fail — so a red build can never reach the remote, regardless
 * of client state. Never runs on a protected branch. Always an explicit user
 * action.
 */
async function handleCommit(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  resolved: ResolvedStudioOptions,
): Promise<void> {
  const branch = currentBranch(root);
  if (branch === null) {
    throw new HttpError(400, "Could not determine the git branch — refusing for safety.");
  }
  if (isProtectedBranch(branch, resolved.protectedBranches)) {
    throw new HttpError(400, `Refusing to commit on protected branch "${branch}".`);
  }
  if (isGenerationRunning()) throw new HttpError(409, "A generation is running — wait for it to finish.");
  if (committing) throw new HttpError(409, "A commit is already in progress.");
  if (checkRunning) throw new HttpError(409, "A check is running — wait for it to finish.");

  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "A commit message is required.");
  if (message.length > 500) throw new HttpError(400, "Commit message too long.");

  committing = true;
  try {
    if (listChanges(root).length === 0) {
      return sendJson(res, 200, { ok: false, stage: "commit", output: "No changes to commit." });
    }
    // Hard gate: the configured checks must pass before anything is committed/pushed.
    const check = await runChecks(root, resolved.checks);
    if (!check.ok) {
      return sendJson(res, 200, { ok: false, stage: "check", output: check.output });
    }

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString();
    try {
      git(["add", "-A"]);
      git(["commit", "-m", message]);
    } catch (e) {
      return sendJson(res, 200, { ok: false, stage: "commit", output: gitErr(e) });
    }
    const sha = git(["rev-parse", "--short", "HEAD"]).trim();

    // Sync with the shared branch, then push. Skip the pull when the branch
    // has no upstream yet (e.g. first push of a freshly created branch).
    if (refExists(root, `refs/remotes/origin/${branch}`)) {
      try {
        git(["pull", "--rebase", "origin", branch]);
      } catch (e) {
        try {
          git(["rebase", "--abort"]);
        } catch {
          /* ignore */
        }
        return sendJson(res, 200, {
          ok: false,
          stage: "push",
          sha,
          output:
            `Committed locally (${sha}) but pull --rebase hit a conflict — resolve it and push manually.\n\n` +
            gitErr(e),
        });
      }
    }
    try {
      git(["push", "-u", "origin", branch]);
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        stage: "push",
        sha,
        output: `Committed locally (${sha}) but push failed:\n\n` + gitErr(e),
      });
    }
    return sendJson(res, 200, { ok: true, sha, branch, message });
  } finally {
    committing = false;
  }
}
```

- [ ] **Step 4: Delete the monolith**

```bash
git rm src/vite/dev-plugin.ts
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npx vitest run` — Expected: PASS (all test files).
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/vite/index.ts src/vite/index.test.ts
git commit -m "feat: vite adapter — configurable routes over core, /__studio/config, panel stub"
```

---

### Task 8: Panel configuration wiring

**Files:**
- Create: `src/panel/config.ts`
- Create: `src/panel/index.ts`
- Modify: `src/panel/StudioPanel.tsx`
- Modify: `src/panel/StudioPanel.module.css`
- Modify: `src/panel/mount.tsx` (comment only)
- Test: `src/panel/config.test.tsx` (new) and extend `src/panel/StudioPanel.test.tsx`

**Interfaces:**
- Consumes: `GET /__studio/config` payload shape from Task 7: `{ panel: { buttonLabel, accent, position, appRootSelector }, checkLabels: string[] }`.
- Produces:
  - `src/panel/index.ts`: `export { mountStudioPanel } from "./mount";` — the package's `./panel` entry.
  - `src/panel/config.ts`: `type PanelConfig = { buttonLabel: string; accent: string; position: "bottom-right" | "top-right"; appRootSelector: string; checkLabels: string[] }`, `const DEFAULT_PANEL_CONFIG: PanelConfig`, `function usePanelConfig(): PanelConfig`.

- [ ] **Step 1: Write the failing test**

`src/panel/config.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PANEL_CONFIG, usePanelConfig } from "./config";

function Probe() {
  const cfg = usePanelConfig();
  return <div data-testid="cfg">{`${cfg.buttonLabel}|${cfg.checkLabels.join("+")}`}</div>;
}

afterEach(() => vi.unstubAllGlobals());

describe("usePanelConfig", () => {
  it("starts with defaults and adopts the served config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          panel: { buttonLabel: "✦ Dev", accent: "#f00", position: "top-right", appRootSelector: "#app" },
          checkLabels: ["typecheck"],
        }),
      })) as unknown as typeof fetch,
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("cfg")).toHaveTextContent("✦ Dev|typecheck"));
  });

  it("keeps defaults when the endpoint is unavailable or malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
    render(<Probe />);
    expect(screen.getByTestId("cfg")).toHaveTextContent(
      `${DEFAULT_PANEL_CONFIG.buttonLabel}|lint+build`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/panel/config.test.tsx`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Write `src/panel/config.ts` and `src/panel/index.ts`**

`src/panel/config.ts`:

```ts
import { useEffect, useState } from "react";

/** Runtime panel config served by GET /__studio/config (set in vite.config.ts). */
export type PanelConfig = {
  buttonLabel: string;
  accent: string;
  position: "bottom-right" | "top-right";
  appRootSelector: string;
  checkLabels: string[];
};

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  buttonLabel: "◳ Studio",
  accent: "#3b6fe0",
  position: "bottom-right",
  appRootSelector: "#root",
  checkLabels: ["lint", "build"],
};

/** Fetch the served config once per mount; fall back to defaults on any failure. */
export function usePanelConfig(): PanelConfig {
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG);
  useEffect(() => {
    let cancelled = false;
    fetch("/__studio/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || typeof d !== "object") return;
        const panel = (d.panel ?? {}) as Partial<PanelConfig>;
        setConfig({
          ...DEFAULT_PANEL_CONFIG,
          ...panel,
          checkLabels:
            Array.isArray(d.checkLabels) && d.checkLabels.length > 0
              ? d.checkLabels.map(String)
              : DEFAULT_PANEL_CONFIG.checkLabels,
        });
      })
      .catch(() => {
        /* endpoint absent (e.g. tests) — defaults apply */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
```

`src/panel/index.ts`:

```ts
export { mountStudioPanel } from "./mount";
```

- [ ] **Step 4: Wire the config through `StudioPanel.tsx`**

Apply these exact edits:

a. Add the import:

```ts
import { usePanelConfig } from "./config";
```

b. Extend the existing react import with the `CSSProperties` type (the file currently imports only hooks):

```ts
import { useEffect, useRef, useState, type CSSProperties } from "react";
```

then at the top of the `StudioPanel` component body (before the `open` state), add:

```ts
const cfg = usePanelConfig();
const accentStyle = { "--studio-accent": cfg.accent } as CSSProperties;
```

c. Replace the closed-state button block:

```tsx
if (!open) {
  return (
    <button className={classes.fab} onClick={() => setOpen(true)} aria-label="Open In-App Studio">
      ◳ Studio
    </button>
  );
}
```

with:

```tsx
if (!open) {
  return (
    <button
      className={`${classes.fab} ${cfg.position === "top-right" ? classes.fabTop : ""}`}
      style={accentStyle}
      onClick={() => setOpen(true)}
      aria-label="Open In-App Studio"
    >
      {cfg.buttonLabel}
    </button>
  );
}
```

d. Change the panel container from `<div className={classes.panel} style={{ width }}>` to:

```tsx
<div className={classes.panel} style={{ width, ...accentStyle }}>
```

e. Replace all three `document.getElementById("root")` call sites (the `startResize` handler, its `teardown`, and the docking effect) with:

```ts
document.querySelector<HTMLElement>(cfg.appRootSelector)
```

and add `cfg.appRootSelector` to the docking effect's dependency array (`[open, width]` → `[open, width, cfg.appRootSelector]`).

f. Change the Check button text from `"Check (lint + build)"` to:

```tsx
{busy === "checking" ? "checking…" : `Check (${cfg.checkLabels.join(" + ")})`}
```

g. In the commit `window.prompt` message, change the line `` `Runs lint + build first — won't commit if it fails.\n\nCommit message:` `` to:

```ts
`Runs ${cfg.checkLabels.join(" + ")} first — won't commit if it fails.\n\nCommit message:`
```

h. In `mount.tsx`, reword the comment's mount-site reference so it names no specific file: "Called only from an `import.meta.env.DEV` dead-branch in the host app's entry module, so the whole panel module graph is tree-shaken out of production builds."

- [ ] **Step 5: Update the CSS**

In `src/panel/StudioPanel.module.css`:

a. In `.fab`, replace the `top: 14px;` and `right: 216px;` declarations with:

```css
  bottom: 16px;
  right: 16px;
```

b. Immediately after the `.fab` rule, add:

```css
.fabTop {
  top: 14px;
  bottom: auto;
}
```

c. In `.primary`, replace `background: #3b6fe0;` and `border-color: #3b6fe0;` with:

```css
  background: var(--studio-accent, #3b6fe0);
  border-color: var(--studio-accent, #3b6fe0);
```

d. In `.resizeHandle:hover, .resizeHandle:active`, replace `background: #3b6fe0;` with:

```css
  background: var(--studio-accent, #3b6fe0);
```

- [ ] **Step 6: Extend the existing panel test's fetch mock**

In `src/panel/StudioPanel.test.tsx`, the `mockFetch` helper returns `{}` for unknown URLs — extend it so `/__studio/config` explicitly returns an empty object (defaults apply), keeping existing assertions valid, and add one assertion that the default Check label renders. In `mockFetch`'s URL dispatch, add a branch:

```ts
url.includes("/__studio/config")
  ? {}
  : // …existing branches…
```

and in the test that shows the review area, assert:

```ts
expect(await screen.findByText("Check (lint + build)")).toBeInTheDocument();
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run` — Expected: PASS (all files, including the extended panel test).
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/panel
git commit -m "feat: panel runtime config — button label, accent, position, dock selector, check labels"
```

---

### Task 9: Build pipeline + prepare script

**Files:**
- Create: `vite.config.node.ts`
- Create: `vite.config.panel.ts`
- Create: `tsconfig.build.json`
- Modify: `package.json` (add `build` + `prepare` scripts)

**Interfaces:**
- Consumes: `src/vite/index.ts` (Task 7) and `src/panel/index.ts` (Task 8) as the two entries.
- Produces: `dist/vite.js`, `dist/panel.js`, `dist/types/**/*.d.ts` — matching the `exports` map from Task 1. Git installs build via `prepare`.

- [ ] **Step 1: Write the two build configs**

`vite.config.node.ts`:

```ts
import { defineConfig } from "vite";

// Node-side build: the Vite plugin entry. Externalize node builtins and vite.
export default defineConfig({
  build: {
    lib: { entry: "src/vite/index.ts", formats: ["es"], fileName: () => "vite.js" },
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: { external: [/^node:/, "vite"] },
  },
});
```

`vite.config.panel.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

// Browser-side build: the panel entry. React is a peer; CSS (modules) is
// injected by JS at runtime — acceptable because the panel is dev-only.
export default defineConfig({
  plugins: [react(), cssInjectedByJs()],
  build: {
    lib: { entry: "src/panel/index.ts", formats: ["es"], fileName: () => "panel.js" },
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
  },
});
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

- [ ] **Step 2: Add the scripts to `package.json`**

In `"scripts"`, add:

```json
"build": "rm -rf dist && vite build -c vite.config.node.ts && vite build -c vite.config.panel.ts && tsc -p tsconfig.build.json",
"prepare": "npm run build"
```

- [ ] **Step 3: Build and verify the artifacts**

Run: `npm run build`
Expected: completes; `dist/vite.js`, `dist/panel.js`, `dist/types/vite/index.d.ts`, `dist/types/panel/index.d.ts` all exist.

Run: `node -e "import('./dist/vite.js').then(m => { const p = m.default(); if (p.name !== 'claude-studio') throw new Error('bad plugin'); console.log('plugin ok'); })"`
Expected: `plugin ok`.

Run: `grep -c "mountStudioPanel" dist/panel.js`
Expected: at least 1 (the entry export survived bundling).

- [ ] **Step 4: Verify tests and types still pass**

Run: `npx vitest run` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add vite.config.node.ts vite.config.panel.ts tsconfig.build.json package.json
git commit -m "chore: build pipeline — node + panel lib builds, declaration emit, prepare script"
```

---

### Task 10: README + final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the public API exactly as shipped (Tasks 2, 7, 8): `claudeStudio(options)`, `mountStudioPanel()`, option names `protectedBranches` / `checks` / `systemPrompt` / `panel.{buttonLabel,accent,position,appRootSelector}`.
- Produces: consumer-facing documentation. No code.

- [ ] **Step 1: Write `README.md`**

Write it fresh for a generic consumer, covering (in this order — expand each into real prose, keeping every code sample below exactly consistent with the shipped API):

1. **What it is** — a development-only side panel inside a running Vite + React app that is a context window to your local Claude Code: describe a change, Claude edits the real source, Vite hot-reloads. Lead with the warning that it is dev-only by design and the endpoints must never ship.
2. **Prerequisite** — the `claude` CLI installed and logged in (`claude` on `PATH`); runs use your own Claude usage.
3. **Install** —

```bash
npm i -D github:james-b-kelly/vite-plugin-claude-studio#v0.1.0
```

   Note: git installs build on your machine via `prepare` (devDependencies are installed automatically for git deps).
4. **Setup** — the two wiring points:

```ts
// vite.config.ts
import claudeStudio from "vite-plugin-claude-studio";

export default defineConfig({
  plugins: [react(), claudeStudio()],
});
```

```ts
// your app entry (e.g. main.tsx)
if (import.meta.env.DEV) {
  void import("vite-plugin-claude-studio/panel").then((m) => m.mountStudioPanel());
}
```

5. **Options** — a table + example covering all `StudioOptions` fields and their defaults:

```ts
claudeStudio({
  protectedBranches: ["main", "release-*"],
  checks: [
    { label: "lint", command: ["npm", "run", "lint"] },
    { label: "build", command: ["npx", "vite", "build"] },
  ],
  systemPrompt: "This app uses CSS modules; shared primitives live in src/ui/.",
  panel: {
    buttonLabel: "◳ Studio",
    accent: "#3b6fe0",
    position: "bottom-right",
    appRootSelector: "#root",
  },
})
```

6. **Using it** — dev server → floating button → describe a change → Send; follow-ups continue the session, "↺ new" starts fresh; "⌖ Select" pins an element.
7. **Review loop** — changed-files list with badges, view diff, Check (runs the configured checks), Revert all; Commit & push re-runs the checks server-side and refuses on failure; never auto-commits.
8. **Branch policy** — refuses to run or commit on `protectedBranches` (and always on a detached HEAD).
9. **Production exclusion** — the four layers: serve-only endpoints, the consumer's DEV-gated dynamic import, the build-time panel stub, and the `generateBundle` assertion that fails the build if a Studio marker leaks.
10. **Security model** — endpoints are localhost + same-origin only; the panel drives an agent with file-write access, so never expose the dev server beyond your machine.

- [ ] **Step 2: Final verification pass**

Run: `npx vitest run` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.
Run: `npm run build` — Expected: clean build.
Then re-read `README.md` once against `src/core/config.ts`, checking every option name and default matches the code exactly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: consumer README — install, setup, options, review loop, exclusion layers"
```

---

## Done criteria

- All tasks committed; `npx vitest run`, `npx tsc --noEmit`, and `npm run build` green from a clean checkout (`git status` clean).
- Release (remote repo creation, tagging) and first-consumer integration are handled outside this plan.
