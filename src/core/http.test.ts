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
