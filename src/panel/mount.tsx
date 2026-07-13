import { createRoot } from "react-dom/client";
import { StudioPanel } from "./StudioPanel";

/**
 * Mounts the In-App Studio panel into its own DOM root, separate from the app
 * tree. Called only from an `import.meta.env.DEV` dead-branch in the host
 * app's entry module, so the whole panel module graph is tree-shaken out of
 * production builds.
 */
export function mountStudioPanel(): void {
  if (document.getElementById("__studio_root__")) return;
  const el = document.createElement("div");
  el.id = "__studio_root__";
  document.body.appendChild(el);
  createRoot(el).render(<StudioPanel />);
}
