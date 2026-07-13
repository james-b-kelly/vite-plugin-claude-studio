import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  afterEach(() => vi.restoreAllMocks());

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
