/**
 * Custom colours (Settings → Appearance): the theme's own CSS variables, fine-tuned per theme
 * (Light, Dark, Black) on top of the palette. Stored as `#rrggbb`.
 */

export const CUSTOM_COLORS = [
  { key: "surface", label: "Page background", hint: "Behind pages, the active tab and terminals." },
  { key: "side", label: "Sidebar background", hint: "The sidebar and the tab strip." },
  { key: "raised", label: "Menus and popups", hint: "Menus, dialogs and the search palette." },
  { key: "ink", label: "Text", hint: "Page text, titles and headings." },
  { key: "muted", label: "Secondary text", hint: "Sidebar rows, labels and hints." },
  { key: "faint", label: "Faint text", hint: "Icons, placeholders and dates." },
  { key: "line", label: "Borders", hint: "Dividers, table lines and outlines." },
  { key: "codeblock-bg", label: "Code blocks", hint: "Behind code blocks." },
] as const;

export type ColorKey = (typeof CUSTOM_COLORS)[number]["key"];
/** Which theme a set of colours belongs to: Black keeps its own, apart from Dark. */
export type Tone = "light" | "dark" | "black";
export type ColorSet = Partial<Record<ColorKey, string>>;
export type CustomColors = Record<Tone, ColorSet>;

export const NO_COLORS: CustomColors = { light: {}, dark: {}, black: {} };

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

/** Saved colours as they should be: unknown keys and malformed values dropped. */
export function sanitizeColors(v: unknown): CustomColors {
  const out: CustomColors = { light: {}, dark: {}, black: {} };
  if (!v || typeof v !== "object") return out;
  for (const tone of ["light", "dark", "black"] as const) {
    const set = (v as Record<string, unknown>)[tone];
    if (!set || typeof set !== "object") continue;
    for (const { key } of CUSTOM_COLORS) {
      const c = (set as Record<string, unknown>)[key];
      if (isHex(c)) out[tone][key] = c.toLowerCase();
    }
  }
  return out;
}

/**
 * The stylesheet for a theme's custom colours: they beat every palette's (`!important`), and the
 * dark sidebar's own secondary text too.
 */
export function colorsCss(set: ColorSet): string {
  const vars = CUSTOM_COLORS.filter(({ key }) => set[key]).map(({ key }) => `--${key}: ${set[key]} !important;`);
  if (!vars.length) return "";
  const sidebar = set.muted ? `\n:root [data-sidebar] { --muted: ${set.muted} !important; }` : "";
  return `:root { ${vars.join(" ")} }${sidebar}`;
}

let ctx: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS colour as `#rrggbb` (what a colour picker takes), a translucent one as it looks over
 * `over`; `fallback` when the browser can't read it.
 */
export function toHex(css: string, over = "#ffffff", fallback = "#808080"): string {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx || !css.trim()) return fallback;
  ctx.fillStyle = "#000001";
  ctx.fillStyle = css.trim();
  const v = String(ctx.fillStyle);
  if (isHex(v)) return v.toLowerCase();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (!m) return fallback;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const base = isHex(over) ? [1, 3, 5].map((i) => parseInt(over.slice(i, i + 2), 16)) : [255, 255, 255];
  return `#${[m[1], m[2], m[3]].map((c, i) => Math.round(Number(c) * a + base[i] * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}
