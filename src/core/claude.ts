import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { HttpError } from "./http";
import { listChanges } from "./git";

const GENERATE_MODEL = "sonnet";
const MAX_INSTRUCTION = 32_000;
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type PinInfo = {
  component?: string;
  file?: string;
  line?: number;
  tag?: string;
  id?: string;
  classes?: string;
  text?: string;
  cssPath?: string;
};

/** Sanitise the pinned-element target into bounded fields. */
function parsePin(raw: any): PinInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  // Strip characters that have structural meaning in the prompt text we build
  // (backticks, double-quotes, newlines) so a pin value can't reshape the prompt.
  const str = (v: any, n: number) => {
    if (typeof v !== "string") return undefined;
    const s = v.replace(/[`"\r\n]/g, " ").trim().slice(0, n);
    return s || undefined;
  };
  const pin: PinInfo = {
    component: str(raw.component, 80),
    file: str(raw.file, 300),
    line: Number.isFinite(raw.line) ? Math.floor(raw.line) : undefined,
    tag: str(raw.tag, 40),
    id: str(raw.id, 100),
    classes: str(raw.classes, 300),
    text: str(raw.text, 200),
    cssPath: str(raw.cssPath, 500),
  };
  // Nothing usable to target → treat as absent.
  if (!pin.file && !pin.component && !pin.tag && !pin.cssPath) return undefined;
  return pin;
}

/** A precise "the user pointed at THIS" instruction from a pinned element. */
function pinContext(pin: PinInfo): string {
  const where = pin.file
    ? `${pin.component ? `<${pin.component}> ` : ""}at \`${pin.file}${pin.line ? `:${pin.line}` : ""}\``
    : pin.component
      ? `<${pin.component}>`
      : "the element described below";
  const dom = [
    pin.tag
      ? `<${pin.tag}${pin.id ? ` id="${pin.id}"` : ""}${pin.classes ? ` class="${pin.classes}"` : ""}>`
      : "",
    pin.text ? `text "${pin.text}"` : "",
    pin.cssPath ? `selector \`${pin.cssPath}\`` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return (
    `The user pinned a SPECIFIC element to target — ${where}.` +
    (dom ? ` DOM: ${dom}.` : "") +
    ` Make the requested change to this exact element/component; if the source location ` +
    `is given, edit there. The fiber source can be missing — fall back to the DOM details.`
  );
}

function claudeErrorMessage(err: unknown): string {
  if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return "Claude Code CLI not found — install it and ensure `claude` is on your PATH, then log in.";
  }
  return err instanceof Error ? err.message : "Failed to start Claude Code";
}

export type GenerateRequest = {
  instruction: string;
  resumeSessionId?: string;
  route?: string;
  screen?: string;
  pin?: PinInfo;
};

export function parseGenerateBody(raw: string): GenerateRequest {
  let obj: any;
  try {
    obj = JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const instruction = typeof obj.instruction === "string" ? obj.instruction.trim() : "";
  if (!instruction) throw new HttpError(400, "instruction is required");
  if (instruction.length > MAX_INSTRUCTION) throw new HttpError(400, "instruction too long");
  let resumeSessionId: string | undefined;
  if (obj.resumeSessionId != null) {
    if (typeof obj.resumeSessionId !== "string" || !SESSION_ID_RE.test(obj.resumeSessionId)) {
      throw new HttpError(400, "resumeSessionId must be a UUID");
    }
    resumeSessionId = obj.resumeSessionId;
  }
  // Current app route (where the user is looking), to anchor "this page" requests.
  const route = typeof obj.route === "string" ? obj.route.slice(0, 2000) : undefined;
  // A snapshot of the visible UI (open dialogs, headings) captured from the DOM.
  const screen = typeof obj.screen === "string" ? obj.screen.slice(0, 8000) : undefined;
  const pin = parsePin(obj.pin);
  return { instruction, resumeSessionId, route, screen, pin };
}

/** Prepend project notes + route/screen/pin context so Claude knows scope and target. */
export function buildPrompt(request: GenerateRequest, systemPrompt: string): string {
  const { instruction, route, screen, pin } = request;
  const ctx: string[] = [];
  if (pin) ctx.push(pinContext(pin));
  if (route) ctx.push(`Route: \`${route}\``);
  if (screen) ctx.push(`Visible UI right now (captured live from the DOM):\n${screen}`);
  const notes = systemPrompt
    ? `Project notes from the app's Studio configuration:\n${systemPrompt}\n\n`
    : "";
  if (ctx.length === 0) return notes ? `${notes}Request: ${instruction}` : instruction;
  return (
    notes +
    `Context — what the user is looking at in the running app:\n${ctx.join("\n\n")}\n\n` +
    `Use this to find the relevant component(s): match the visible text/dialog titles above ` +
    `against the source (the app's route configuration, feature pages/components, and ` +
    `shared modal/dialog components), then make the change there.\n\n` +
    `Request: ${instruction}`
  );
}

// ── run management ───────────────────────────────────────────────────────────

let activeRun: ChildProcess | null = null;

export function isGenerationRunning(): boolean {
  return activeRun !== null;
}

/** Explicit cancellation (POST /__studio/stop). Returns whether a run was live. */
export function stopGeneration(): boolean {
  const wasRunning = activeRun !== null;
  // Clear eagerly; the close handler's clearActive() is identity-guarded + idempotent.
  if (activeRun) {
    activeRun.kill("SIGTERM");
    activeRun = null;
  }
  return wasRunning;
}

/** Dev-server shutdown: don't orphan a child that keeps editing files. */
export function killActiveGeneration(): void {
  if (activeRun && !activeRun.killed) activeRun.kill("SIGTERM");
}

export type GenerateSink = {
  writeRaw(line: string): void;
  writeFrame(frame: unknown): void;
  end(): void;
};

export function startGeneration(args: {
  root: string;
  branch: string;
  request: GenerateRequest;
  systemPrompt: string;
  sink: GenerateSink;
}): void {
  const { root, branch, request, systemPrompt, sink } = args;

  // Prompt via stdin (not argv) so nothing can be option-smuggled.
  const cliArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--model",
    GENERATE_MODEL,
  ];
  if (request.resumeSessionId) cliArgs.push("--resume", request.resumeSessionId);

  const child = spawn("claude", cliArgs, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  activeRun = child;

  let sessionId: string | undefined;
  let stdoutBuf = "";
  let stderrBuf = "";
  const decoder = new StringDecoder("utf8");

  const clearActive = () => {
    if (activeRun === child) activeRun = null;
  };

  child.on("error", (err) => {
    sink.writeFrame({ type: "studio_error", message: claudeErrorMessage(err) });
    clearActive();
    sink.end();
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += decoder.write(chunk);
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
      } catch {
        /* forward raw anyway */
      }
      sink.writeRaw(line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
  });

  child.on("close", (code) => {
    try {
      const tailOut = stdoutBuf + decoder.end();
      if (tailOut.trim()) sink.writeRaw(tailOut.trim());
      const exitCode = code ?? 0;
      if (exitCode !== 0 && stderrBuf.trim()) {
        sink.writeFrame({ type: "studio_error", message: stderrBuf.trim().slice(0, 500) });
      }
      sink.writeFrame({ type: "studio_diff", branch, files: listChanges(root) });
      sink.writeFrame({ type: "studio_done", exitCode, sessionId });
    } finally {
      clearActive();
      sink.end();
    }
  });

  // NB: the child is deliberately NOT killed when the client disconnects. An
  // edit can trigger an HMR full-reload mid-run, which would otherwise abort
  // the run and leave a half-applied change. The run finishes on disk
  // regardless; the sink is a no-op once the response is closed. Explicit
  // cancellation goes through stopGeneration().

  child.stdin?.write(buildPrompt(request, systemPrompt));
  child.stdin?.end();
}
