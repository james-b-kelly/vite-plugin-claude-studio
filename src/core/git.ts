import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ChangedStatus = "new" | "modified" | "deleted";
// `orig` is set for renames (the path the file was renamed FROM) so a revert can
// restore the original and remove the new path.
export type ChangedFile = { path: string; status: ChangedStatus; orig?: string };

export function gitErr(e: unknown): string {
  const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
  return (
    (err.stderr?.toString() || err.stdout?.toString() || err.message || "git command failed")
      .toString()
      .trim()
      .slice(0, 2000)
  );
}

// ── git helpers ──────────────────────────────────────────────────────────────

export function currentBranch(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function isDirty(root: string): boolean {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim().length > 0
    );
  } catch {
    return false;
  }
}

/** True if a git ref (e.g. `refs/heads/x`, `refs/remotes/origin/x`) resolves. */
export function refExists(root: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Commits the local branch is behind / ahead of `origin/<branch>` (null if no upstream ref). */
export function aheadBehind(root: string, branch: string | null): { behind: number; ahead: number } | null {
  if (!branch || branch === "HEAD") return null;
  try {
    const out = execFileSync(
      "git",
      ["rev-list", "--left-right", "--count", `origin/${branch}...${branch}`],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    )
      .toString()
      .trim();
    const [behind, ahead] = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isNaN(behind) || Number.isNaN(ahead)) return null;
    return { behind, ahead };
  } catch {
    return null;
  }
}

/**
 * All uncommitted changes vs the working tree — tracked edits/deletions AND new
 * untracked files (so the panel shows everything Claude did, and Revert can undo
 * it all). Parsed from `git status --porcelain`.
 */
export function listChanges(root: string): ChangedFile[] {
  let out = "";
  try {
    out = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain"], {
      cwd: root,
    }).toString();
  } catch {
    return [];
  }
  const files: ChangedFile[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    const rest = raw.slice(3);
    let p = rest;
    let orig: string | undefined;
    const arrow = rest.indexOf(" -> "); // renamed: "old -> new"
    if (arrow !== -1) {
      orig = rest.slice(0, arrow).trim();
      p = rest.slice(arrow + 4);
    }
    p = p.trim();
    if (!p) continue;
    // The new path is "new" relative to HEAD for both an add (`A`/`??`) and the
    // target of a rename. `xy[0]` is the staged (index) column; check it, not a
    // substring, so `MA`/`DA`-style worktree states aren't mis-read as adds.
    let status: ChangedStatus = "modified";
    if (arrow !== -1 || xy === "??" || xy[0] === "A") status = "new";
    else if (xy.includes("D")) status = "deleted";
    files.push(orig ? { path: p, status, orig } : { path: p, status });
  }
  return files;
}

/**
 * Full `git diff` text for the panel's diff view. Tracked changes come from
 * `git diff HEAD`; untracked new files don't show there, so each is rendered as
 * an added-file diff via `--no-index` against /dev/null. Capped so a huge change
 * can't flood the panel.
 */
export function fullDiff(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "HEAD", "--no-color"],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      (_err, tracked) => {
        const news = listChanges(root).filter((f) => f.status === "new");
        const cap = (s: string) => s.slice(0, 200_000);
        if (news.length === 0) return resolve(cap((tracked ?? "").toString()));
        let extra = "";
        let pending = news.length;
        for (const f of news) {
          execFile(
            "git",
            ["diff", "--no-index", "--no-color", "--", "/dev/null", f.path],
            { cwd: root, maxBuffer: 4 * 1024 * 1024 },
            (_e2, addOut) => {
              // Cap each file before accumulating so a run with many/large new
              // files can't balloon memory before the overall cap applies.
              extra += "\n" + (addOut ?? "").toString().slice(0, 50_000);
              if (--pending === 0) resolve(cap((tracked ?? "").toString() + extra));
            },
          );
        }
      },
    );
  });
}

/**
 * Undo a run's changes, scoped to the given files: restore tracked edits/
 * deletions to HEAD, delete new untracked files. NEVER commits. Re-derives the
 * live change set and only touches paths that are genuinely changed AND inside
 * the repo root (defence-in-depth on top of the localhost+same-origin guard).
 */
export function doRevert(
  root: string,
  requested: string[],
): { restored: string[]; deleted: string[]; skipped: string[] } {
  const current = new Map(listChanges(root).map((f) => [f.path, f]));
  const gitDir = path.join(root, ".git");
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  const toRestore: string[] = [];

  for (const p of requested) {
    const cf = current.get(p);
    const abs = path.resolve(root, p);
    // Only touch paths that are genuinely changed, inside the repo, and never
    // inside .git/ (explicit — git status never lists those, but rmSync deletes).
    if (
      !cf ||
      (abs !== root && !abs.startsWith(root + path.sep)) ||
      abs === gitDir ||
      abs.startsWith(gitDir + path.sep)
    ) {
      skipped.push(p);
      continue;
    }
    if (cf.status === "new") {
      try {
        fs.rmSync(abs, { force: true });
        deleted.push(p);
      } catch {
        skipped.push(p);
        continue;
      }
      // Clear a possible staged add so the file fully leaves `git status`.
      try {
        execFileSync("git", ["reset", "-q", "HEAD", "--", p], { cwd: root });
      } catch {
        /* not staged — fine */
      }
      // If this was a rename, restore the file it was renamed from.
      if (cf.orig) {
        try {
          execFileSync("git", ["checkout", "HEAD", "--", cf.orig], { cwd: root });
          restored.push(cf.orig);
        } catch {
          skipped.push(cf.orig);
        }
      }
    } else {
      toRestore.push(p);
    }
  }

  for (const p of toRestore) {
    try {
      execFileSync("git", ["checkout", "HEAD", "--", p], { cwd: root });
      restored.push(p);
    } catch {
      skipped.push(p);
    }
  }
  return { restored, deleted, skipped };
}
