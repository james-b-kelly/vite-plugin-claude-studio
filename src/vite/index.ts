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
