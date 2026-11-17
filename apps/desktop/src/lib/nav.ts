/**
 * How a page is opened: in the current tab, (⌘/Ctrl-click, middle-click) in a new one, or (⌥-click,
 * "Open side by side") on the right side of a split view.
 */
export type OpenOptions = { newTab?: boolean; side?: boolean };

/** Whether a click asks for a new tab: ⌘-click on macOS, Ctrl-click elsewhere, or a middle-click. */
export const wantsNewTab = (e: { metaKey: boolean; ctrlKey: boolean; button?: number }) => e.metaKey || e.ctrlKey || e.button === 1;
