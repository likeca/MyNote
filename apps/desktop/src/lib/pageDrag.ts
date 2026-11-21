/**
 * A page dragged from the sidebar, out over a page's text: the sidebar reports where the pointer is
 * (`move`), lets go (`drop`) or stops (`end`), and the editor under the pointer answers by setting
 * `handled` (it shows where a link would go, and puts one there on `drop`). See editor/pageDrop.ts.
 */
export const PAGE_DRAG = "mynote:page-drag";

export type PageDrag = { phase: "move" | "drop" | "end"; x: number; y: number; path: string; handled: boolean };

/** Tells the pages about the drag; whether one of them takes it. */
export function sendPageDrag(phase: PageDrag["phase"], x: number, y: number, path: string): boolean {
  const detail: PageDrag = { phase, x, y, path, handled: false };
  window.dispatchEvent(new CustomEvent(PAGE_DRAG, { detail }));
  return detail.handled;
}
