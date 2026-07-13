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
