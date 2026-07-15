import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioPanel } from "./StudioPanel";

/**
 * Repro for the reported bug: make changes → review area shows → close panel →
 * reopen → review area is gone. The working tree is unchanged across this, so on
 * reopen the area MUST come back.
 */

function mockFetch(changedFiles: Array<{ path: string; status: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url.includes("/__studio/config")
        ? {}
        : url.includes("/__studio/status")
          ? { branch: "develop", protectedBranch: false, dirty: changedFiles.length > 0 }
          : url.includes("/__studio/diff")
            ? { files: changedFiles, diff: changedFiles.length ? "diff --git a/x b/x\n+added\n" : "" }
            : {};
    return {
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

function mockFetchWithConfig(
  panel: Record<string, unknown>,
  changedFiles: Array<{ path: string; status: string }> = [],
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url.includes("/__studio/config")
        ? { panel, checkLabels: ["lint", "build"] }
        : url.includes("/__studio/status")
          ? { branch: "develop", protectedBranch: false, dirty: false }
          : url.includes("/__studio/diff")
            ? { files: changedFiles, diff: "" }
            : {};
    return {
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

describe("StudioPanel FAB position classes", () => {
  beforeEach(() => {
    const store = new Map<string, string>(); // start closed
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("adds fabLeft class to FAB when position is bottom-left", async () => {
    vi.stubGlobal("fetch", mockFetchWithConfig({ position: "bottom-left" }));

    render(<StudioPanel />);
    const fab = screen.getByLabelText("Open In-App Studio");

    // After config fetch resolves, fabLeft should be applied
    await waitFor(() => expect(fab.className).toContain("fabLeft"));
    expect(fab.className).not.toContain("fabTop");
  });

  it("adds fabTop and fabLeft classes when position is top-left", async () => {
    vi.stubGlobal("fetch", mockFetchWithConfig({ position: "top-left" }));

    render(<StudioPanel />);
    const fab = screen.getByLabelText("Open In-App Studio");

    await waitFor(() => expect(fab.className).toContain("fabLeft"));
    await waitFor(() => expect(fab.className).toContain("fabTop"));
  });

  it("does not add fabLeft for bottom-right", async () => {
    // Custom buttonLabel proves the served config was adopted before the
    // negative assertions run — otherwise they'd pass vacuously against the
    // defaults, before the /__studio/config fetch resolved.
    vi.stubGlobal(
      "fetch",
      mockFetchWithConfig({ position: "bottom-right", buttonLabel: "✦ Cfg" }),
    );

    render(<StudioPanel />);
    const fab = screen.getByLabelText("Open In-App Studio");

    await waitFor(() => expect(fab).toHaveTextContent("✦ Cfg"));
    expect(fab.className).not.toContain("fabLeft");
    expect(fab.className).not.toContain("fabTop");
  });

  it("adds fabTop but not fabLeft for top-right", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithConfig({ position: "top-right", buttonLabel: "✦ Cfg" }),
    );

    render(<StudioPanel />);
    const fab = screen.getByLabelText("Open In-App Studio");

    await waitFor(() => expect(fab).toHaveTextContent("✦ Cfg"));
    expect(fab.className).toContain("fabTop");
    expect(fab.className).not.toContain("fabLeft");
  });
});

describe("StudioPanel review area across close/reopen", () => {
  beforeEach(() => {
    const store = new Map<string, string>([["studio:v1:open", "1"]]); // start opened
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the changed-files area after closing and reopening", async () => {
    vi.stubGlobal("fetch", mockFetch([{ path: "src/foo/Bar.tsx", status: "modified" }]));

    render(<StudioPanel />);

    // Area appears (refreshChanged on open pulls /diff)
    await screen.findByText(/1 changed file/);
    expect(await screen.findByText("Check (lint + build)")).toBeInTheDocument();

    // Close → FAB
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByText(/changed file/)).toBeNull();

    // Reopen via FAB
    fireEvent.click(screen.getByLabelText("Open In-App Studio"));

    // BUG: this should still be present
    await waitFor(() => expect(screen.getByText(/1 changed file/)).toBeTruthy());
  });
});
