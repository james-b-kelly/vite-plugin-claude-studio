import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStudioRun } from "./useStudioRun";
import { captureScreenContext } from "./captureContext";
import { ElementPicker, PinnedOutline } from "./ElementPicker";
import { pinLabel, type PinTarget } from "./fiberSource";
import { MarkdownText } from "./Markdown";
import { usePanelConfig } from "./config";
import classes from "./StudioPanel.module.css";

/**
 * In-App Studio — dev-only panel. A context window to local Claude Code that
 * edits THIS running app. Mounted only under `import.meta.env.DEV` (see
 * main.tsx); excluded from production builds.
 *
 * Developer-only variant (full access). Diff/Check/Revert/Commit make up the
 * review loop; Select pins a specific on-screen element as context.
 */
type StatusInfo = {
  branch: string | null;
  protectedBranch: boolean;
  dirty: boolean;
  behind?: number | null;
  ahead?: number | null;
};

// Panel width is user-resizable, persisted to localStorage and used to drive
// both the panel's own width and the `#root` margin-right (docking).
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;
// Cap at 90vw to mirror `.panel { max-width: 90vw }` and keep some app visible.
function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.9));
}
function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_WIDTH), maxWidth());
}
function loadWidth(): number {
  try {
    const v = parseInt(localStorage.getItem("studio:v1:width") ?? "", 10);
    if (Number.isFinite(v)) return clampWidth(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem("studio:v1:open") === "1";
  } catch {
    return false;
  }
}

type Mode = "developer" | "designer";

// Sticky banner copy for sync outcomes that need the designer's awareness.
// "synced"/"ok" are silent. The designer is never asked to resolve git — just told.
const SYNC_BANNERS: Record<string, string> = {
  conflict:
    "The base branch has changes that conflict with this branch — couldn't auto-merge. You can keep working; let a developer know so they can reconcile.",
  "dirty-skip":
    "You have uncommitted changes, so I couldn't sync the design branch. Commit or revert them first — or let a developer know.",
  offline: "Couldn't reach the remote — working from your local copy. Changes may need reconciling later.",
};

// Render a unified `git diff` with line coloring: additions green, deletions
// red, hunk headers blue, file/meta headers muted. Order matters — the +++/---
// file markers must be classified as meta BEFORE the +/- add/remove check.
function DiffBody({ text }: { text: string }) {
  return (
    <div className={classes.diffBody}>
      {text.split("\n").map((line, i) => {
        let cls = classes.dlCtx;
        if (
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("+++ ") ||
          line.startsWith("--- ") ||
          line.startsWith("new file") ||
          line.startsWith("deleted file") ||
          line.startsWith("rename ") ||
          line.startsWith("similarity ") ||
          line.startsWith("\\ No newline")
        ) {
          cls = classes.dlMeta;
        } else if (line.startsWith("@@")) {
          cls = classes.dlHunk;
        } else if (line.startsWith("+")) {
          cls = classes.dlAdd;
        } else if (line.startsWith("-")) {
          cls = classes.dlDel;
        }
        return (
          <span key={i} className={`${classes.diffLine} ${cls}`}>
            {line === "" ? " " : line}
          </span>
        );
      })}
    </div>
  );
}

export function StudioPanel() {
  const cfg = usePanelConfig();
  const accentStyle = { "--studio-accent": cfg.accent } as CSSProperties;
  const dockLeft = cfg.position.endsWith("left");
  const [open, setOpen] = useState(loadOpen);
  const [width, setWidth] = useState(loadWidth);
  const draggingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [mode, setMode] = useState<Mode>("developer");
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  // Visual select & annotate. `pin` is the serialisable target sent to Claude;
  // `pinnedEl` is the live node the outline tracks.
  const [selecting, setSelecting] = useState(false);
  const [pin, setPin] = useState<PinTarget | null>(null);
  const [pinnedEl, setPinnedEl] = useState<Element | null>(null);
  const {
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
  } = useStudioRun();
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const running = status === "running";

  useEffect(() => {
    try {
      localStorage.setItem("studio:v1:open", open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem("studio:v1:width", String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  // Tear down any in-flight resize listeners if the panel unmounts mid-drag.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // Drag the left-edge handle to resize. Width drives the dock margin live (see
  // the docking effect); transition is suspended during the drag so it tracks
  // the pointer without lag, then restored on release/teardown.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    if (draggingRef.current) return; // ignore a second pointer while dragging
    draggingRef.current = true;
    const root = document.querySelector<HTMLElement>(cfg.appRootSelector);
    if (root) root.style.transition = "none";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: PointerEvent) =>
      setWidth(dockLeft ? clampWidth(ev.clientX) : clampWidth(window.innerWidth - ev.clientX));
    const teardown = () => {
      draggingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const r = document.querySelector<HTMLElement>(cfg.appRootSelector);
      if (r) r.style.transition = `${dockLeft ? "margin-left" : "margin-right"} 0.15s ease`;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", teardown);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = teardown;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", teardown);
  };

  // On open, detect the current branch + dirty state (read-only /__studio/status)
  // and reflect the branch in the mode toggle — WITHOUT switching branches.
  // Opening must never move the working tree; the branch only changes when the
  // user explicitly clicks a mode button (see selectMode).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSyncResult(null);
    fetch("/__studio/status")
      .then((r) => r.json())
      .then((d: StatusInfo) => {
        if (cancelled) return;
        setInfo(d);
        if (cfg.designer) setMode(d.branch === cfg.designer.branch ? "designer" : "developer");
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cfg.designer]);

  // Explicit mode switch from the toggle — the ONLY path that changes the branch.
  // Designer pins the tree to the design branch; Developer leaves it where it is.
  // The server does the checkout; we reflect the result + any sync banner.
  const selectMode = (next: Mode) => {
    setMode(next);
    setSyncResult(null);
    fetch("/__studio/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    })
      .then((r) => r.json())
      .then((d) => {
        setInfo(d);
        setSyncResult(d.result ?? null);
      })
      .catch(() => setInfo(null));
  };

  // After a run settles, refresh branch/dirty (the run may have changed the tree).
  useEffect(() => {
    if (!open || status === "running" || status === "idle") return;
    let cancelled = false;
    fetch("/__studio/status")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setInfo(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, status]);

  // Reflect the real working tree in the review surface: on open and whenever a
  // run settles (not mid-run). Survives reloads since it reads git, not state.
  useEffect(() => {
    if (open && status !== "running") refreshChanged();
  }, [open, status, refreshChanged]);

  // Stick to the bottom on new output, but only if the user is already near it
  // (so scrolling up to re-read isn't yanked back down).
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log, running]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Re-arm auto-scroll at the start of each run, even if the user had scrolled up.
  useEffect(() => {
    if (status === "running") stickRef.current = true;
  }, [status]);

  // Esc closes the diff modal.
  useEffect(() => {
    if (!showDiff) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDiff(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDiff]);

  const clearPin = () => {
    setPin(null);
    setPinnedEl(null);
  };

  // Esc clears a pin when one is held but we're not mid-select (the picker owns
  // Esc while selecting). Skip if the diff modal is up — that Esc closes it.
  useEffect(() => {
    if (!pin || selecting || showDiff) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearPin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin, selecting, showDiff]);

  // Dock the panel beside the app: push #root left or right by the panel width
  // so content shrinks instead of being covered. Tracks live resizes (width dep);
  // the drag handler suspends the transition so resizing doesn't lag. Reset when closed.
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(cfg.appRootSelector);
    if (!root) return;
    const marginProp = dockLeft ? "marginLeft" : "marginRight";
    const transitionProp = dockLeft ? "margin-left" : "margin-right";
    if (!draggingRef.current) root.style.transition = `${transitionProp} 0.15s ease`;
    root.style[marginProp] = open ? `${width}px` : "";
    return () => {
      root.style[marginProp] = "";
    };
  }, [open, width, cfg.appRootSelector, dockLeft]);

  // Keep the width within bounds when the viewport shrinks (e.g. window resize).
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!open) {
    return (
      <button
        className={`${classes.fab} ${cfg.position.startsWith("top") ? classes.fabTop : ""} ${dockLeft ? classes.fabLeft : ""}`}
        style={accentStyle}
        onClick={() => setOpen(true)}
        aria-label="Open In-App Studio"
      >
        {cfg.buttonLabel}
      </button>
    );
  }

  const send = () => {
    const instruction = input.trim();
    if (!instruction || running) return;
    // Leave Select mode on send so the picker doesn't keep intercepting app
    // clicks during the run (the pin itself stays — it's sticky).
    setSelecting(false);
    // Tell Claude where the user is and what's on screen so "this page" /
    // "the dialog I have open" resolve to the right component.
    const route = window.location.pathname + window.location.search + window.location.hash;
    const screen = captureScreenContext();
    // Pin is sticky: it rides along on follow-up messages until cleared/replaced.
    run({ instruction, route, screen, mode, resumeSessionId: sessionId, pin: pin ?? undefined });
    setInput("");
  };

  return (
    <div className={`${classes.panel} ${dockLeft ? classes.panelLeft : ""}`} style={{ width, ...accentStyle }}>
      <div
        className={`${classes.resizeHandle} ${dockLeft ? classes.resizeHandleRight : ""}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Studio panel"
        title="Drag to resize"
      />
      <div className={classes.header}>
        <span className={classes.title}>◳ In-App Studio</span>
        {cfg.designer && (
          <div className={classes.modeToggle}>
            <button
              className={`${classes.modeBtn} ${mode === "developer" ? classes.modeActive : ""}`}
              onClick={() => selectMode("developer")}
              disabled={running}
              title="Full access: front-end + backend/logic"
            >
              Developer
            </button>
            <button
              className={`${classes.modeBtn} ${mode === "designer" ? classes.modeActive : ""}`}
              onClick={() => selectMode("designer")}
              disabled={running}
              title="Front-end only — backend/data writes are blocked"
            >
              Designer
            </button>
          </div>
        )}
        <span className={classes.spacer} />
        <button className={classes.link} onClick={() => setOpen(false)}>
          close
        </button>
      </div>

      <div className={classes.meta}>
        {info ? (
          <>
            branch <strong>{info.branch ?? "?"}</strong>
            {info.protectedBranch && <span className={classes.warn}> · protected — switch to a feature branch</span>}
            {!!info.behind && <span> · ↓{info.behind} behind</span>}
            {!!info.ahead && <span> · ↑{info.ahead} ahead</span>}
            {info.dirty && <span> · uncommitted changes</span>}
            <br />
            viewing <strong>{window.location.pathname}</strong>
          </>
        ) : (
          "…"
        )}
        {cfg.designer && mode === "designer" && (
          <div className={classes.designerHint}>
            Designer mode — front-end only. Data that doesn't exist yet is mocked and flagged{" "}
            <code>{cfg.designer.stubTag}</code> for a developer to wire up.
          </div>
        )}
      </div>

      {syncResult && SYNC_BANNERS[syncResult] && (
        <div className={classes.syncBanner}>
          <span>⚠ {SYNC_BANNERS[syncResult]}</span>
          <button className={classes.syncBannerX} onClick={() => setSyncResult(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className={classes.log} ref={logRef} onScroll={onLogScroll}>
        {log.length === 0 && !running && (
          <div className={classes.text}>Describe a change to the app. Claude edits the real code; the app hot-reloads.</div>
        )}
        {log.map((e, i) => (
          <div key={i} className={`${classes.entry} ${classes[e.kind]}`}>
            {e.kind === "user" ? (
              `› ${e.text}`
            ) : e.kind === "text" ? (
              <MarkdownText text={e.text} />
            ) : (
              e.text
            )}
          </div>
        ))}
        {running && <div className={`${classes.entry} ${classes.text}`}>working…</div>}
        {error && <div className={`${classes.entry} ${classes.error}`}>{error}</div>}
      </div>

      {changedFiles.length > 0 && (
        <div className={classes.review}>
          <div className={classes.reviewHead}>
            <h4>
              {changedFiles.length} changed file{changedFiles.length === 1 ? "" : "s"} — review before
              committing
            </h4>
            <button className={classes.link} onClick={() => setShowDiff(true)} disabled={!diff}>
              view diff
            </button>
          </div>

          <div className={classes.files}>
            {changedFiles.map((f) => (
              <div key={f.path} className={classes.file}>
                <span className={`${classes.badge} ${classes[`badge_${f.status}`]}`}>
                  {f.status === "new" ? "new" : f.status === "deleted" ? "del" : "mod"}
                </span>
                <span className={classes.filePath}>{f.path}</span>
              </div>
            ))}
          </div>

          {checkResult && (
            <pre className={`${classes.check} ${checkResult.ok ? classes.checkOk : classes.checkFail}`}>
              {checkResult.output}
            </pre>
          )}

          <div className={classes.reviewActions}>
            <button className={classes.btn} onClick={check} disabled={running || busy !== null}>
              {busy === "checking" ? "checking…" : `Check (${cfg.checkLabels.join(" + ")})`}
            </button>
            <button
              className={`${classes.btn} ${classes.danger}`}
              disabled={running || busy !== null}
              onClick={() => {
                if (
                  window.confirm(
                    `Revert ${changedFiles.length} file(s)? Tracked edits are restored to HEAD and new files are deleted. This cannot be undone.`,
                  )
                ) {
                  revert(changedFiles.map((f) => f.path));
                  setShowDiff(false);
                }
              }}
            >
              {busy === "reverting" ? "reverting…" : "Revert all"}
            </button>
            <span className={classes.spacer} />
            <button
              className={`${classes.btn} ${classes.primary}`}
              disabled={running || busy !== null}
              onClick={() => {
                const last = [...log].reverse().find((e) => e.kind === "user")?.text;
                const def = last ? last.replace(/\s+/g, " ").trim().slice(0, 72) : "Studio: update";
                const msg = window.prompt(
                  `Commit & push ${changedFiles.length} file(s) to "${info?.branch ?? "this branch"}"?\n` +
                    `Runs ${cfg.checkLabels.join(" + ")} first — won't commit if it fails.\n\nCommit message:`,
                  def,
                );
                if (msg && msg.trim()) commit(msg.trim(), mode);
              }}
            >
              {busy === "committing" ? "committing…" : "Commit & push"}
            </button>
          </div>
        </div>
      )}

      {/* Outside the changed-files gate so the success banner survives the list
          emptying after a successful commit. */}
      {commitResult && (
        <pre
          className={`${classes.check} ${classes.commitBanner} ${commitResult.ok ? classes.checkOk : classes.checkFail}`}
        >
          {commitResult.ok
            ? `✓ committed ${commitResult.sha} & pushed to ${commitResult.branch}`
            : commitResult.output}
        </pre>
      )}

      <div className={classes.composer}>
        <div className={classes.selectRow}>
          <button
            className={`${classes.selectToggle} ${selecting ? classes.selectActive : ""}`}
            onClick={() => setSelecting((s) => !s)}
            disabled={running}
            title="Click an element on the page to pin it as context for your next message"
          >
            ⌖ {selecting ? "Selecting… (Esc)" : "Select"}
          </button>
          {pin && (
            <span className={classes.pinChip} title={pin.cssPath}>
              <span className={classes.pinChipText}>⌖ {pinLabel(pin)}</span>
              <button className={classes.pinChipX} onClick={clearPin} aria-label="Clear pinned element">
                ✕
              </button>
            </span>
          )}
        </div>
        <textarea
          className={classes.textarea}
          placeholder={sessionId ? "Refine — continues this session…" : "Describe a change to the app…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          disabled={running}
        />
        <div className={classes.row}>
          <button className={`${classes.btn} ${classes.primary}`} onClick={send} disabled={running || !input.trim()}>
            {sessionId ? "Refine" : "Send"}
          </button>
          {running && (
            <button className={`${classes.btn} ${classes.danger}`} onClick={stop}>
              Stop
            </button>
          )}
          <span className={classes.spacer} />
          {sessionId && !running && (
            <button className={classes.link} onClick={reset}>
              ↺ new
            </button>
          )}
        </div>
      </div>

      {showDiff && diff && (
        <div className={classes.diffBackdrop} onClick={() => setShowDiff(false)}>
          <div className={classes.diffModal} onClick={(e) => e.stopPropagation()}>
            <div className={classes.diffModalHead}>
              <span className={classes.title}>
                Diff — {changedFiles.length} file{changedFiles.length === 1 ? "" : "s"} changed
              </span>
              <button className={classes.link} onClick={() => setShowDiff(false)}>
                close ✕
              </button>
            </div>
            <DiffBody text={diff} />
          </div>
        </div>
      )}

      {/* Visual select & annotate overlays (fixed-position, pointer-events:none). */}
      <PinnedOutline el={pinnedEl} cssPath={pin?.cssPath} />
      {selecting && (
        <ElementPicker
          onPick={(target, el) => {
            setPin(target);
            setPinnedEl(el);
            setSelecting(false);
          }}
          onCancel={() => setSelecting(false)}
        />
      )}
    </div>
  );
}
