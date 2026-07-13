import { describe, it, expect } from "vitest"
import { resolvePinTarget, pinLabel } from "./fiberSource"

// Minimal fiber shape the resolver reads. We attach a synthetic fiber to a real
// DOM node under the `__reactFiber$<rand>` key that getFiber() scans for.
type FakeFiber = {
  type?: unknown
  return?: FakeFiber | null
  _debugSource?: { fileName?: string; lineNumber?: number } | null
  _debugOwner?: FakeFiber | null
}

function withFiber(el: Element, fiber: FakeFiber): Element {
  ;(el as unknown as Record<string, FakeFiber>)["__reactFiber$test"] = fiber
  return el
}

function ToggleChip() {}

describe("resolvePinTarget", () => {
  it("always captures the DOM fallback (tag/classes/text/cssPath)", () => {
    const el = document.createElement("button")
    el.className = "px-4 py-2"
    el.textContent = "Sparkling Skylands"
    const pin = resolvePinTarget(el)
    expect(pin.tag).toBe("button")
    expect(pin.classes).toContain("px-4")
    expect(pin.text).toBe("Sparkling Skylands")
    expect(pin.cssPath).toContain("button")
  })

  it("resolves the component name via _debugOwner when _debugSource is absent (React 19)", () => {
    // Host <button> fiber (string type) owned by the ToggleChip component fiber —
    // no _debugSource anywhere, mirroring React 19.
    const el = document.createElement("button")
    const ownerFiber: FakeFiber = { type: ToggleChip, _debugOwner: null, return: null }
    withFiber(el, { type: "button", _debugOwner: ownerFiber, return: null })

    const pin = resolvePinTarget(el)
    expect(pin.component).toBe("ToggleChip")
    expect(pin.file).toBeUndefined() // no _debugSource → no file/line, by design
  })

  it("still reads file/line from legacy _debugSource when present (React ≤18)", () => {
    const el = document.createElement("button")
    const ownerFiber: FakeFiber = { type: ToggleChip, _debugOwner: null, return: null }
    withFiber(el, {
      type: "button",
      _debugOwner: ownerFiber,
      _debugSource: { fileName: "/repo/src/components/ui/ToggleChip.tsx", lineNumber: 29 },
      return: null,
    })

    const pin = resolvePinTarget(el)
    expect(pin.file).toBe("src/components/ui/ToggleChip.tsx")
    expect(pin.line).toBe(29)
    expect(pin.component).toBe("ToggleChip")
  })

  it("pinLabel prefers component over the cssPath when no file is known", () => {
    const pin = { tag: "button", cssPath: "#root > div > button", component: "ToggleChip" }
    expect(pinLabel(pin)).toBe("<button> · ToggleChip")
  })
})
