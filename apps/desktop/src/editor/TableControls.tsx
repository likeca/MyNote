import { message } from "@tauri-apps/plugin-dialog";
import type { ChainedCommands, Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  Database,
  Eraser,
  GripHorizontal,
  GripVertical,
  MoveHorizontal,
  Palette,
  PanelLeft,
  PanelTop,
  Plus,
  StretchHorizontal,
  Trash2,
} from "lucide-react";
import { useContext, useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuDivider, MenuItem, MenuSection, Popover } from "../components/Popover";
import { PageContext } from "./blocks";
import { ColorList } from "./ColorList";
import {
  cellColor,
  clearCells,
  colorCells,
  colorTable,
  duplicateColumn,
  duplicateRow,
  focusCell,
  headersOf,
  moveColumn,
  moveRow,
  refresh,
  resizeColumns,
  resizeRows,
  selectLine,
  setFit,
  setHeader,
  tableAround,
  tableToDatabase,
  type TableRef,
} from "./table";

/** An on/off mark at the end of a menu row. */
const Toggle = ({ on }: { on: boolean }) => (
  <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-[var(--blue)]" : "bg-[var(--line-strong)]"}`}>
    <span className={`absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform ${on ? "translate-x-3" : ""}`} />
  </span>
);

const currentTable = (editor: Editor) => tableAround(editor.state.doc, editor.state.selection.from);

/**
 * The table's own options: its headers, width, colour and turning it into a database. In its block
 * menu (the handle beside it) and its right-click menu.
 */
export function TableOptions({ editor, table, onDone, color = false }: { editor: Editor; table: TableRef; onDone: () => void; color?: boolean }) {
  const page = useContext(PageContext);
  const [colors, setColors] = useState<HTMLElement | null>(null);
  const headers = headersOf(table.node);
  const done = (fn: () => void) => () => (fn(), onDone());
  return (
    <>
      <MenuItem icon={<PanelTop size={15} />} label="Header row" right={<Toggle on={headers.row} />} onClick={done(() => setHeader(editor, table, "row", !headers.row))} />
      <MenuItem icon={<PanelLeft size={15} />} label="Header column" right={<Toggle on={headers.column} />} onClick={done(() => setHeader(editor, table, "column", !headers.column))} />
      <MenuItem icon={<StretchHorizontal size={15} />} label="Fit to page width" right={<Toggle on={!!table.node.attrs.fit} />} onClick={done(() => setFit(editor, table, !table.node.attrs.fit))} />
      {color && <MenuItem icon={<Palette size={15} />} label="Color" right={<ChevronRight size={14} className="text-faint" />} onClick={(e) => setColors(e.currentTarget)} />}
      <MenuItem
        icon={<Database size={15} />}
        label="Turn into database"
        onClick={done(() => {
          tableToDatabase(editor, table, page).catch((e) => message(`Couldn't turn the table into a database: ${e}`, { title: "MyNote", kind: "error" }));
        })}
      />
      {colors && (
        <ColorList anchor={colors} placement="right-start" onClose={() => setColors(null)} onPick={(pick) => (colorTable(editor, table, cellColor(pick)), setColors(null), onDone())} />
      )}
    </>
  );
}

/** Right-click in a table: the cells (colour, clear), rows and columns, and the table. */
export function TableMenu({ editor, at, onClose }: { editor: Editor; at: DOMRect; onClose: () => void }) {
  const [colors, setColors] = useState<HTMLElement | null>(null);
  const table = currentTable(editor);
  const run = (fn: (c: ChainedCommands) => ChainedCommands) => () => {
    fn(editor.chain().focus()).run();
    onClose();
  };
  const several = editor.state.selection instanceof CellSelection;
  return (
    <Popover anchor={at} onClose={onClose} className="w-60 p-1">
      <MenuSection label={several ? "Cells" : "Cell"} />
      <MenuItem icon={<Palette size={15} />} label="Color" right={<ChevronRight size={14} className="text-faint" />} onClick={(e) => setColors(e.currentTarget)} />
      <MenuItem icon={<Eraser size={15} />} label="Clear contents" onClick={() => (clearCells(editor), onClose())} />
      <MenuDivider />
      <MenuItem icon={<ArrowUp size={15} />} label="Insert row above" onClick={run((c) => c.addRowBefore())} />
      <MenuItem icon={<ArrowDown size={15} />} label="Insert row below" onClick={run((c) => c.addRowAfter())} />
      <MenuItem icon={<ArrowLeft size={15} />} label="Insert column left" onClick={run((c) => c.addColumnBefore())} />
      <MenuItem icon={<ArrowRight size={15} />} label="Insert column right" onClick={run((c) => c.addColumnAfter())} />
      <MenuItem icon={<Trash2 size={15} />} label="Delete row" danger onClick={run((c) => c.deleteRow())} />
      <MenuItem icon={<Trash2 size={15} />} label="Delete column" danger onClick={run((c) => c.deleteColumn())} />
      {table && (
        <>
          <MenuDivider />
          <MenuSection label="Table" />
          <TableOptions editor={editor} table={table} onDone={onClose} />
          <MenuItem icon={<MoveHorizontal size={15} />} label="Reset column widths" onClick={() => (resetWidths(editor), onClose())} />
          <MenuItem icon={<Trash2 size={15} />} label="Delete table" danger onClick={run((c) => c.deleteTable())} />
        </>
      )}
      {colors && <ColorList anchor={colors} placement="right-start" onClose={() => setColors(null)} onPick={(pick) => (colorCells(editor, cellColor(pick)), onClose())} />}
    </Popover>
  );
}

/** Drops the dragged widths of the table holding the cursor, so its columns fit their text again. */
function resetWidths(editor: Editor) {
  const table = currentTable(editor);
  if (!table) return;
  const tr = editor.state.tr;
  table.node.descendants((n, pos) => {
    if (n.attrs.colwidth) tr.setNodeMarkup(table.pos + 1 + pos, undefined, { ...n.attrs, colwidth: null });
  });
  editor.view.dispatch(tr);
}

/** A row's or column's menu, from its handle. */
function LineMenu({ editor, line, onClose }: { editor: Editor; line: Line; onClose: () => void }) {
  const [colors, setColors] = useState<HTMLElement | null>(null);
  const table = refresh(editor, line.table);
  if (!table) return null;
  const row = line.kind === "row";
  const headers = headersOf(table.node);
  const run = (fn: () => void) => () => (fn(), onClose());
  const chain = () => editor.chain().focus();
  return (
    <Popover anchor={line.at} onClose={onClose} className="w-56 p-1">
      {line.index === 0 && (
        <>
          {row ? (
            <MenuItem icon={<PanelTop size={15} />} label="Header row" right={<Toggle on={headers.row} />} onClick={run(() => setHeader(editor, table, "row", !headers.row))} />
          ) : (
            <MenuItem icon={<PanelLeft size={15} />} label="Header column" right={<Toggle on={headers.column} />} onClick={run(() => setHeader(editor, table, "column", !headers.column))} />
          )}
          <MenuDivider />
        </>
      )}
      <MenuItem icon={<Palette size={15} />} label="Color" right={<ChevronRight size={14} className="text-faint" />} onClick={(e) => setColors(e.currentTarget)} />
      <MenuDivider />
      {row ? (
        <>
          <MenuItem icon={<ArrowUp size={15} />} label="Insert above" onClick={run(() => chain().addRowBefore().run())} />
          <MenuItem icon={<ArrowDown size={15} />} label="Insert below" onClick={run(() => chain().addRowAfter().run())} />
          <MenuItem icon={<Copy size={15} />} label="Duplicate" onClick={run(() => duplicateRow(editor, table, line.index))} />
        </>
      ) : (
        <>
          <MenuItem icon={<ArrowLeft size={15} />} label="Insert left" onClick={run(() => chain().addColumnBefore().run())} />
          <MenuItem icon={<ArrowRight size={15} />} label="Insert right" onClick={run(() => chain().addColumnAfter().run())} />
          <MenuItem icon={<Copy size={15} />} label="Duplicate" onClick={run(() => duplicateColumn(editor, table, line.index))} />
        </>
      )}
      <MenuItem icon={<Eraser size={15} />} label="Clear contents" onClick={run(() => clearCells(editor))} />
      <MenuItem icon={<Trash2 size={15} />} label="Delete" danger onClick={run(() => (row ? chain().deleteRow().run() : chain().deleteColumn().run()))} />
      {colors && <ColorList anchor={colors} placement="right-start" onClose={() => setColors(null)} onPick={(pick) => (colorCells(editor, cellColor(pick)), onClose())} />}
    </Popover>
  );
}

type Line = { kind: "row" | "column"; index: number; table: TableRef; at: DOMRect };
type Hover = { pos: number; row: number; col: number };
/** A drag from a handle (reordering) or a + bar (adding rows or columns). */
type Drag = { kind: "row" | "column"; from: number; to: number } | null;

const tableDom = (editor: Editor, pos: number) => {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  return (dom?.matches?.("table") ? dom : dom?.querySelector?.("table")) as HTMLTableElement | null;
};

/**
 * Notion's table handles, over the table under the pointer: a grip beside each row and above each
 * column (click for its menu, drag to move it) and + bars below and beside the table (click to add
 * a row or column, drag to add several).
 */
export function TableControls({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const busy = useRef(false);
  const open = useRef(false);
  open.current = !!line;

  // Which table, row and column the pointer is over; kept while it's on the handles around it.
  useEffect(() => {
    const root = editor.view.dom;
    let leave: number | undefined;
    const onMove = (e: MouseEvent) => {
      if (busy.current || !editor.isEditable) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[data-table-controls]")) return clearTimeout(leave);
      const cell = t?.closest?.("td, th") as HTMLTableCellElement | null;
      const table = cell?.closest("table");
      if (cell && table && root.contains(table)) {
        clearTimeout(leave);
        let ref: TableRef | null = null;
        try {
          ref = tableAround(editor.state.doc, editor.view.posAtDOM(cell, 0));
        } catch {
          /* not in the document (yet) */
        }
        if (!ref) return;
        const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
        const next = { pos: ref.pos, row, col: cell.cellIndex };
        setHover((h) => (h && h.pos === next.pos && h.row === next.row && h.col === next.col ? h : next));
        return;
      }
      setHover((h) => {
        if (!h || open.current) return h;
        const el = tableDom(editor, h.pos);
        const r = el?.getBoundingClientRect();
        // The handles sit just outside the table: leaving through them doesn't count.
        if (r && e.clientX > r.left - 24 && e.clientX < r.right + 24 && e.clientY > r.top - 24 && e.clientY < r.bottom + 24) return h;
        return null;
      });
    };
    const update = () => rerender();
    document.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    editor.on("transaction", update);
    return () => {
      clearTimeout(leave);
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  const table = hover ? tableDom(editor, hover.pos) : null;
  const ref = hover ? refresh(editor, { node: editor.state.doc.nodeAt(hover.pos)!, pos: hover.pos }) : null;
  if (!hover || !table || !ref || !table.isConnected || ref.node.type.name !== "table") return null;

  const box = table.getBoundingClientRect();
  // A table wider than the page scrolls sideways: the handles stay on its visible part.
  const wrap = table.closest(".tableWrapper")?.getBoundingClientRect() ?? box;
  const right = Math.min(box.right, wrap.right);
  const rows = Array.from(table.rows);
  const row = rows[Math.min(hover.row, rows.length - 1)];
  const cell = row?.cells[Math.min(hover.col, row.cells.length - 1)];
  if (!row || !cell) return null;
  const rowBox = row.getBoundingClientRect();
  const cellBox = cell.getBoundingClientRect();
  const firstCells = Array.from(rows[0].cells);

  // Dragging a handle: where the row or column would land, as a boundary between two of them.
  const startMove = (e: React.MouseEvent, kind: "row" | "column", index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let moving = false;
    let to = index;
    busy.current = true;
    const boundary = (ev: MouseEvent) => {
      const edges = kind === "row" ? rows.map((r) => r.getBoundingClientRect()) : firstCells.map((c) => c.getBoundingClientRect());
      return edges.filter((b) => (kind === "row" ? b.top + b.height / 2 < ev.clientY : b.left + b.width / 2 < ev.clientX)).length;
    };
    const move = (ev: MouseEvent) => {
      if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!moving) {
        moving = true;
        selectLine(editor, ref, kind === "row" ? { row: index } : { column: index });
      }
      to = boundary(ev);
      setDrag({ kind, from: index, to });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      busy.current = false;
      setDrag(null);
      const now = refresh(editor, ref);
      if (!now) return;
      if (!moving) {
        selectLine(editor, now, kind === "row" ? { row: index } : { column: index });
        setLine({ kind, index, table: now, at });
        return;
      }
      const final = to > index ? to - 1 : to;
      if (kind === "row") moveRow(editor, now, index, final);
      else moveColumn(editor, now, index, final);
      setHover((h) => h && { ...h, ...(kind === "row" ? { row: final } : { col: final }) });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Pressing a + bar: one row (or column) on a click; dragging adds as many as the pointer covers.
  const startAdd = (e: React.MouseEvent, kind: "row" | "column" | "both") => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const step = { y: rows.at(-1)!.getBoundingClientRect().height || 36, x: firstCells.at(-1)!.getBoundingClientRect().width || 120 };
    let added = { rows: 0, cols: 0 };
    let moved = false;
    let current: TableRef | null = ref;
    busy.current = true;
    const move = (ev: MouseEvent) => {
      if (!current) return;
      moved ||= Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= 4;
      const want = {
        rows: kind === "column" ? 0 : Math.max(0, Math.round((ev.clientY - start.y) / step.y)),
        cols: kind === "row" ? 0 : Math.max(0, Math.round((ev.clientX - start.x) / step.x)),
      };
      if (want.rows !== added.rows) current = resizeRows(editor, current, want.rows - added.rows);
      if (current && want.cols !== added.cols) current = resizeColumns(editor, current, want.cols - added.cols);
      added = want;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      busy.current = false;
      if (!current) return;
      if (!moved && !added.rows && !added.cols) {
        if (kind !== "column") current = resizeRows(editor, current, 1);
        if (kind !== "row") current = resizeColumns(editor, current, 1);
      }
      // The cursor goes into the first new cell.
      const grid = { rows: current.node.childCount, cols: current.node.firstChild?.childCount ?? 1 };
      focusCell(editor, current, kind === "column" ? 0 : grid.rows - Math.max(1, added.rows), kind === "row" ? 0 : grid.cols - Math.max(1, added.cols));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const lineOn = (kind: "row" | "column", index: number) => (line?.kind === kind && line.index === index) || (drag?.kind === kind && drag.from === index);
  // The grips sit outside the editor, and leaving the editor hides the table's block handle: the
  // pointer crossing a row's grip on its way to that handle would lose it. Held while over a grip.
  const keepHandle = (on: boolean) => editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", on));
  const grip = (on: boolean) =>
    `grid place-items-center rounded-[4px] border shadow-sm transition-colors cursor-grab ${on ? "border-[var(--blue)] bg-[var(--blue)] text-white" : "border-line bg-raised text-faint hover:text-ink"}`;
  // The drop line while dragging a handle.
  const indicator = (() => {
    if (!drag) return null;
    if (drag.kind === "row") {
      const y = drag.to < rows.length ? rows[drag.to].getBoundingClientRect().top : box.bottom;
      return { left: box.left, top: y - 1.5, width: right - box.left, height: 3 };
    }
    const x = drag.to < firstCells.length ? firstCells[drag.to].getBoundingClientRect().left : box.right;
    return { left: x - 1.5, top: box.top, width: 3, height: box.height };
  })();

  return createPortal(
    <div data-table-controls className="pointer-events-none fixed inset-0 z-20">
      <div
        role="button"
        title="Drag to move · Click for row options"
        onMouseDown={(e) => startMove(e, "row", hover.row)}
        onMouseEnter={() => keepHandle(true)}
        onMouseLeave={() => keepHandle(false)}
        className={`pointer-events-auto absolute h-5 w-3.5 ${grip(lineOn("row", hover.row))}`}
        style={{ left: box.left - 7, top: rowBox.top + rowBox.height / 2 - 10 }}
      >
        <GripVertical size={12} />
      </div>
      <div
        role="button"
        title="Drag to move · Click for column options"
        onMouseDown={(e) => startMove(e, "column", hover.col)}
        onMouseEnter={() => keepHandle(true)}
        onMouseLeave={() => keepHandle(false)}
        className={`pointer-events-auto absolute h-3.5 w-5 ${grip(lineOn("column", hover.col))}`}
        style={{ left: cellBox.left + cellBox.width / 2 - 10, top: box.top - 7 }}
      >
        <GripHorizontal size={12} />
      </div>
      {!drag && (
        <>
          <button
            title="Click to add a row · Drag to add more"
            onMouseDown={(e) => startAdd(e, "row")}
            className="pointer-events-auto absolute grid place-items-center rounded-[4px] text-faint opacity-60 hover:bg-hover hover:text-muted hover:opacity-100"
            style={{ left: box.left, top: box.bottom + 2, width: right - box.left, height: 16 }}
          >
            <Plus size={13} />
          </button>
          <button
            title="Click to add a column · Drag to add more"
            onMouseDown={(e) => startAdd(e, "column")}
            className="pointer-events-auto absolute grid place-items-center rounded-[4px] text-faint opacity-60 hover:bg-hover hover:text-muted hover:opacity-100"
            style={{ left: right + 2, top: box.top, width: 16, height: box.height }}
          >
            <Plus size={13} />
          </button>
          <button
            title="Add a row and a column"
            onMouseDown={(e) => startAdd(e, "both")}
            className="pointer-events-auto absolute grid place-items-center rounded-full text-faint opacity-60 hover:bg-hover hover:text-muted hover:opacity-100"
            style={{ left: right + 2, top: box.bottom + 2, width: 16, height: 16 }}
          >
            <Plus size={11} />
          </button>
        </>
      )}
      {indicator && <div className="absolute rounded-full bg-[var(--blue)]" style={indicator} />}
      {line && (
        <div className="pointer-events-auto">
          <LineMenu editor={editor} line={line} onClose={() => setLine(null)} />
        </div>
      )}
    </div>,
    document.body,
  );
}
