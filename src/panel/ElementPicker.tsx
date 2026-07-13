import { useEffect, useRef, useState } from "react";
import { resolvePinTarget, type PinTarget } from "./fiberSource";
import classes from "./StudioPanel.module.css";

/**
 * In-App Studio — visual element picker.
 *
 * `ElementPicker` is mounted only while Select mode is active: it puts the page
 * in a crosshair, outlines the element under the pointer with a component/tag
 * label, and on click pins that element (resolving its source via the fiber).
 * `PinnedOutline` draws the persistent outline for the currently pinned element.
 *
 * Both are dev-only overlays living in the Studio's own React root. They render
 * `position: fixed` boxes with `pointer-events: none`, and read the live app DOM
 * via document-level capture listeners — no app code, no endpoint, read-only.
 */

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Is this node part of the Studio panel itself (so we never pin our own UI)? */
function inStudio(node: EventTarget | null): boolean {
  return node instanceof Node && !!document.getElementById("__studio_root__")?.contains(node);
}

export function ElementPicker({
  onPick,
  onCancel,
}: {
  onPick: (target: PinTarget, el: Element) => void;
  onCancel: () => void;
}) {
  const [hover, setHover] = useState<{ rect: Rect; label: string } | null>(null);
  // Keep callbacks current without re-subscribing the global listeners.
  const cbRef = useRef({ onPick, onCancel });
  cbRef.current = { onPick, onCancel };

  useEffect(() => {
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "crosshair";

    const onMove = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || inStudio(el)) {
        setHover(null);
        return;
      }
      const t = resolvePinTarget(el);
      setHover({ rect: rectOf(el), label: t.component ? `<${t.component}>` : `<${t.tag}>` });
    };

    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || inStudio(el)) return; // let clicks on the panel (e.g. toggle off) work
      e.preventDefault();
      e.stopPropagation();
      cbRef.current.onPick(resolvePinTarget(el), el);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cbRef.current.onCancel();
      }
    };

    // Capture phase so we intercept before the app handles the click.
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.cursor = prevCursor;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  if (!hover) return null;
  const labelAbove = hover.rect.top > 22;
  return (
    <div
      className={classes.pickHighlight}
      style={{
        top: hover.rect.top,
        left: hover.rect.left,
        width: hover.rect.width,
        height: hover.rect.height,
      }}
    >
      <span
        className={classes.pickLabel}
        style={labelAbove ? { top: -20 } : { bottom: -20 }}
      >
        {hover.label}
      </span>
    </div>
  );
}

export function PinnedOutline({ el, cssPath }: { el: Element | null; cssPath?: string }) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!el && !cssPath) {
      setRect(null);
      return;
    }
    let raf = 0;
    let current: Element | null = el;
    const tick = () => {
      // Re-acquire if the node was replaced (e.g. by an HMR re-render).
      if ((!current || !current.isConnected) && cssPath) {
        try {
          current = document.querySelector(cssPath);
        } catch {
          current = null;
        }
      }
      setRect(current && current.isConnected ? rectOf(current) : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el, cssPath]);

  if (!rect) return null;
  return (
    <div
      className={classes.pinOutline}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    />
  );
}
