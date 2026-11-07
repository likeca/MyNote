import { MenuDivider, MenuItem, MenuSection, Popover } from "../components/Popover";
import { COLORS, bgColor, colorLabel, textColor } from "../lib/colors";

/** The text and background colours to pick from: blocks, selected text and table cells. */
export function ColorList({
  anchor,
  placement,
  onPick,
  onClose,
  current,
  only,
}: {
  anchor: HTMLElement;
  placement?: "bottom-start" | "right-start";
  onPick: (attrs: { color?: string; bg?: string }) => void;
  onClose: () => void;
  current?: { color?: string | null; bg?: string | null };
  /** Show just text colours or just backgrounds (the selection toolbar has a button for each). */
  only?: "text" | "bg";
}) {
  return (
    <Popover anchor={anchor} placement={placement} onClose={onClose} className="max-h-[70vh] w-56 overflow-y-auto p-1">
      {only !== "bg" && (
        <>
      <MenuSection label="Text color" />
      {COLORS.map((c) => (
        <MenuItem
          key={`t-${c}`}
          icon={
            <span className="grid size-5 place-items-center rounded border border-line text-sm font-medium" style={{ color: textColor(c) }}>
              A
            </span>
          }
          label={c === "default" ? "Default text" : `${colorLabel(c)} text`}
          right={(current?.color ?? "default") === c ? <span className="text-muted">✓</span> : null}
          onClick={() => onPick({ color: c })}
        />
      ))}
        </>
      )}
      {!only && <MenuDivider />}
      {only !== "text" && (
        <>
      <MenuSection label="Background color" />
      {COLORS.map((c) => (
        <MenuItem
          key={`b-${c}`}
          icon={<span className="size-5 rounded border border-line" style={{ background: bgColor(c) }} />}
          label={c === "default" ? "Default background" : `${colorLabel(c)} background`}
          right={(current?.bg ?? "default") === c ? <span className="text-muted">✓</span> : null}
          onClick={() => onPick({ bg: c })}
        />
      ))}
        </>
      )}
    </Popover>
  );
}

