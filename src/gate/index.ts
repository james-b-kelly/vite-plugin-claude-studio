import { gateDecision } from "../core/designer";

/**
 * Designer-mode PreToolUse gate — the executable Claude Code hook.
 *
 * Wired in per-run via `--settings` (see designerCliArgs); never loaded for
 * Developer-mode runs. Config arrives as base64 JSON in argv[2] so the hook is
 * self-contained. Contract: print a deny decision to stdout to block; exit 0
 * with no output to allow. All decisions live in gateDecision/evaluateGate —
 * this file is only stream glue.
 */
async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

readStdin().then((raw) => {
  const out = gateDecision(raw, process.argv[2] ?? "");
  if (out) process.stdout.write(out);
  process.exit(0);
});
