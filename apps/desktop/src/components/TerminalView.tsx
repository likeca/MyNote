import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { open as openLink } from "../lib/links";
import { useSettings } from "../lib/settings";

/** A terminal tab's path: `@terminal/<n>`, one shell each. */
export const TERMINAL_PREFIX = "@terminal/";
export const isTerminalPath = (path: string | null | undefined)=> !!path?.startsWith(TERMINAL_PREFIX);
let terminals = 0;
export const newTerminalPath = () => `${TERMINAL_PREFIX}${++terminals}`;

/** The 16 ANSI colours, readable on the page's own background in each mode. */
const ANSI_LIGHT: ITheme = {
  black: "#3b3a36", red: "#c4362b", green: "#2f7d32", yellow: "#9a6700", blue: "#1f6fc5", magenta: "#a23cb0", cyan: "#1b7f8c", white: "#8a8780",
  brightBlack: "#6f6c66", brightRed: "#e0483c", brightGreen: "#3c9a40", brightYellow: "#b88200", brightBlue: "#2f86e0", brightMagenta: "#bf52cc", brightCyan: "#2496a5", brightWhite: "#a9a6a0",
};
const ANSI_DARK: ITheme = {
  black: "#4a4845", red: "#f0736a", green: "#7cc77f", yellow: "#e5c06a", blue: "#6aa8f0", magenta: "#d38ce0", cyan: "#6cc6d1", white: "#d4d2ce",
  brightBlack: "#7a7773", brightRed: "#ff8f86", brightGreen: "#98d99a", brightYellow: "#f2d58c", brightBlue: "#8cbcf6", brightMagenta: "#e2a6ec", brightCyan: "#8ad6df", brightWhite: "#f4f3f1",
};

/** The terminal's colours, from the page's theme (its background, text and accent). */
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
    background: v("--surface"),
    foreground: v("--ink"),
    cursor: v("--ink"),
    cursorAccent: v("--surface"),
    selectionBackground: dark ? "rgba(255, 255, 255, 0.22)" : "rgba(35, 131, 226, 0.22)",
  };
}

const FONT = 13;

/**
 * A terminal tab: the user's shell in the workspace folder. It stays alive (hidden) while other
 * tabs are shown, and ends when its tab closes. Once the shell exits, Enter starts a new one.
 */
export function TerminalView({ active }: { active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const { textZoom } = useSettings();
  const zoom = useRef(textZoom);
  zoom.current = textZoom;

  useEffect(() => {
    const t = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: Math.round(FONT * zoom.current),
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: theme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_, url) => openLink(url)));
    t.open(box.current!);
    term.current = t;
    fit.current = f;
    if (box.current!.offsetParent) f.fit();

    // The shell: `session` while it runs; after it ends, Enter starts another.
    let session: number | null = null;
    let disposed = false;
    const start = () => {
      api
        .terminalOpen(
          t.cols,
          t.rows,
          (bytes) => t.write(bytes),
          () => {
            session = null;
            if (!disposed) t.write("\r\n\x1b[2m[Process completed. Press Enter to start a new shell.]\x1b[0m\r\n");
          },
        )
        .then(
          (id) => {
            // The tab closed while the shell was starting.
            if (disposed) void api.terminalClose(id);
            else session = id;
          },
          (e) => t.write(`\x1b[31mCouldn't start the shell: ${e}\x1b[0m\r\n`),
        );
    };
    start();
    const input = t.onData((data) => {
      if (session !== null) api.terminalWrite(session, data).catch(() => {});
      else if (data === "\r") (t.reset(), start());
    });
    const resized = t.onResize(({ cols, rows }) => session !== null && api.terminalResize(session, cols, rows));
    // Fits the window (and the sidebar opening or closing); not while hidden in the background.
    const observer = new ResizeObserver(() => box.current?.offsetParent && f.fit());
    observer.observe(box.current!);
    // The theme follows the app's (light / dark, palette).
    const themed = new MutationObserver(() => (t.options.theme = theme()));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "data-black"] });
    return () => {
      disposed = true;
      observer.disconnect();
      themed.disconnect();
      input.dispose();
      resized.dispose();
      if (session !== null) api.terminalClose(session);
      t.dispose();
      term.current = fit.current = null;
    };
  }, []);

  // The page text zoom (⌘+ / ⌘−) sizes the terminal's text too.
  useEffect(() => {
    if (!term.current) return;
    term.current.options.fontSize = Math.round(FONT * textZoom);
    if (box.current?.offsetParent) fit.current?.fit();
  }, [textZoom]);

  // Shown again: fit what may have changed meanwhile, and type into it.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => (fit.current?.fit(), term.current?.focus()));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div data-terminal className={`absolute inset-0 bg-surface py-2 pl-3 ${active ? "" : "invisible"}`}>
      <div ref={box} className="size-full" />
    </div>
  );
}
