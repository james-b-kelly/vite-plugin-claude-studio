import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import claudeStudio from "./index";

type Handler = (req: any, res: any, next: () => void) => Promise<void> | void;

function makeServer() {
  const handlers: Handler[] = [];
  return {
    middlewares: { use: (fn: Handler) => handlers.push(fn) },
    httpServer: { once: () => {} },
    handlers,
  };
}

function makeRes() {
  return {
    statusCode: 0,
    body: "",
    writableEnded: false,
    setHeader() {},
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk?: string) {
      this.body += chunk ?? "";
      this.writableEnded = true;
    },
  };
}

async function dispatch(server: ReturnType<typeof makeServer>, req: any) {
  const res = makeRes();
  let nextCalled = false;
  for (const h of server.handlers) await h(req, res, () => (nextCalled = true));
  return { res, nextCalled };
}

function makePlugin(options = {}, root = process.cwd()) {
  const plugin = claudeStudio(options) as any;
  plugin.configResolved({ root, command: "serve" });
  const server = makeServer();
  plugin.configureServer(server);
  return { plugin, server };
}

/** A POST body the middleware can `for await` like a real IncomingMessage. */
function withBody(req: Record<string, unknown>, body: unknown) {
  return {
    ...req,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

let tmpRepo = "";
function initRepo(branch = "main"): string {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "studio-vite-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: tmpRepo });
  git("init", "-b", branch);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(tmpRepo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return tmpRepo;
}
afterEach(() => {
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  tmpRepo = "";
});

describe("claudeStudio middleware", () => {
  it("passes non-studio URLs through", async () => {
    const { server } = makePlugin();
    const { nextCalled } = await dispatch(server, {
      url: "/app",
      method: "GET",
      headers: { host: "localhost:5173" },
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects non-local hosts with 403", async () => {
    const { server } = makePlugin();
    const { res } = await dispatch(server, {
      url: "/__studio/config",
      method: "GET",
      headers: { host: "192.168.1.20:5173" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves the panel config with defaults and custom check labels", async () => {
    const { server } = makePlugin({
      checks: [{ label: "typecheck", command: ["npx", "tsc", "--noEmit"] }],
      panel: { buttonLabel: "✦ Dev" },
    });
    const { res } = await dispatch(server, {
      url: "/__studio/config",
      method: "GET",
      headers: { host: "localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checkLabels).toEqual(["typecheck"]);
    expect(body.panel.buttonLabel).toBe("✦ Dev");
    expect(body.panel.appRootSelector).toBe("#root");
    expect(body.designer).toBeNull();
  });

  it("exposes designer branch + stub tag in the panel config when configured", async () => {
    const { server } = makePlugin({ designer: { branch: "develop-design", baseBranch: "develop" } });
    const { res } = await dispatch(server, {
      url: "/__studio/config",
      method: "GET",
      headers: { host: "localhost:5173" },
    });
    expect(JSON.parse(res.body).designer).toEqual({ branch: "develop-design", stubTag: "@design-stub" });
  });
});

describe("POST /__studio/sync", () => {
  it("reports the current branch without switching in developer mode", async () => {
    const root = initRepo("work");
    const { server } = makePlugin({}, root);
    const { res } = await dispatch(
      server,
      withBody({ url: "/__studio/sync", method: "POST", headers: { host: "localhost:5173" } }, { mode: "developer" }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.branch).toBe("work");
    // No remote in this repo, so the fetch fails and sync reports offline.
    expect(body.result).toBe("offline");
  });

  it("pins designer mode to the configured design branch", async () => {
    const root = initRepo("work");
    const { server } = makePlugin({ designer: { branch: "design", baseBranch: "work" } }, root);
    const { res } = await dispatch(
      server,
      withBody({ url: "/__studio/sync", method: "POST", headers: { host: "localhost:5173" } }, { mode: "designer" }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.branch).toBe("design");
    expect(body.created).toBe(true);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).toString().trim()).toBe(
      "design",
    );
  });
});

describe("designer-mode guards", () => {
  it("refuses a designer generate when designer mode is not configured", async () => {
    const root = initRepo("work");
    const { server } = makePlugin({}, root);
    const { res } = await dispatch(
      server,
      withBody(
        { url: "/__studio/generate", method: "POST", headers: { host: "localhost:5173" } },
        { instruction: "make it blue", mode: "designer" },
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not configured/i);
  });

  it("refuses a designer commit off the design branch", async () => {
    const root = initRepo("work");
    fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
    const { server } = makePlugin({ designer: { branch: "design", baseBranch: "work" } }, root);
    const { res } = await dispatch(
      server,
      withBody(
        { url: "/__studio/commit", method: "POST", headers: { host: "localhost:5173" } },
        { message: "tweak", mode: "designer" },
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/design/);
  });
});

describe("claudeStudio build hooks", () => {
  it("stubs the panel module in build mode", () => {
    const plugin = claudeStudio() as any;
    plugin.configResolved({ root: process.cwd(), command: "build" });
    const stub = plugin.load("/x/node_modules/vite-plugin-claude-studio/dist/panel.js");
    expect(stub).toContain("mountStudioPanel = () => {}");
    expect(plugin.load("/x/src/App.tsx")).toBeNull();
  });

  it("leaves the panel module alone in dev", () => {
    const plugin = claudeStudio() as any;
    plugin.configResolved({ root: process.cwd(), command: "serve" });
    expect(plugin.load("/x/node_modules/vite-plugin-claude-studio/dist/panel.js")).toBeNull();
  });
});
