import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentBranch, doRevert, fetchOrigin, isDirty, listChanges, syncDesignerBranch } from "./git";

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

// A bare "origin" plus two clones lets us simulate the designer's machine and a
// base branch that moves underneath it.
function initRemotePair(): { origin: string; work: string; other: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sync-"));
  dir = base; // afterEach cleans the whole tree
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  const other = path.join(base, "other");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const seed = (clone: string) => {
    execFileSync("git", ["clone", origin, clone]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: clone });
    execFileSync("git", ["config", "user.name", "T"], { cwd: clone });
  };
  seed(work);
  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: work });
  execFileSync("git", ["commit", "-m", "init"], { cwd: work });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: work });
  seed(other);
  return { origin, work, other };
}

function commitOnOther(other: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(other, file), content);
  execFileSync("git", ["add", "-A"], { cwd: other });
  execFileSync("git", ["commit", "-m", message], { cwd: other });
  execFileSync("git", ["push", "origin", "main"], { cwd: other });
}

describe("syncDesignerBranch", () => {
  it("creates the design branch from origin/<base> on first sync", () => {
    const { work } = initRemotePair();
    const online = fetchOrigin(work);
    expect(online).toBe(true);
    const r = syncDesignerBranch(work, { branch: "design", baseBranch: "main", online });
    expect(r).toEqual({ created: true, result: "synced" });
    expect(currentBranch(work)).toBe("design");
  });

  it("skips without touching anything when the tree is dirty", () => {
    const { work } = initRemotePair();
    fs.writeFileSync(path.join(work, "a.txt"), "dirty\n");
    const r = syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: true });
    expect(r).toEqual({ created: false, result: "dirty-skip" });
    expect(currentBranch(work)).toBe("main");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("dirty\n");
  });

  it("merges a moved base branch into the design branch", () => {
    const { work, other } = initRemotePair();
    syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: fetchOrigin(work) });
    commitOnOther(other, "b.txt", "from base\n", "base moves");
    const r = syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: fetchOrigin(work) });
    expect(r).toEqual({ created: false, result: "synced" });
    expect(fs.readFileSync(path.join(work, "b.txt"), "utf8")).toBe("from base\n");
  });

  it("aborts a conflicting base merge and reports it, leaving the branch intact", () => {
    const { work, other } = initRemotePair();
    syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: fetchOrigin(work) });
    // Design edits a.txt and commits; base edits the same line differently.
    fs.writeFileSync(path.join(work, "a.txt"), "design version\n");
    execFileSync("git", ["add", "-A"], { cwd: work });
    execFileSync("git", ["commit", "-m", "design edit"], { cwd: work });
    commitOnOther(other, "a.txt", "base version\n", "conflicting base edit");
    const r = syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: fetchOrigin(work) });
    expect(r).toEqual({ created: false, result: "conflict" });
    expect(currentBranch(work)).toBe("design");
    expect(isDirty(work)).toBe(false);
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("design version\n");
  });

  it("reports offline without merging when the fetch failed", () => {
    const { work } = initRemotePair();
    const r = syncDesignerBranch(work, { branch: "design", baseBranch: "main", online: false });
    expect(r).toEqual({ created: true, result: "offline" });
    expect(currentBranch(work)).toBe("design");
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
