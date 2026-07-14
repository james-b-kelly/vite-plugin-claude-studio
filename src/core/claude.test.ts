import { describe, expect, it } from "vitest";
import { buildPrompt, parseGenerateBody, subscriptionEnv } from "./claude";

describe("subscriptionEnv", () => {
  it("strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN so the CLI uses the logged-in subscription", () => {
    const env = subscriptionEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
      ANTHROPIC_AUTH_TOKEN: "token-should-not-leak",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // Everything else must survive — PATH so `claude` is found, HOME so the CLI reads its stored login.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
  });

  it("does not mutate the caller's env object (must never delete from process.env)", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-keep-in-caller" };
    subscriptionEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-keep-in-caller");
  });
});

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
