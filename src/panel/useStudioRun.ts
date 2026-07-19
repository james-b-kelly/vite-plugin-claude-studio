import { useCallback, useEffect, useRef, useState } from "react";
import type { PinTarget } from "./fiberSource";

/**
 * In-App Studio — dev-only stream reader.
 * POSTs an instruction to /__studio/generate and reads the NDJSON stream:
 * Claude's own frames (system/assistant/user/result) plus the studio control
 * frames (studio_diff / studio_done / studio_error). Noise frames are dropped.
 */

export type RunStatus = "idle" | "running" | "done" | "error";
export type LogEntry = { kind: "user" | "tool" | "text" | "done" | "error"; text: string };
export type ChangedStatus = "new" | "modified" | "deleted";
export type ChangedFile = { path: string; status: ChangedStatus };
export type CheckResult = { ok: boolean; output: string };
export type CommitResult = { ok: boolean; sha?: string; branch?: string; output?: string };

function basename(p: unknown): string {
  return typeof p === "string" ? p.split(/[\\/]/).pop() || p : "";
}

function frameToEntry(evt: any): LogEntry | null {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "studio_error") return { kind: "error", text: String(evt.message ?? "error") };
  if (evt.type === "studio_done") {
    return { kind: "done", text: evt.exitCode === 0 ? "Done." : `Claude exited (code ${evt.exitCode}).` };
  }
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        const name = block.name as string;
        const input = block.input ?? {};
        if (name === "Write" || name === "Edit") return { kind: "tool", text: `✎ ${basename(input.file_path)}` };
        if (name === "Read") return { kind: "tool", text: `read ${basename(input.file_path)}` };
        if (name === "Glob" || name === "Grep") return { kind: "tool", text: "searching the codebase" };
        if (name === "Bash") {
          const cmd = String(input.command ?? "").trim();
          const desc = String(input.description ?? "").trim();
          // File-discovery commands are all just "searching" — collapse them.
          if (/^(grep|rg|find|ls|cat|head|tail|sed|awk|tree|fd|wc|test)\b/.test(cmd)) {
            return { kind: "tool", text: "searching the codebase" };
          }
          return { kind: "tool", text: desc || `$ ${cmd.split("\n")[0].slice(0, 80)}` };
        }
        return { kind: "tool", text: name };
      }
      if (block.type === "text" && block.text?.trim()) return { kind: "text", text: block.text.trim() };
    }
  }
  return null;
}

// Persist the transcript + session so an HMR full-reload (which can happen when
// Claude edits the app) doesn't dump the chat or the resumable session.
const LS_LOG = "studio:v1:log";
const LS_SESSION = "studio:v1:session";

function loadLog(): LogEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_LOG) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function loadSession(): string | undefined {
  return localStorage.getItem(LS_SESSION) || undefined;
}
function clearStorage() {
  try {
    localStorage.removeItem(LS_LOG);
    localStorage.removeItem(LS_SESSION);
  } catch {
    /* ignore */
  }
}

export function useStudioRun() {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [log, setLog] = useState<LogEntry[]>(loadLog);
  const [sessionId, setSessionId] = useState<string | undefined>(loadSession);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState<null | "checking" | "reverting" | "committing">(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Persist transcript (capped) and the last resumable session id.
  useEffect(() => {
    try {
      localStorage.setItem(LS_LOG, JSON.stringify(log.slice(-200)));
    } catch {
      /* ignore quota */
    }
  }, [log]);
  useEffect(() => {
    try {
      if (sessionId) localStorage.setItem(LS_SESSION, sessionId);
      else localStorage.removeItem(LS_SESSION);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  const run = useCallback(async (opts: { instruction: string; resumeSessionId?: string; route?: string; screen?: string; mode?: "developer" | "designer"; pin?: PinTarget }) => {
    setStatus("running");
    setError(null);
    setChangedFiles([]);
    setDiff("");
    setCheckResult(null);
    setCommitResult(null);
    // Keep the last session id (don't clear): runs continue the conversation;
    // "↺ new" is the way to start fresh. Avoids losing a resumable session on a
    // mid-run reload.
    // Echo the request into the transcript so the history of what was asked stays visible.
    setLog((prev) => [...prev, { kind: "user", text: opts.instruction }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/__studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let msg = text;
        try {
          msg = JSON.parse(text).error ?? text;
        } catch {
          /* keep raw */
        }
        setError(msg || `Request failed (${res.status})`);
        setStatus("error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawError = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "studio_diff" && Array.isArray(evt.files)) setChangedFiles(evt.files);
          if (evt.type === "studio_done" && typeof evt.sessionId === "string") setSessionId(evt.sessionId);
          if (evt.type === "studio_error") {
            sawError = true;
            setError(String(evt.message ?? "error"));
          }
          const entry = frameToEntry(evt);
          if (entry) {
            setLog((prev) => {
              const last = prev[prev.length - 1];
              // Collapse consecutive identical lines (e.g. repeated "searching the codebase").
              if (last && last.kind === entry.kind && last.text === entry.text) return prev;
              return [...prev, entry];
            });
          }
        }
      }
      setStatus(sawError ? "error" : "done");
    } catch (e) {
      if (ac.signal.aborted) setStatus("idle");
      else {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // The server no longer kills the child on disconnect, so cancel explicitly.
    fetch("/__studio/stop", { method: "POST" }).catch(() => {});
  }, []);

  // Pull the current changed-files list + full diff (on panel open, after a run,
  // and after a revert) so the review surface reflects the real working tree.
  const refreshChanged = useCallback(async () => {
    try {
      const r = await fetch("/__studio/diff");
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.files)) setChangedFiles(d.files);
      if (typeof d.diff === "string") setDiff(d.diff);
    } catch {
      /* ignore */
    }
  }, []);

  // Run the repo's lint + build against the edits; report pass/fail.
  const check = useCallback(async () => {
    setBusy("checking");
    setCheckResult(null);
    try {
      const r = await fetch("/__studio/check", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setCheckResult({
        ok: r.ok && !!d.ok,
        output: String(d.output ?? d.error ?? (r.ok ? "" : `Check failed (${r.status})`)),
      });
    } catch (e) {
      setCheckResult({ ok: false, output: e instanceof Error ? e.message : "Check failed" });
    } finally {
      setBusy(null);
    }
  }, []);

  // Undo the listed changes (restore tracked, delete new). Never commits.
  const revert = useCallback(
    async (paths: string[]) => {
      setBusy("reverting");
      try {
        await fetch("/__studio/revert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: paths }),
        });
      } catch {
        /* ignore — refresh below reflects whatever actually happened */
      } finally {
        setCheckResult(null);
        await refreshChanged();
        setBusy(null);
      }
    },
    [refreshChanged],
  );

  // Commit & push the current changes. Server re-runs Check (lint+build) and
  // refuses if it fails, so a red build never reaches the remote.
  const commit = useCallback(
    async (message: string, mode?: "developer" | "designer") => {
      setBusy("committing");
      setCommitResult(null);
      try {
        const r = await fetch("/__studio/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, mode }),
        });
        const d = await r.json().catch(() => ({}));
        const ok = r.ok && !!d.ok;
        setCommitResult({
          ok,
          sha: d.sha,
          branch: d.branch,
          output: d.output ?? d.error ?? (r.ok ? "" : `Commit failed (${r.status})`),
        });
        if (ok) setCheckResult(null);
        // Refresh after success OR a push-stage failure — in both cases the local
        // commit already happened, so the working tree is clean.
        if (ok || d.stage === "push") await refreshChanged();
      } catch (e) {
        setCommitResult({ ok: false, output: e instanceof Error ? e.message : "Commit failed" });
      } finally {
        setBusy(null);
      }
    },
    [refreshChanged],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
    setLog([]);
    setChangedFiles([]);
    setDiff("");
    setCheckResult(null);
    setCommitResult(null);
    setSessionId(undefined);
    setError(null);
    clearStorage();
  }, []);

  return {
    status,
    log,
    sessionId,
    changedFiles,
    diff,
    checkResult,
    commitResult,
    busy,
    error,
    run,
    stop,
    reset,
    refreshChanged,
    check,
    revert,
    commit,
  };
}
