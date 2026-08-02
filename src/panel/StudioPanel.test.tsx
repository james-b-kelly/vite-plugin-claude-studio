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

describe("StudioPanel designer mode", () => {
  const designer = { branch: "develop-design", stubTag: "@design-stub" };

  function mockDesignerFetch(opts: { statusBranch?: string; syncResult?: string } = {}) {
    const { statusBranch = "develop", syncResult = "synced" } = opts;
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const body = url.includes("/__studio/config")
        ? { panel: {}, checkLabels: ["lint", "build"], designer }
        : url.includes("/__studio/status")
          ? { branch: statusBranch, protectedBranch: false, dirty: false }
          : url.includes("/__studio/sync")
            ? { branch: designer.branch, protectedBranch: false, created: false, dirty: false, result: syncResult }
            : url.includes("/__studio/diff")
              ? { files: [], diff: "" }
              : {};
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
        // A generate stream that ends immediately — enough to capture the request body.
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    const store = new Map<string, string>([["studio:v1:open", "1"]]);
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

  it("hides the mode toggle when designer is not configured", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<StudioPanel />);
    await screen.findByText(/branch/);
    expect(screen.queryByText("Designer")).toBeNull();
    expect(screen.queryByText("Developer")).toBeNull();
  });

  it("switching to Designer syncs the branch and shows the stub-tag hint", async () => {
    const fetchMock = mockDesignerFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<StudioPanel />);
    fireEvent.click(await screen.findByText("Designer"));
    await waitFor(() => {
      const syncCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/__studio/sync"));
      expect(syncCall).toBeTruthy();
      expect(JSON.parse(String(syncCall![1]?.body))).toEqual({ mode: "designer" });
    });
    expect(await screen.findByText(/@design-stub/)).toBeInTheDocument();
  });

  it("surfaces a sticky banner when the base merge conflicts", async () => {
    vi.stubGlobal("fetch", mockDesignerFetch({ syncResult: "conflict" }));
    render(<StudioPanel />);
    fireEvent.click(await screen.findByText("Designer"));
    expect(await screen.findByText(/couldn't auto-merge/)).toBeInTheDocument();
  });

  it("starts in Designer mode when already on the design branch", async () => {
    vi.stubGlobal("fetch", mockDesignerFetch({ statusBranch: "develop-design" }));
    render(<StudioPanel />);
    const designerBtn = await screen.findByText("Designer");
    await waitFor(() => expect(designerBtn.className).toContain("modeActive"));
  });

  it("seeds the mode from localStorage before any network round-trip (HMR remount safety)", async () => {
    // A remount mid-designer-session must not fall back to ungated developer
    // mode while /__studio/config and /__studio/status are still in flight.
    localStorage.setItem("studio:v1:mode", "designer");
    const pending = new Promise<never>(() => {}); // status/diff never resolve
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/__studio/config")) {
          return {
            ok: true,
            json: async () => ({ panel: {}, checkLabels: ["lint"], designer }),
          } as unknown as Response;
        }
        return pending as never;
      }),
    );
    render(<StudioPanel />);
    const designerBtn = await screen.findByText("Designer");
    expect(designerBtn.className).toContain("modeActive");
  });

  it("never sends designer mode when the profile is not configured, even with stale storage", async () => {
    localStorage.setItem("studio:v1:mode", "designer");
    // Config has NO designer block; generate gets a stream that ends immediately.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const body = url.includes("/__studio/status")
        ? { branch: "develop", protectedBranch: false, dirty: false }
        : url.includes("/__studio/diff")
          ? { files: [], diff: "" }
          : {};
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StudioPanel />);
    await screen.findByText(/branch/);
    fireEvent.change(screen.getByPlaceholderText(/Describe a change/), { target: { value: "tweak" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => {
      const genCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/__studio/generate"));
      expect(genCall).toBeTruthy();
      expect(JSON.parse(String(genCall![1]?.body)).mode).toBe("developer");
    });
  });

  it("sends the active mode with a generate request", async () => {
    const fetchMock = mockDesignerFetch({ statusBranch: "develop-design" });
    vi.stubGlobal("fetch", fetchMock);
    render(<StudioPanel />);
    const designerBtn = await screen.findByText("Designer");
    await waitFor(() => expect(designerBtn.className).toContain("modeActive"));
    fireEvent.change(screen.getByPlaceholderText(/Describe a change/), {
      target: { value: "make the header blue" },
    });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => {
      const genCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/__studio/generate"));
      expect(genCall).toBeTruthy();
      expect(JSON.parse(String(genCall![1]?.body)).mode).toBe("designer");
    });
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
