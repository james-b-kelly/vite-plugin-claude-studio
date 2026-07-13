/**
 * In-App Studio — element → source resolution.
 *
 * Given a DOM node the user clicked in the running app, resolve a precise
 * "pin" target for Claude: the React source location (file + line) and nearest
 * named component via the dev-only fiber, plus a DOM fallback (tag/id/classes/
 * text/cssPath) that is ALWAYS captured. If the fiber source is missing — host
 * nodes, portals, memoised wrappers, or a production-style build with no
 * `_debugSource` — we degrade to the DOM fallback rather than mis-target.
 *
 * Fiber internals (`_debugSource`, `_debugOwner`) only exist in React dev
 * builds (Babel/Vite inject them). The Studio is dev-only, so they're present.
 */

export type PinTarget = {
  /** Nearest named component that rendered this element (from `_debugOwner`). */
  component?: string;
  /** Source file the element's JSX lives in (repo-relative when possible). */
  file?: string;
  /** Line in `file` where the JSX tag is written. */
  line?: number;
  /** DOM fallback — always present. */
  tag: string;
  id?: string;
  classes?: string;
  /** Short visible-text snippet, to disambiguate similar elements. */
  text?: string;
  /** A CSS selector path from a stable ancestor, for re-acquisition. */
  cssPath: string;
};

type Fiber = {
  type?: unknown;
  return?: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number } | null;
  _debugOwner?: Fiber | null;
};

/** React stores the fiber on the DOM node under a `__reactFiber$<rand>` key. */
function getFiber(node: Node): Fiber | null {
  for (const key in node) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as unknown as Record<string, Fiber>)[key] ?? null;
    }
  }
  return null;
}

function displayNameOf(type: unknown): string | undefined {
  if (!type || typeof type === "string") return undefined; // host nodes have string types
  const t = type as { displayName?: string; name?: string; render?: { name?: string } };
  // forwardRef/memo wrap the real component in `.render` / `.type`.
  return t.displayName || t.name || t.render?.name || undefined;
}

/** Strip an absolute dev path down to a repo-relative `src/...` path for Claude. */
function relativizeFile(file: string): string {
  const i = file.lastIndexOf("/src/");
  return i >= 0 ? file.slice(i + 1) : file;
}

/** Build a short, reasonably-stable CSS selector path (id short-circuits). */
function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break; // an id is unique enough to anchor the path
    }
    // `localName` (not `tagName.toLowerCase()`) keeps case-sensitive SVG tags valid.
    let sel = node.localName;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.localName === node!.localName);
      if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
  }
  return parts.join(" > ");
}

export function resolvePinTarget(el: Element): PinTarget {
  // DOM fallback — always captured.
  const tag = el.tagName.toLowerCase();
  const id = el.id || undefined;
  const classes = typeof el.className === "string" && el.className.trim() ? el.className.trim() : undefined;
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  const target: PinTarget = { tag, id, classes, text, cssPath: cssPath(el) };

  const fiber = getFiber(el);

  // File/line (legacy): React ≤18 carries `_debugSource` ({fileName, lineNumber})
  // on the fiber. React 19 REMOVED this field — the JSX source now lives in a
  // captured stack (`_debugStack`/`_debugTask`), not a clean {file,line}. We read
  // `_debugSource` when present and otherwise leave file/line unset (the DOM
  // cssPath fallback still re-acquires the element) rather than parse a stack.
  for (let f = fiber; f; f = f.return ?? null) {
    const src = f._debugSource;
    if (!src?.fileName) continue;
    target.file = relativizeFile(src.fileName);
    if (typeof src.lineNumber === "number") target.line = src.lineNumber;
    break;
  }

  // Component name (works on React 18 AND 19): `_debugOwner` is still populated
  // in dev builds, so the nearest named component is recoverable independently of
  // `_debugSource`. Resolved separately from file/line above so React 19 — where
  // `_debugSource` is always absent — still surfaces the owning component instead
  // of degrading the whole label to the DOM path. Prefer the `_debugOwner` chain
  // (who authored this JSX); fall back to the `return` render-tree chain when no
  // owner is present (e.g. host-only roots).
  for (let f: Fiber | null = fiber; f; f = f._debugOwner ?? f.return ?? null) {
    const name = displayNameOf(f.type);
    if (name) {
      target.component = name;
      break;
    }
  }

  return target;
}

/** One-line chip label, e.g. `⌖ <button> · EventModal.tsx:42`. */
export function pinLabel(pin: PinTarget): string {
  const where = pin.file
    ? `${pin.file.split("/").pop()}${pin.line ? `:${pin.line}` : ""}`
    : pin.component || pin.cssPath;
  return `<${pin.tag}> · ${where}`;
}
