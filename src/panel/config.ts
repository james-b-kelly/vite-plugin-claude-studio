import { useEffect, useState } from "react";

/** Runtime panel config served by GET /__studio/config (set in vite.config.ts). */
export type PanelConfig = {
  buttonLabel: string;
  accent: string;
  position: "bottom-right" | "top-right" | "bottom-left" | "top-left";
  appRootSelector: string;
  checkLabels: string[];
};

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  buttonLabel: "◳ Studio",
  accent: "#3b6fe0",
  position: "bottom-right",
  appRootSelector: "#root",
  checkLabels: ["lint", "build"],
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
        setConfig({
          ...DEFAULT_PANEL_CONFIG,
          ...panel,
          checkLabels:
            Array.isArray(d.checkLabels) && d.checkLabels.length > 0
              ? d.checkLabels.map(String)
              : DEFAULT_PANEL_CONFIG.checkLabels,
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
