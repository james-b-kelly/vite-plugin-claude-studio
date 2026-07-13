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
