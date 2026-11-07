/**
 * What a simple table keeps beyond its Markdown pipes, in a comment just above it that other
 * Markdown apps ignore:
 *
 *     <!-- table widths: 160, 0, 240; header: row, column; fit: page; colors: r1=gray_background, c2=blue, r3c1=default -->
 *
 * - `widths`: dragged column widths in pixels, 0 for a column left to fit its text;
 * - `header`: which headers are on, `row`, `column`, both or `none` (absent: just the header row,
 *   which is all plain Markdown has);
 * - `fit`: `page` stretches the table to the page width;
 * - `colors`: cell colours by row (`r2`), column (`c1`) or cell (`r2c3`), counted from 1. Rows win
 *   over columns and cells over both; `default` clears a colour a row or column gave the cell.
 *   Notion's names: `blue` is blue text, `blue_background` a blue cell.
 */

export type Colors = (string | null)[][];
export type TableMeta = {
  widths?: number[];
  header?: { row: boolean; column: boolean };
  fit?: boolean;
  colors?: Colors;
};

const NAMES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
/** A cell colour: `blue` (text) or `blue_background`. */
export const isCellColor = (c: unknown): c is string => typeof c === "string" && NAMES.includes(c.replace(/_background$/, ""));

/** The comment, with whatever follows it on its line; `m[1]` is what's inside. */
export const META = /^<!-- table ((?:widths|header|fit|colors):[^>]*?) -->[ \t]*\n/;

/** Reads the comment's contents (`widths: 160, 0; header: none`); `rows` × `cols` sizes `colors`. */
export function parseMeta(text: string, rows: number, cols: number): TableMeta {
  const meta: TableMeta = {};
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "widths") meta.widths = value.split(",").map((w) => Number(w.trim()) || 0);
    else if (key === "header") {
      const on = value.split(",").map((s) => s.trim());
      meta.header = { row: on.includes("row"), column: on.includes("column") };
    } else if (key === "fit") meta.fit = value === "page";
    else if (key === "colors") meta.colors = decodeColors(value, rows, cols);
  }
  return meta;
}

/** The comment for `meta`, or "" when the table is plain Markdown (no widths, header row only…). */
export function formatMeta(meta: TableMeta): string {
  const parts: string[] = [];
  if (meta.widths?.some((w) => w > 0)) parts.push(`widths: ${meta.widths.join(", ")}`);
  const h = meta.header;
  if (h && !(h.row && !h.column)) parts.push(`header: ${[h.row && "row", h.column && "column"].filter(Boolean).join(", ") || "none"}`);
  if (meta.fit) parts.push("fit: page");
  const colors = meta.colors && encodeColors(meta.colors);
  if (colors) parts.push(`colors: ${colors}`);
  return parts.length ? `<!-- table ${parts.join("; ")} -->` : "";
}

/** A grid of cell colours, briefly: whole rows, then whole columns, then the cells left over. */
export function encodeColors(grid: Colors): string {
  const rows = grid.length;
  const cols = Math.max(0, ...grid.map((r) => r.length));
  const at = (r: number, c: number) => grid[r]?.[c] ?? null;
  const uniform = (cells: (string | null)[]) => (cells.length && cells[0] && cells.every((x) => x === cells[0]) ? cells[0] : null);
  const rowColor = grid.map((r) => (r.length === cols ? uniform(r) : null));
  const others = grid.map((_, r) => r).filter((r) => !rowColor[r]);
  const colColor = Array.from({ length: cols }, (_, c) => (others.length ? uniform(others.map((r) => at(r, c))) : null));
  const out: string[] = [];
  colColor.forEach((x, c) => x && out.push(`c${c + 1}=${x}`));
  rowColor.forEach((x, r) => x && out.push(`r${r + 1}=${x}`));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const expected = rowColor[r] ?? colColor[c] ?? null;
      if (at(r, c) !== expected) out.push(`r${r + 1}c${c + 1}=${at(r, c) ?? "default"}`);
    }
  }
  return out.join(", ");
}

export function decodeColors(text: string, rows: number, cols: number): Colors {
  const grid: Colors = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
  const entries = text
    .split(",")
    .map((e) => /^(?:r(\d+))?(?:c(\d+))?=([a-z_]+)$/.exec(e.trim()))
    .filter((m): m is RegExpExecArray => !!m && (!!m[1] || !!m[2]) && (m[3] === "default" || isCellColor(m[3])));
  // Columns, then rows, then single cells, whatever order they're written in.
  const rank = (m: RegExpExecArray) => (m[1] && m[2] ? 2 : m[1] ? 1 : 0);
  for (const m of entries.sort((a, b) => rank(a) - rank(b))) {
    const color = m[3] === "default" ? null : m[3];
    const r = m[1] ? Number(m[1]) - 1 : null;
    const c = m[2] ? Number(m[2]) - 1 : null;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if ((r === null || r === i) && (c === null || c === j)) grid[i][j] = color;
      }
    }
  }
  return grid;
}
