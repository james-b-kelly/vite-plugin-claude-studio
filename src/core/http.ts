import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // ipv6 [::1]
  return h.split(":")[0];
}

/** Only allow studio requests from this machine, same-origin (no LAN, no cross-site). */
export function isLocalSameOriginRequest(req: IncomingMessage): boolean {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host ?? ""))) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }
  return true;
}

export function writeFrame(res: ServerResponse, frame: unknown): void {
  if (!res.writableEnded) res.write(JSON.stringify(frame) + "\n");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
