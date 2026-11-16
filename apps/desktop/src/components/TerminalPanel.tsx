import { SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalView";

const WIDTH_KEY = "terminal-panel-width";
const MIN = 320;
const DEFAULT = 520;

const savedWidth = () => {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n >= MIN ? n : DEFAULT;
};

/**
 * A terminal beside the page, for an AI agent (or anything else) to run next to your notes. One
 * shell for the whole window, in the workspace folder: it keeps running while you switch pages and
 * while the panel is closed, and ends when MyNote quits. Drag its left edge to resize it.
 */
export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [width, setWidth] = useState(savedWidth);
  // Started on first opening, then kept: closing the panel hides it without ending the shell.
  const [started, setStarted] = useState(open);
  useEffect(() => void (open && setStarted(true)), [open]);
  const panel = useRef<HTMLElement>(null);

  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    const right = panel.current!.getBoundingClientRect().right;
    const max = () => Math.max(MIN, window.innerWidth * 0.7);
    let next = width;
    const move = (ev: PointerEvent) => {
      next = Math.round(Math.min(max(), Math.max(MIN, right - ev.clientX)));
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      localStorage.setItem(WIDTH_KEY, String(next));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!started) return null;
  return (
    <aside ref={panel} style={{ width }} className={`relative h-full shrink-0 flex-col border-l border-line bg-surface ${open ? "flex" : "hidden"}`}>
      <div onPointerDown={resize} title="Drag to resize" className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-[var(--blue)]/30" />
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 px-4">
        <SquareTerminal size={15} className="text-faint" />
        <span className="flex-1 text-sm font-medium text-ink">Terminal</span>
        <button onClick={onClose} title="Close (⌘J) · the shell keeps running" className="rounded p-1 text-faint hover:bg-hover">
          <X size={15} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalView active={open} />
      </div>
    </aside>
  );
}
