import { describe, expect, it } from "vitest";
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

function makePlugin(options = {}) {
  const plugin = claudeStudio(options) as any;
  plugin.configResolved({ root: process.cwd(), command: "serve" });
  const server = makeServer();
  plugin.configureServer(server);
  return { plugin, server };
}

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
