/**
 * Snapshots the visible UI from the live DOM so the In-App Studio can tell Claude
 * what's on screen — chiefly any open dialog/modal/drawer and its text — letting
 * requests like "the dialog I have open" or "this filter" resolve to a component.
 */
export function captureScreenContext(): string {
  const parts: string[] = [];

  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
  ).filter((d) => d.getClientRects().length > 0);

  dialogs.forEach((d, i) => {
    const title =
      d.querySelector('[class*="itle"], h1, h2, header')?.textContent?.trim().slice(0, 120) ?? "";
    const text = (d.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
    parts.push(`Open dialog ${i + 1}${title ? ` — "${title}"` : ""}:\n${text}`);
  });

  const heading = document.querySelector("h1")?.textContent?.trim();
  if (heading) parts.push(`Page heading: ${heading.slice(0, 120)}`);

  return parts.join("\n\n").slice(0, 6000);
}
