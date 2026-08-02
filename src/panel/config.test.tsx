import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PANEL_CONFIG, usePanelConfig } from "./config";

function Probe() {
  const cfg = usePanelConfig();
  return (
    <div data-testid="cfg">{`${cfg.buttonLabel}|${cfg.checkLabels.join("+")}|${cfg.designer ? cfg.designer.branch : "no-designer"}`}</div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usePanelConfig", () => {
  it("starts with defaults and adopts the served config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          panel: { buttonLabel: "✦ Dev", accent: "#f00", position: "top-right", appRootSelector: "#app" },
          checkLabels: ["typecheck"],
          designer: { branch: "develop-design", stubTag: "@design-stub" },
        }),
      })) as unknown as typeof fetch,
    );
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("cfg")).toHaveTextContent("✦ Dev|typecheck|develop-design"),
    );
  });

  it("keeps defaults when the endpoint is unavailable or malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
    render(<Probe />);
    expect(screen.getByTestId("cfg")).toHaveTextContent(
      `${DEFAULT_PANEL_CONFIG.buttonLabel}|lint+build|no-designer`,
    );
  });
});
