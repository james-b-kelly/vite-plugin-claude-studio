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
