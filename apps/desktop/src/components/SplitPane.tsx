import { useRef, useState, type ReactNode } from "react";

const RATIO_KEY = "split-ratio";
const MIN_PX = 320;

const savedRatio = () => {
  const n = Number(localStorage.getItem(RATIO_KEY));
  return n > 0.15 && n < 0.85 ? n : 0.5;
};

/**
 * The right side of a split view: a second page beside the one on the left, with a divider between
 * them that drags to share the width (remembered). Both sides are full pages you can edit.
 */
export function SplitPane({ children }: { children: ReactNode }) {
  const [ratio, setRatio] = useState(savedRatio);
  const pane = useRef<HTMLDivElement>(null);

  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = pane.current!.parentElement!.getBoundingClientRect();
    let next = ratio;
    const move = (ev: PointerEvent) => {
      // The right side's share of the area: never narrower than MIN_PX on either side.
      const right = box.right - ev.clientX;
      const clamped = Math.min(box.width - MIN_PX, Math.max(MIN_PX, right));
      next = clamped / box.width;
      setRatio(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      localStorage.setItem(RATIO_KEY, String(next));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={pane} style={{ width: `${ratio * 100}%` }} className="split-pane relative flex h-full shrink-0 border-l border-line bg-surface">
      <div onPointerDown={drag} onDoubleClick={() => (setRatio(0.5), localStorage.setItem(RATIO_KEY, "0.5"))} title="Drag to resize · double-click for half and half" className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize hover:bg-[var(--blue)]/30" />
      {children}
    </div>
  );
}
