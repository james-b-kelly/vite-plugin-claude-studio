import { useEffect, useState } from "react";

/** Runtime panel config served by GET /__studio/config (set in vite.config.ts). */
export type PanelConfig = {
  buttonLabel: string;
  accent: string;
  position: "bottom-right" | "top-right" | "bottom-left" | "top-left";
  appRootSelector: string;
  checkLabels: string[];
  /** Present iff the plugin has Designer mode configured — enables the mode toggle. */
  designer: { branch: string; stubTag: string } | null;
};

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  buttonLabel: "◳ Studio",
  accent: "#3b6fe0",
  position: "bottom-right",
  appRootSelector: "#root",
  checkLabels: ["lint", "build"],
  designer: null,
};

/** Fetch the served config once per mount; fall back to defaults on any failure. */
export function usePanelConfig(): PanelConfig {
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG);
  useEffect(() => {
    let cancelled = false;
    fetch("/__studio/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || typeof d !== "object") return;
        const panel = (d.panel ?? {}) as Partial<PanelConfig>;
        const designer =
          d.designer && typeof d.designer.branch === "string"
            ? { branch: d.designer.branch, stubTag: String(d.designer.stubTag ?? "@design-stub") }
            : null;
        setConfig({
          ...DEFAULT_PANEL_CONFIG,
          ...panel,
          checkLabels:
            Array.isArray(d.checkLabels) && d.checkLabels.length > 0
              ? d.checkLabels.map(String)
              : DEFAULT_PANEL_CONFIG.checkLabels,
          designer,
        });
      })
      .catch(() => {
        /* endpoint absent (e.g. tests) — defaults apply */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
