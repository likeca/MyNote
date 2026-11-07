import type { Editor, JSONContent } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableView, renderTableToMarkdown } from "@tiptap/extension-table";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap, deleteCellSelection } from "@tiptap/pm/tables";
import { api } from "../lib/api";
import { joinNote, patchFrontmatter, splitNote } from "../lib/frontmatter";
import { TITLE, newId, writeSchema, type Schema as DbSchema } from "../database/model";
import { createDatabase } from "../database/useDatabase";
import { META, formatMeta, isCellColor, parseMeta } from "./tableMeta";

// ---------- nodes ----------

/** A cell's colour as HTML: Notion's name, and the theme colour it shows as. */
function colorAttrs(color: unknown) {
  if (!isCellColor(color)) return {};
  const name = color.replace(/_background$/, "");
  return { "data-color": color, style: color.endsWith("_background") ? `--cell-bg: var(--c-${name}-bg)` : `--cell-fg: var(--c-${name}-text)` };
}

const color = {
  default: null,
  parseHTML: (el: HTMLElement) => (isCellColor(el.dataset.color) ? el.dataset.color : null),
  renderHTML: (attrs: Record<string, unknown>) => colorAttrs(attrs.color),
};

/** Cells with a colour: Notion's text (`blue`) or background (`blue_background`). */
export const ColorTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), color };
  },
});
export const ColorTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), color };
  },
});

/** The table's view, marking a table stretched to the page width (CSS does the rest). */
class FitTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number, ...rest: unknown[]) {
    // @ts-expect-error the view and HTML attributes pass straight through
    super(node, cellMinWidth, ...rest);
    this.fit(node);
  }
  update(node: PMNode) {
    if (!super.update(node)) return false;
    this.fit(node);
    return true;
  }
  private fit(node: PMNode) {
    this.table.toggleAttribute("data-fit", !!node.attrs.fit);
  }
}

const base = Table.config;
type ParseMarkdown = NonNullable<typeof base.parseMarkdown>;
/** Tiptap's own table parsing (an arrow function: no `this`). */
const baseParse = base.parseMarkdown as unknown as (token: Parameters<ParseMarkdown>[0], h: Parameters<ParseMarkdown>[1]) => JSONContent;
const isHeader = (c?: JSONContent) => c?.type === "tableHeader";

/**
 * Notion's simple table: header row and column, cell colours, fit to page width and dragged column
 * widths. Plain Markdown pipes hold the cells; the rest rides in a comment above (see tableMeta).
 */
export const SimpleTable = Table.extend({
  addOptions() {
    return { ...this.parent!(), View: FitTableView as unknown as typeof TableView };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      fit: { default: false, parseHTML: (el) => el.hasAttribute("data-fit"), renderHTML: (a) => (a.fit ? { "data-fit": "" } : {}) },
    };
  },
  markdownTokenizer: {
    name: "table",
    level: "block",
    start: (src: string) => {
      const comment = src.search(/^<!-- table (?:widths|header|fit|colors):/m);
      const table = (base.markdownTokenizer!.start as (src: string) => number)(src);
      return comment >= 0 && (table < 0 || comment < table) ? comment : table;
    },
    tokenize(src, tokens, helper) {
      const m = META.exec(src);
      if (!m) return base.markdownTokenizer!.tokenize(src, tokens, helper);
      const rest = src.slice(m[0].length);
      // The stock tokenizer only takes tables needing pipe escapes and leaves the rest to marked's.
      const token = base.markdownTokenizer!.tokenize(rest, tokens, helper) ?? helper.blockTokens(rest)[0];
      if (token?.type !== "table") return undefined;
      return { ...token, raw: m[0] + token.raw, meta: m[1] };
    },
  },
  parseMarkdown(token, h) {
    // Tiptap's own, not `this.parent`: `configure()` makes a child whose parent is this function.
    const table = baseParse(token, h);
    const rows = table.content ?? [];
    const cols = Math.max(0, ...rows.map((r) => r.content?.length ?? 0));
    const meta = typeof token.meta === "string" ? parseMeta(token.meta, rows.length, cols) : {};
    rows.forEach((row, r) =>
      row.content?.forEach((cell, c) => {
        const width = meta.widths?.[c] ?? 0;
        if (width > 0) cell.attrs = { ...cell.attrs, colwidth: [width] };
        if (meta.header) cell.type = (r === 0 && meta.header.row) || (c === 0 && meta.header.column) ? "tableHeader" : "tableCell";
        const color = meta.colors?.[r]?.[c];
        if (color) cell.attrs = { ...cell.attrs, color };
      }),
    );
    if (meta.fit) table.attrs = { ...table.attrs, fit: true };
    return table;
  },
  renderMarkdown(node, h) {
    const rows = (node.content ?? []) as JSONContent[];
    const headerRow = !!rows[0]?.content?.length && rows[0].content.every(isHeader);
    const headerColumn = rows.length > 0 && rows.every((r) => isHeader(r.content?.[0])) && (rows.length > 1 || !headerRow);
    // Markdown always has a header line: without a header row, the first row goes there.
    const shown = headerRow ? node : { ...node, content: rows.map((r, i) => (i ? r : { ...r, content: r.content?.map((c) => ({ ...c, type: "tableHeader" })) })) };
    const md = renderTableToMarkdown(shown, h);
    const comment = formatMeta({
      widths: (rows[0]?.content ?? []).map((c) => (c.attrs?.colwidth as number[] | null)?.[0] ?? 0),
      header: { row: headerRow, column: headerColumn },
      fit: !!node.attrs?.fit,
      colors: rows.map((r) => (r.content ?? []).map((c) => (isCellColor(c.attrs?.color) ? c.attrs!.color : null))),
    });
    // Straight above the table, after the blank lines the serializer puts before it.
    const lead = /^\n*/.exec(md)![0];
    if (!comment) return md;
    return `${lead}${comment}\n${md.slice(lead.length)}`;
  },
});

// ---------- working with a table ----------

/** A table in the document: the node and where it starts. */
export type TableRef = { node: PMNode; pos: number };
export type Headers = { row: boolean; column: boolean };

/** The table around `pos`, if any. */
export function tableAround(doc: PMNode, pos: number): TableRef | null {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === "table") return { node: $pos.node(d), pos: $pos.before(d) };
  }
  return null;
}

/** The table again after an edit: by position if it's still there, else wherever the same node is. */
export function refresh(editor: Editor, ref: TableRef): TableRef | null {
  const { doc } = editor.state;
  const at = ref.pos < doc.content.size ? doc.nodeAt(ref.pos) : null;
  if (at?.type.name === "table") return { node: at, pos: ref.pos };
  let found: TableRef | null = null;
  doc.descendants((n, p) => {
    if (found) return false;
    if (n === ref.node) found = { node: n, pos: p };
    return !found;
  });
  return found;
}

const gridOf = (table: PMNode) => {
  const grid: PMNode[][] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    grid.push(cells);
  });
  return grid;
};

export function headersOf(table: PMNode): Headers {
  const grid = gridOf(table);
  const th = (c?: PMNode) => c?.type.name === "tableHeader";
  const row = !!grid[0]?.length && grid[0].every(th);
  return { row, column: grid.length > 0 && grid.every((r) => th(r[0])) && (grid.length > 1 || !row) };
}

/** The table rebuilt from `grid`, each cell a header or not by where it is. */
function build(schema: Schema, table: PMNode, grid: PMNode[][], headers: Headers, attrs = table.attrs): PMNode {
  const rows = grid.map((cells, r) =>
    schema.nodes.tableRow.create(
      null,
      cells.map((cell, c) => {
        const type = (r === 0 && headers.row) || (c === 0 && headers.column) ? schema.nodes.tableHeader : schema.nodes.tableCell;
        return cell.type === type ? cell : type.create(cell.attrs, cell.content, cell.marks);
      }),
    ),
  );
  return table.type.create(attrs, rows);
}

function replace(editor: Editor, ref: TableRef, grid: PMNode[][], headers = headersOf(ref.node), attrs = ref.node.attrs) {
  const next = build(editor.schema, ref.node, grid, headers, attrs);
  editor.view.dispatch(editor.state.tr.replaceWith(ref.pos, ref.pos + ref.node.nodeSize, next));
  return { node: next, pos: ref.pos };
}

/** An empty cell for column `c`, as wide as the column's others. */
function emptyCell(schema: Schema, grid: PMNode[][], c: number) {
  const colwidth = grid.find((r) => r[c])?.[c].attrs.colwidth ?? null;
  return schema.nodes.tableCell.createAndFill({ colwidth })!;
}

const move = <T>(list: T[], from: number, to: number) => {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
};

/** Selects row `r` (or column `c`) as a block of cells, as clicking its handle does. */
export function selectLine(editor: Editor, ref: TableRef, line: { row: number } | { column: number }) {
  const map = TableMap.get(ref.node);
  const at = (r: number, c: number) => editor.state.doc.resolve(ref.pos + 1 + map.positionAt(r, c, ref.node));
  const sel =
    "row" in line
      ? CellSelection.rowSelection(at(line.row, 0), at(line.row, map.width - 1))
      : CellSelection.colSelection(at(0, line.column), at(map.height - 1, line.column));
  editor.view.dispatch(editor.state.tr.setSelection(sel));
  editor.view.focus();
}

/** Moves row `from` to index `to` (in the table as it will be). */
export function moveRow(editor: Editor, ref: TableRef, from: number, to: number) {
  if (from === to) return;
  const next = replace(editor, ref, move(gridOf(ref.node), from, to));
  selectLine(editor, next, { row: to });
}

export function moveColumn(editor: Editor, ref: TableRef, from: number, to: number) {
  if (from === to) return;
  const next = replace(
    editor,
    ref,
    gridOf(ref.node).map((r) => move(r, from, to)),
  );
  selectLine(editor, next, { column: to });
}

export function duplicateRow(editor: Editor, ref: TableRef, r: number) {
  const grid = gridOf(ref.node);
  grid.splice(r + 1, 0, [...grid[r]]);
  selectLine(editor, replace(editor, ref, grid), { row: r + 1 });
}

export function duplicateColumn(editor: Editor, ref: TableRef, c: number) {
  const next = replace(
    editor,
    ref,
    gridOf(ref.node).map((row) => [...row.slice(0, c + 1), row[c], ...row.slice(c + 1)]),
  );
  selectLine(editor, next, { column: c + 1 });
}

/** Adds `n` empty rows at the end (the + under the table); a negative `n` takes empty ones away. */
export function resizeRows(editor: Editor, ref: TableRef, n: number): TableRef {
  const grid = gridOf(ref.node);
  if (n > 0) {
    const width = grid[0]?.length ?? 1;
    for (let i = 0; i < n; i++) grid.push(Array.from({ length: width }, (_, c) => emptyCell(editor.schema, grid, c)));
  } else {
    for (let i = 0; i < -n && grid.length > 1 && grid.at(-1)!.every((c) => !c.textContent); i++) grid.pop();
  }
  return replace(editor, ref, grid);
}

/** Adds `n` empty columns on the right (the + beside the table); a negative `n` takes empty ones away. */
export function resizeColumns(editor: Editor, ref: TableRef, n: number): TableRef {
  const grid = gridOf(ref.node);
  if (n > 0) {
    for (const row of grid) for (let i = 0; i < n; i++) row.push(editor.schema.nodes.tableCell.createAndFill()!);
  } else {
    for (let i = 0; i < -n && (grid[0]?.length ?? 0) > 1 && grid.every((r) => !r.at(-1)!.textContent); i++) for (const row of grid) row.pop();
  }
  return replace(editor, ref, grid);
}

/** Turns the table's header row or header column on or off. */
export function setHeader(editor: Editor, ref: TableRef, which: keyof Headers, on: boolean) {
  replace(editor, ref, gridOf(ref.node), { ...headersOf(ref.node), [which]: on });
}

/** Stretches the table to the page width, or back to its columns' own widths. */
export function setFit(editor: Editor, ref: TableRef, fit: boolean) {
  editor.view.dispatch(editor.state.tr.setNodeMarkup(ref.pos, undefined, { ...ref.node.attrs, fit }));
}

/** Colours the selected cells (a row, a column, a block of cells, or the cell with the cursor); null clears. */
export function colorCells(editor: Editor, color: string | null) {
  const { state } = editor;
  const tr = state.tr;
  const paint = (cell: PMNode, pos: number) => tr.setNodeMarkup(pos, undefined, { ...cell.attrs, color });
  if (state.selection instanceof CellSelection) state.selection.forEachCell(paint);
  else {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type.name === "tableCell" || n.type.name === "tableHeader") {
        paint(n, $from.before(d));
        break;
      }
    }
  }
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** Colours every cell of the table (its block menu's Color). */
export function colorTable(editor: Editor, ref: TableRef, color: string | null) {
  replace(
    editor,
    ref,
    gridOf(ref.node).map((r) => r.map((c) => c.type.create({ ...c.attrs, color }, c.content, c.marks))),
  );
}

/** The cell colour a picked colour stands for: `blue` text or `blue_background`; null for default. */
export const cellColor = (pick: { color?: string; bg?: string }) =>
  pick.bg ? (pick.bg === "default" ? null : `${pick.bg}_background`) : pick.color && pick.color !== "default" ? pick.color : null;

/** Empties the selected cells (or the cell with the cursor), keeping their colours. */
export function clearCells(editor: Editor) {
  const { state } = editor;
  if (!(state.selection instanceof CellSelection)) {
    const { $from } = state.selection;
    let d = $from.depth;
    while (d > 0 && !["tableCell", "tableHeader"].includes($from.node(d).type.name)) d--;
    if (!d) return;
    editor.view.dispatch(state.tr.setSelection(CellSelection.create(state.doc, $from.before(d))));
  }
  deleteCellSelection(editor.state, editor.view.dispatch);
  editor.view.focus();
}

/** Puts the cursor in cell (`r`, `c`). */
export function focusCell(editor: Editor, ref: TableRef, r: number, c: number) {
  const map = TableMap.get(ref.node);
  const pos = ref.pos + 1 + map.positionAt(Math.min(r, map.height - 1), Math.min(c, map.width - 1), ref.node);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
  editor.view.focus();
}

// ---------- turn into database ----------

/** Frontmatter keys a page already uses for itself; a column by that name gets a number. */
const PAGE_KEYS = new Set(["title", "icon", "cover", "order", "type"]);

/**
 * Makes a database (a sub-page of `page`) out of the table: the first column becomes the rows'
 * names, the others text properties, named by the header row when there is one. The table is
 * replaced with the database, shown inline. Resolves to the database's path.
 */
export async function tableToDatabase(editor: Editor, ref: TableRef, page: string | null): Promise<string> {
  const grid = gridOf(ref.node).map((r) => r.map((c) => c.textContent.trim()));
  const { row: header } = headersOf(ref.node);
  const width = Math.max(1, ...grid.map((r) => r.length));
  const taken = new Set<string>();
  const names = Array.from({ length: width }, (_, i) => {
    let name = (header ? grid[0][i] : "") || (i === 0 ? TITLE : `Column ${i + 1}`);
    if (PAGE_KEYS.has(name.toLowerCase())) name = `${name} 2`;
    for (let n = 2, base = name; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    return name;
  });
  const path = await createDatabase(page);
  const schema: DbSchema = {
    ...(names[0] !== TITLE && { title: names[0] }),
    properties: names.slice(1).map((name) => ({ name, type: "text" as const })),
    views: [{ id: newId(), name: "Table", type: "table" }],
  };
  const db = splitNote(await api.readNote(path));
  await api.writeNote(path, joinNote(db.frontmatter, writeSchema("", schema)));
  // In the table's order: rows with an `order` come first by it.
  for (const [i, row] of (header ? grid.slice(1) : grid).entries()) {
    const rowPath = await api.createNote(path, row[0] || "Untitled");
    const values: Record<string, unknown> = { order: i + 1 };
    names.slice(1).forEach((name, j) => row[j + 1] && (values[name] = row[j + 1]));
    const note = splitNote(await api.readNote(rowPath));
    await api.writeNote(rowPath, joinNote(patchFrontmatter(note.frontmatter, values), note.body));
  }
  const embed = { type: "databaseEmbed", attrs: { target: path.replace(/\.md$/, "") } };
  const now = refresh(editor, ref);
  if (now) editor.chain().focus().insertContentAt({ from: now.pos, to: now.pos + now.node.nodeSize }, embed).run();
  else editor.chain().focus().insertContent(embed).run();
  return path;
}
