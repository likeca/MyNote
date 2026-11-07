/**
 * Rich blocks, each with a Markdown form that other tools can still read:
 *   colours    <span data-color="red" data-bg="yellow">text</span>
 *   callout    > [!yellow] 💡            (Obsidian callout syntax)
 *   toggle     <details><summary>…</summary> … </details>
 *   toggle heading  <details><summary><h2>…</h2></summary> … </details>
 *   columns    <div class="columns"><div class="column"> … </div></div>
 *   database   ![[Tasks]]               (Obsidian embed syntax)
 *   image      ![alt|320](src)          (Obsidian's width; a draw.io diagram is a `.drawio.svg` image, see drawio.tsx)
 */
import { ASSET_CHANGED, PageIcon, assetChanged, assetUrl } from "../components/PageIcon";
import { Extension, Mark, Node, mergeAttributes, type Editor as TiptapEditor, type JSONContent, type NodeViewRendererProps } from "@tiptap/core";
import { CodeBlock as TiptapCodeBlock } from "@tiptap/extension-code-block";
import { Details, DetailsSummary } from "@tiptap/extension-details";
import Image from "@tiptap/extension-image";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  File as FileGeneric,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Pencil,
  Presentation,
  Square,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconPicker } from "../components/LazyIconPicker";
import { MenuItem, Popover } from "../components/Popover";
import { DatabaseView } from "../database/DatabaseView";
import { VIEWS_MARKER } from "../database/model";
import { api } from "../lib/api";
import { COLORS, bgColor, textColor } from "../lib/colors";
import { resolveWikiLink } from "../lib/tree";
import { currentPlatform } from "../plugins/runtime";
import { useVault } from "../lib/vault";
import { fileTab, opensInEditor } from "../lib/fileTabs";
import { codeHighlight } from "./highlight";
import { isEditableDiagram, openDiagramEditor } from "./drawio";

const isColor = (c: unknown): c is string => typeof c === "string" && (COLORS as readonly string[]).includes(c);

// ---------- text colour ----------

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    color: {
      /** Merges text and/or background colour into the selection; "default" clears that part. */
      setColor: (attrs: { color?: string; bg?: string }) => ReturnType;
    };
  }
  interface Storage {
    /** The vault path of the page the editor shows: its attachments go in its folder. */
    fileAttachment: { page: string | null };
  }
}

const KEEP_COLOR = "keepColor";

const SPAN = /^<span((?:\s+data-(?:color|bg)="[a-z]+")+)\s*>([\s\S]*?)<\/span>/;

export const ColorMark = Mark.create({
  name: "color",
  addAttributes() {
    return {
      color: { default: null, parseHTML: (el) => el.getAttribute("data-color") },
      bg: { default: null, parseHTML: (el) => el.getAttribute("data-bg") },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-color]" }, { tag: "span[data-bg]" }];
  },
  renderHTML({ mark }) {
    const { color, bg } = mark.attrs;
    const style = [textColor(color) && `color: ${textColor(color)}`, bgColor(bg) && `background: ${bgColor(bg)}`].filter(Boolean).join("; ");
    return ["span", { "data-color": color, "data-bg": bg, style, class: bg ? "has-bg" : undefined }, 0];
  },
  addCommands() {
    return {
      setColor:
        (attrs) =>
          ({ editor, commands, tr }) => {
            tr.setMeta(KEEP_COLOR, true);
            const current = editor.getAttributes("color");
            const next = { ...current, ...attrs };
            const clean = {
              color: next.color && next.color !== "default" ? next.color : null,
              bg: next.bg && next.bg !== "default" ? next.bg : null,
            };
            return clean.color || clean.bg ? commands.setMark(this.name, clean) : commands.unsetMark(this.name);
          },
    };
  },
  // Pressing Enter starts the next block without the previous block's colour.
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("colorNotInherited"),
        appendTransaction: (trs, oldState, state) => {
          if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta(KEEP_COLOR))) return null;
          const { $from, empty } = state.selection;
          const stored = state.storedMarks;
          const freshBlock = empty && $from.parent.isTextblock && $from.parent.content.size === 0 && state.doc.content.size > oldState.doc.content.size;
          if (!freshBlock || !stored?.some((m) => m.type === type)) return null;
          return state.tr.setStoredMarks(stored.filter((m) => m.type !== type));
        },
      }),
    ];
  },
  markdownTokenizer: {
    name: "color",
    level: "inline",
    start: (src: string) => src.indexOf("<span data-"),
    tokenize(src, _tokens, lexer) {
      const m = SPAN.exec(src);
      if (!m) return undefined;
      const attr = (k: string) => new RegExp(`data-${k}="([a-z]+)"`).exec(m[1])?.[1] ?? null;
      return { type: "color", raw: m[0], color: attr("color"), bg: attr("bg"), tokens: lexer.inlineTokens(m[2]) };
    },
  },
  parseMarkdown: (token, h) => h.applyMark("color", h.parseInline(token.tokens ?? []), { color: token.color, bg: token.bg }),
  renderMarkdown: (node, h) => {
    const { color, bg } = node.attrs ?? {};
    const attrs = `${color ? ` data-color="${color}"` : ""}${bg ? ` data-bg="${bg}"` : ""}`;
    return `<span${attrs}>${h.renderChildren(node)}</span>`;
  },
});

// ---------- callout ----------

const CALLOUT = /^> ?\[!([a-z]+)\][ \t]*([^\n]*)(?:\n|$)((?:>[^\n]*(?:\n|$))*)/;

/**
 * Splits a callout's first line into its icon and a title, as in Obsidian's `> [!note] Title`:
 * `🎬 Studio` is the icon 🎬 and the title "Studio"; a line without a leading icon is all title.
 */
function calloutHead(line: string): { icon: string; title: string } {
  const [first = "", ...rest] = line.trim().split(/\s+/);
  const isIcon = /^(lucide:|\.assets\/|https?:\/\/)/.test(first) || /^\p{Extended_Pictographic}/u.test(first);
  return isIcon ? { icon: first, title: rest.join(" ") } : { icon: "", title: line.trim() };
}

/** Prefixes every line with `> `, using a bare `>` for blank lines. */
const quote = (text: string) => text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      icon: { default: "💡", parseHTML: (el) => el.getAttribute("data-icon") },
      color: { default: "gray", parseHTML: (el) => el.getAttribute("data-color") },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "", "data-icon": node.attrs.icon, "data-color": node.attrs.color }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src: string) => src.search(/^> ?\[!/m),
    tokenize(src, _tokens, lexer) {
      const m = CALLOUT.exec(src);
      if (!m) return undefined;
      const { icon, title } = calloutHead(m[2]);
      const body = m[3].replace(/\n$/, "").split("\n").map((l) => l.replace(/^> ?/, "")).join("\n");
      // A title on the first line opens the callout as a bold line, so it reads as one rather than
      // crowding the icon.
      const inner = title ? `**${title}**${body ? `\n\n${body}` : ""}` : body;
      return { type: "callout", raw: m[0], color: m[1], icon, tokens: lexer.blockTokens(inner) };
    },
  },
  parseMarkdown: (token, h) => {
    const content = h.parseChildren(token.tokens ?? []);
    return {
      type: "callout",
      attrs: { color: isColor(token.color) ? token.color : "gray", icon: token.icon || "💡" },
      content: content.length ? content : [{ type: "paragraph" }],
    };
  },
  renderMarkdown: (node, h) => `> [!${node.attrs?.color ?? "gray"}] ${node.attrs?.icon ?? "💡"}\n${quote(h.renderChildren(node.content ?? [], "\n\n"))}`,
});

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const [picking, setPicking] = useState(false);
  const color = node.attrs.color === "default" ? null : node.attrs.color;
  return (
    <NodeViewWrapper className="callout" style={{ background: color ? bgColor(color) : undefined }} data-plain={!color || undefined}>
      <div contentEditable={false} className="callout-icon relative">
        <button onClick={() => setPicking(true)} className="grid size-6 place-items-center rounded hover:bg-hover">
          <PageIcon icon={node.attrs.icon} size={20} />
        </button>
        {picking && (
          <IconPicker
            current={node.attrs.icon}
            onClose={() => setPicking(false)}
            onPick={(icon) => {
              setPicking(false);
              updateAttributes({ icon: icon ?? "💡" });
            }}
          />
        )}
      </div>
      <NodeViewContent className="callout-content" />
    </NodeViewWrapper>
  );
}

// ---------- toggle ----------

function takeDetails(src: string) {
  const head = /^<details( open)?>[ \t]*\n?[ \t]*<summary>([\s\S]*?)<\/summary>[ \t]*(?:\n|$)/.exec(src);
  if (!head) return undefined;
  let depth = 1;
  const tag = /<details(?: open)?>|<\/details>/g;
  tag.lastIndex = head[0].length;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src))) {
    depth += m[0] === "</details>" ? -1 : 1;
    if (depth === 0) {
      const end = m.index + m[0].length;
      const raw = src.slice(0, end) + (src[end] === "\n" ? "\n" : "");
      return { raw, open: !!head[1], summary: head[2].trim(), inner: src.slice(head[0].length, m.index).trim() };
    }
  }
  return undefined;
}

/** A toggle heading's title: `<summary><h2>Title</h2></summary>` (levels 1–3). */
const SUMMARY_HEADING = /^<h([1-3])>([\s\S]*)<\/h\1>$/;

/** The toggle the selection is on: the one whose title holds the cursor, or a selected toggle block. */
function titledToggle(selection: Selection): { pos: number; node: PMNode } | null {
  if (selection instanceof NodeSelection && selection.node.type.name === "details") return { pos: selection.from, node: selection.node };
  const { $from } = selection;
  if ($from.parent.type.name !== "detailsSummary") return null;
  return { pos: $from.before($from.depth - 1), node: $from.node($from.depth - 1) };
}

/** The level of the toggle the selection is on: 1–3 for a toggle heading, null for a plain toggle, undefined when it isn't on one. */
export function toggleLevel(editor: TiptapEditor): number | null | undefined {
  const toggle = titledToggle(editor.state.selection);
  return toggle ? (toggle.node.attrs.level ?? null) : undefined;
}

/** Command: makes the toggle the selection is on a toggle heading (`level` 1–3) or a plain toggle (null). */
export const setToggleLevel =
  (level: 1 | 2 | 3 | null) =>
  ({ tr }: { tr: Transaction }) => {
    const toggle = titledToggle(tr.selection);
    if (!toggle) return false;
    tr.setNodeAttribute(toggle.pos, "level", level);
    return true;
  };

/**
 * Command: turns the block at the cursor into a toggle (a toggle heading with `level` 1–3), as Notion
 * does: a paragraph's or heading's text becomes its title, other blocks (lists, quotes…) go inside it.
 * On a toggle's title, it only changes the level.
 */
export const turnIntoToggle =
  (level: 1 | 2 | 3 | null) =>
  ({ tr }: { tr: Transaction }) => {
    if (titledToggle(tr.selection)) return setToggleLevel(level)({ tr });
    const { $from, $to } = tr.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    const { schema } = tr.doc.type;
    const blocks: PMNode[] = [];
    tr.doc.slice(range.start, range.end).content.forEach((n) => void blocks.push(n));
    const [first, ...rest] = blocks;
    const titled = !!first && first.isTextblock && first.type !== schema.nodes.codeBlock && schema.nodes.detailsSummary.validContent(first.content);
    const inside = titled ? rest : blocks;
    const body = inside.length ? inside : [schema.nodes.paragraph.create()];
    if (!schema.nodes.detailsContent.validContent(Fragment.from(body))) return false;
    const summary = schema.nodes.detailsSummary.create(null, titled ? first.content : null);
    // Open, as in Notion: Enter in its title then goes inside it (a closed toggle's Enter adds a line after it).
    tr.replaceWith(range.start, range.end, schema.nodes.details.create({ level, open: true }, [summary, schema.nodes.detailsContent.create(null, body)]));
    tr.setSelection(TextSelection.create(tr.doc, range.start + 2 + summary.content.size));
    return true;
  };

/**
 * Command: unwraps the toggle the selection is on, as Notion's Backspace and Turn into do: its title
 * becomes a heading of `level` (or text, for null) and its contents follow it.
 */
export const unwrapToggle =
  (level: 1 | 2 | 3 | null) =>
  ({ tr }: { tr: Transaction }) => {
    const toggle = titledToggle(tr.selection);
    if (!toggle) return false;
    const { schema } = tr.doc.type;
    const [summary, body] = [toggle.node.child(0), toggle.node.child(1)];
    const blocks = [level ? schema.nodes.heading.create({ level }, summary.content) : schema.nodes.paragraph.create(null, summary.content)];
    const onlyEmpty = body.childCount === 1 && body.firstChild!.type.name === "paragraph" && body.firstChild!.content.size === 0;
    if (!onlyEmpty) body.forEach((n) => void blocks.push(n));
    const offset = tr.selection.$from.parent.type.name === "detailsSummary" ? tr.selection.$from.parentOffset : 0;
    tr.replaceWith(toggle.pos, toggle.pos + toggle.node.nodeSize, blocks);
    tr.setSelection(TextSelection.create(tr.doc, toggle.pos + 1 + offset));
    return true;
  };

/** A toggle heading's icon: the heading glyph with the toggle's arrow. */
export function ToggleHeadingIcon({ level, size }: { level: 1 | 2 | 3; size: number }) {
  const Glyph = level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
  return (
    <span className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
      <Glyph size={size * 0.78} className="translate-x-[18%]" />
      <span className="absolute left-0 top-1/2 -translate-y-1/2 border-y-[3px] border-l-[4px] border-y-transparent border-l-current" />
    </span>
  );
}

export const Toggle = Details.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // A toggle heading (Notion's "Toggle heading 1–3"): its title is a heading of this level.
      level: {
        default: null,
        // Pasted HTML (GitHub, the web) has the level only as the title's tag: <summary><h2>.
        parseHTML: (el) => Number(el.getAttribute("data-level")) || Number(el.querySelector(":scope > summary > h1, :scope > summary > h2, :scope > summary > h3")?.tagName[1]) || null,
        renderHTML: (attrs) => (attrs.level ? { "data-level": attrs.level } : {}),
      },
    };
  },
  // The stock view flips its open/closed look on events and can fall out of step with the saved
  // `open` (e.g. when a page opens with the cursor in a toggle): each click then flips it twice
  // and seems to do nothing. Here the look always follows `open`.
  addNodeView() {
    const make = this.parent!() as (props: NodeViewRendererProps) => NodeView;
    return (props) => {
      const view = make(props);
      const dom = view.dom as HTMLElement;
      const sync = (node: PMNode) => {
        const open = !!node.attrs.open;
        dom.classList.toggle("is-open", open);
        if (node.attrs.level) dom.setAttribute("data-level", String(node.attrs.level));
        else dom.removeAttribute("data-level");
        dom.querySelector(':scope > div > [data-type="detailsContent"]')?.toggleAttribute("hidden", !open);
      };
      setTimeout(() => sync(props.node)); // after the stock view's own first toggle
      // The stock arrow saves the toggle's attributes as just `open`, which drops a toggle heading's
      // level: this handler runs first (capturing on the toggle) and changes `open` alone.
      const button = dom.querySelector<HTMLButtonElement>(":scope > button");
      dom.addEventListener(
        "click",
        (event) => {
          if (event.target !== button) return;
          event.stopPropagation();
          const { editor, getPos } = props;
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (!editor.isEditable || typeof pos !== "number") {
            const open = !dom.classList.contains("is-open");
            dom.classList.toggle("is-open", open);
            dom.querySelector(':scope > div > [data-type="detailsContent"]')?.toggleAttribute("hidden", !open);
            return;
          }
          const { from, to } = editor.state.selection;
          editor
            .chain()
            .command(({ tr }) => {
              const node = tr.doc.nodeAt(pos);
              if (node?.type.name !== "details") return false;
              tr.setNodeAttribute(pos, "open", !node.attrs.open);
              return true;
            })
            .setTextSelection({ from, to })
            .focus(undefined, { scrollIntoView: false })
            .run();
        },
        true,
      );
      const update = view.update?.bind(view);
      return {
        ...view,
        update: (node, decorations, inner) => {
          const ok = update ? update(node, decorations, inner) : false;
          if (ok) sync(node);
          return ok;
        },
      };
    };
  },
  addKeyboardShortcuts() {
    const base = this.parent?.() ?? {};
    return {
      ...base,
      // Backspace at the start of a toggle's title unwraps it: a toggle heading becomes a heading of its
      // level, a toggle becomes text, its contents following (as in Notion).
      Backspace: (props) => {
        const { $from, empty } = this.editor.state.selection;
        if (empty && $from.parent.type.name === "detailsSummary" && $from.parentOffset === 0) {
          return this.editor.chain().command(unwrapToggle($from.node($from.depth - 1).attrs.level ?? null)).scrollIntoView().run();
        }
        return base.Backspace?.(props) ?? false;
      },
    };
  },
  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (src: string) => src.indexOf("<details"),
    tokenize(src, _tokens, lexer) {
      const d = takeDetails(src);
      if (!d) return undefined;
      const heading = SUMMARY_HEADING.exec(d.summary);
      const summary = heading ? heading[2].trim() : d.summary;
      return { type: "details", raw: d.raw, open: d.open, level: heading ? Number(heading[1]) : null, summaryTokens: lexer.inlineTokens(summary), tokens: lexer.blockTokens(d.inner) };
    },
  },
  parseMarkdown: (token, h) => {
    const content = h.parseChildren(token.tokens ?? []);
    return {
      type: "details",
      attrs: { open: token.open, level: token.level ?? null },
      content: [
        { type: "detailsSummary", content: h.parseInline(token.summaryTokens ?? []) },
        { type: "detailsContent", content: content.length ? content : [{ type: "paragraph" }] },
      ],
    };
  },
  renderMarkdown: (node, h) => {
    const [summary, body] = (node.content ?? []) as JSONContent[];
    const inner = body ? h.renderChildren(body.content ?? [], "\n\n").trim() : "";
    const title = summary?.content?.length ? h.renderChildren(summary.content) : "";
    const level = node.attrs?.level;
    return `<details${node.attrs?.open ? " open" : ""}>\n<summary>${level ? `<h${level}>${title}</h${level}>` : title}</summary>\n\n${inner}\n\n</details>`;
  },
}).configure({ persist: true });

/** A toggle's title. Pasted HTML puts a toggle heading's title in a heading: <summary><h2>Title</h2></summary>. */
export const ToggleSummary = DetailsSummary.extend({
  parseHTML() {
    return [{ tag: "summary", contentElement: (el: HTMLElement) => el.querySelector<HTMLElement>(":scope > h1, :scope > h2, :scope > h3") ?? el }];
  },
});

// ---------- columns ----------

/** `<div class="column">`, optionally with its share of the row: `data-width="0.8"` (Notion's ratio). */
const COLUMN_OPEN = /^<div class="column"(?: data-width="(\d*\.?\d+)")?>$/;

function takeColumns(src: string) {
  if (!src.startsWith('<div class="columns">')) return undefined;
  const lines = src.split("\n");
  const columns: string[] = [];
  const widths: (number | null)[] = [];
  let i = 1;
  let current: string[] | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const open = current ? null : COLUMN_OPEN.exec(line);
    if (current) {
      if (line === "</div>") {
        columns.push(current.join("\n").trim());
        current = null;
      } else current.push(lines[i]);
    } else if (open) {
      current = [];
      widths.push(open[1] ? Number(open[1]) : null);
    } else if (line === "</div>") break;
    else if (line !== "") return undefined;
  }
  if (i >= lines.length || columns.length < 2) return undefined;
  const raw = lines.slice(0, i + 1).join("\n") + (i + 1 < lines.length ? "\n" : "");
  return { raw, columns, widths };
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  addAttributes() {
    return {
      // Share of the row (e.g. 0.8); columns without one split the row evenly.
      width: {
        default: null,
        parseHTML: (el) => (el.dataset.width ? Number(el.dataset.width) || null : null),
        renderHTML: (attrs) => (attrs.width ? { "data-width": attrs.width, style: `flex-grow: ${attrs.width}` } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-column": "", class: "column" }), 0];
  },
});

/** How close (px) to the border between two columns the pointer must be to resize them. */
const GRAB = 6;
/** Narrowest a column can be dragged (px). */
const MIN_COLUMN = 80;

/**
 * Drag the border between two columns to share their width differently. The grab strip is just
 * left of the gap (the gap itself holds the block handle of the right-hand column); the new
 * shares are saved as each column's `width`.
 */
function columnResizing() {
  let line: HTMLDivElement | null = null;
  // The column whose left border is under the pointer.
  const borderAt = (view: EditorView, e: MouseEvent): HTMLElement | null => {
    for (const list of view.dom.querySelectorAll<HTMLElement>(".columns")) {
      const r = list.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) continue;
      const cols = [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("column"));
      for (const col of cols.slice(1)) {
        const x = col.getBoundingClientRect().left;
        if (e.clientX >= x - GRAB && e.clientX <= x + 2) return col;
      }
    }
    return null;
  };
  const show = (view: EditorView, col: HTMLElement | null) => {
    view.dom.style.cursor = col ? "col-resize" : "";
    if (!line) return;
    if (!col) return void (line.style.display = "none");
    const list = col.parentElement!.getBoundingClientRect();
    // On the grab strip itself, so the line sits under the pointer.
    const x = col.getBoundingClientRect().left - GRAB / 2 + 1;
    Object.assign(line.style, { display: "block", left: `${x - 1}px`, top: `${list.top}px`, height: `${list.height}px` });
  };

  return new Plugin({
    key: new PluginKey("columnResizing"),
    view() {
      line = document.createElement("div");
      line.className = "column-resize-line";
      document.body.appendChild(line);
      return { destroy: () => (line?.remove(), (line = null)) };
    },
    props: {
      handleDOMEvents: {
        mousemove(view, e) {
          if (e.buttons === 0) show(view, borderAt(view, e));
          return false;
        },
        mouseleave(view) {
          show(view, null);
          return false;
        },
        mousedown(view, e) {
          const right = e.button === 0 ? borderAt(view, e) : null;
          if (!right) return false;
          e.preventDefault();
          const list = right.parentElement!;
          const cols = [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("column"));
          const at = cols.indexOf(right);
          // The row's columns in the document, and their content widths now.
          const $in = view.state.doc.resolve(view.posAtDOM(cols[0], 0));
          let depth = $in.depth;
          while (depth > 0 && $in.node(depth).type.name !== "columnList") depth--;
          if (!depth) return false;
          const listPos = $in.before(depth);
          const start = cols.map((c) => c.clientWidth - (parseFloat(getComputedStyle(c).paddingLeft) || 0));
          const startX = e.clientX;
          const original = view.state.doc.nodeAt(listPos)!;

          const apply = (widths: number[], history: boolean) => {
            const total = widths.reduce((a, b) => a + b, 0);
            const tr = view.state.tr;
            let pos = listPos + 1;
            view.state.doc.nodeAt(listPos)!.forEach((col, _o, i) => {
              tr.setNodeMarkup(pos, undefined, { ...col.attrs, width: Number((widths[i] / total).toFixed(3)) });
              pos += col.nodeSize;
            });
            if (!history) tr.setMeta("addToHistory", false);
            view.dispatch(tr);
          };
          const widthsFor = (x: number) => {
            const pair = start[at - 1] + start[at];
            const left = Math.min(pair - MIN_COLUMN, Math.max(MIN_COLUMN, start[at - 1] + x - startX));
            return start.map((w, i) => (i === at - 1 ? left : i === at ? pair - left : w));
          };
          // Resizing redraws the columns, so the line follows the column as it is now.
          const current = () => {
            const el = view.nodeDOM(listPos);
            return el instanceof HTMLElement ? (el.querySelectorAll<HTMLElement>(":scope > .column")[at] ?? null) : null;
          };
          let last = start;
          const move = (ev: MouseEvent) => {
            last = widthsFor(ev.clientX);
            apply(last, false);
            show(view, current());
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            document.body.style.removeProperty("cursor");
            document.body.style.removeProperty("user-select");
            // One undo step for the whole drag: back to where it started, then the result.
            const tr = view.state.tr.replaceWith(listPos, listPos + view.state.doc.nodeAt(listPos)!.nodeSize, original);
            view.dispatch(tr.setMeta("addToHistory", false));
            if (last !== start) apply(last, true);
            show(view, null);
          };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
          return true;
        },
      },
    },
  });
}

export const ColumnList = Node.create({
  name: "columnList",
  addKeyboardShortcuts() {
    return {
      // Backspace at the start of a block right below columns would join it into the row as a new
      // column. Instead: an empty block goes, a block with text stays; the cursor moves to the end
      // of the last column.
      Backspace: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parentOffset !== 0 || !$from.parent.isTextblock) return false;
        const blockPos = $from.before($from.depth);
        if (state.doc.resolve(blockPos).nodeBefore?.type.name !== this.name) return false;
        const tr = state.tr;
        if ($from.parent.content.size === 0) tr.delete(blockPos, blockPos + $from.parent.nodeSize);
        // blockPos - 2: inside the last column, at its end.
        view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(blockPos - 2), -1)).scrollIntoView());
        return true;
      },
    };
  },
  group: "block",
  content: "column{2,}",
  defining: true,
  addProseMirrorPlugins() {
    return [columnResizing()];
  },
  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-columns": "", class: "columns" }), 0];
  },
  markdownTokenizer: {
    name: "columnList",
    level: "block",
    start: (src: string) => src.indexOf('<div class="columns">'),
    tokenize(src, _tokens, lexer) {
      const c = takeColumns(src);
      if (!c) return undefined;
      return { type: "columnList", raw: c.raw, columns: c.columns.map((col) => lexer.blockTokens(col)), widths: c.widths };
    },
  },
  parseMarkdown: (token, h) => ({
    type: "columnList",
    content: (token.columns as never[][]).map((toks, i) => {
      const content = h.parseChildren(toks);
      const width = (token.widths as (number | null)[] | undefined)?.[i] ?? null;
      return { type: "column", attrs: { width }, content: content.length ? content : [{ type: "paragraph" }] };
    }),
  }),
  renderMarkdown: (node, h) =>
    `<div class="columns">\n${((node.content ?? []) as JSONContent[])
      .map((col) => `<div class="column"${col.attrs?.width ? ` data-width="${col.attrs.width}"` : ""}>\n\n${h.renderChildren(col.content ?? [], "\n\n").trim()}\n\n</div>`)
      .join("\n")}\n</div>`,
});

// ---------- embedded database / page ----------

export const DatabaseEmbed = Node.create({
  name: "databaseEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { target: { default: "", parseHTML: (el) => el.getAttribute("data-target") } };
  },
  parseHTML() {
    return [{ tag: "div[data-embed]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-embed": "", "data-target": node.attrs.target }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView, { stopEvent: ({ event }) => !event.type.startsWith("drag"), ignoreMutation: () => true });
  },
  markdownTokenizer: {
    name: "databaseEmbed",
    level: "block",
    start: (src: string) => src.indexOf("![["),
    tokenize(src) {
      const m = /^!\[\[([^\]\n|]+)\]\][ \t]*(?:\n|$)/.exec(src);
      return m ? { type: "databaseEmbed", raw: m[0], target: m[1].trim() } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "databaseEmbed", attrs: { target: token.target } }),
  renderMarkdown: (node) => `![[${node.attrs?.target}]]`,
});

/** How many database-views blocks a document holds (one on a database's own page, else none). */
function viewsBlocks(doc: PMNode) {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === "databaseViews") n++;
    return !node.isTextblock;
  });
  return n;
}

/**
 * On a database's own page: its views (table, board, calendar…) as one block among the page's
 * text, so text can sit above or below them, and either can be dragged. Saved as the page's schema
 * block (see `bodyFromEditor`); here it's just a placeholder line. There's always exactly one:
 * it can't be deleted, cut or duplicated, and none can be pasted into another page.
 */
export const DatabaseViews = Node.create({
  name: "databaseViews",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() {
    return [{ tag: "div[data-database-views]" }];
  },
  renderHTML() {
    return ["div", { "data-database-views": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DatabaseViewsView, { stopEvent: ({ event }) => !event.type.startsWith("drag"), ignoreMutation: () => true });
  },
  addProseMirrorPlugins() {
    // Moving it (a drag deletes and inserts in one step) keeps the count; anything else is refused.
    return [new Plugin({ filterTransaction: (tr, state) => !tr.docChanged || viewsBlocks(tr.doc) === viewsBlocks(state.doc) })];
  },
  markdownTokenizer: {
    name: "databaseViews",
    level: "block",
    start: (src: string) => src.indexOf(VIEWS_MARKER),
    tokenize(src) {
      const m = new RegExp(`^${VIEWS_MARKER}[ \\t]*(?:\\n|$)`).exec(src);
      return m ? { type: "databaseViews", raw: m[0] } : undefined;
    },
  },
  parseMarkdown: () => ({ type: "databaseViews" }),
  renderMarkdown: () => VIEWS_MARKER,
});

function DatabaseViewsView() {
  const page = useContext(PageContext);
  return (
    <NodeViewWrapper data-database-views contentEditable={false} className="my-4">
      {page && <DatabaseView path={page} />}
    </NodeViewWrapper>
  );
}

/** The vault path of the page an editor shows, for blocks that behave differently by page. */
export const PageContext = createContext<string | null>(null);

function EmbedView({ node }: NodeViewProps) {
  const { notes, openPage } = useVault();
  const page = useContext(PageContext);
  const target = resolveWikiLink(node.attrs.target, notes);
  // A database shown away from home (not on its own page or the page it sits under) is a linked
  // copy: its views and filters belong to this page.
  const parent = target?.path.includes("/") ? `${target.path.slice(0, target.path.lastIndexOf("/"))}.md` : null;
  const home = !page || !target || target.path === page || parent === page;
  const scope = home ? undefined : `[[${page!.replace(/\.md$/, "")}]]`;
  return (
    <NodeViewWrapper className="my-2" contentEditable={false}>
      {target?.kind === "database" ? (
        <DatabaseView path={target.path} inline scope={scope} />
      ) : (
        <button onClick={() => target && openPage(target.path)} className="flex w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-sm hover:bg-hover">
          {target?.icon ? <PageIcon icon={target.icon} size={18} /> : <FileText size={16} className="text-faint" />}
          <span className={target ? "text-ink" : "text-faint"}>{target ? target.title : `Missing page: ${node.attrs.target}`}</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

// ---------- code block ----------

export const LANGUAGES: [string, string][] = [
  ["", "Plain text"],
  ["bash", "Bash"],
  ["bash-profile", "Bash + profile"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["graphql", "GraphQL"],
  ["xml", "HTML / XML"],
  ["ini", "INI / TOML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["lua", "Lua"],
  ["makefile", "Makefile"],
  ["markdown", "Markdown"],
  ["objectivec", "Objective-C"],
  ["php", "PHP"],
  ["python", "Python"],
  ["r", "R"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["scss", "SCSS"],
  ["shell", "Shell"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
  ["zsh", "Zsh"],
];

/** What people type after ``` for a menu language (the menu shows and ticks the language it stands for). */
const ALIASES: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", py: "python", rs: "rust", html: "xml", yml: "yaml", toml: "ini", jsx: "javascript", tsx: "typescript" };

/** Shell and Python blocks run with Ctrl-E or their Run button (desktop only). The output shows under the block and isn't saved. */
const RUNNABLE: Record<string, true> = { bash: true, "bash-profile": true, sh: true, shell: true, zsh: true, python: true, py: true };
/** What a run of each loads from the user's setup (see script.rs), shown in the language menu. */
const RUN_SETUP: Record<string, string> = { "bash-profile": "~/.bash_profile, ~/.profile", shell: "PATH, exports", zsh: "~/.zshrc", python: "python3, your PATH" };
const runnable = (language: unknown) => typeof language === "string" && RUNNABLE[language] === true && currentPlatform() === "desktop";
/** The code blocks on screen that can run, so Ctrl-E finds the one with the cursor. */
const runners = new Set<{ editor: TiptapEditor; pos: () => number | undefined; runLine: () => void }>();
/** Only the end of very long output is kept, so a chatty script can't grow the page without bound. */
const MAX_OUTPUT = 200_000;
let runIds = 0;

/** Ctrl-E in a shell or Python block runs the line the cursor is on. Ahead of Tiptap's own Ctrl-E (end of block, on macOS). */
const RunShortcut = Extension.create({
  name: "codeBlockRun",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Ctrl-e": () => {
        const { $from } = this.editor.state.selection;
        if ($from.parent.type.name !== "codeBlock" || !runnable($from.parent.attrs.language)) return false;
        const pos = $from.before();
        const runner = [...runners].find((r) => r.editor === this.editor && r.pos() === pos);
        runner?.runLine();
        return !!runner;
      },
    };
  },
});

export const CodeBlock = TiptapCodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addExtensions() {
    return [...(this.parent?.() ?? []), RunShortcut];
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), codeHighlight()];
  },
}).configure({ defaultLanguage: null, enableTabIndentation: true });

/** A run of a shell or Python block (or one of its lines): its output so far, then its exit code (null when stopped) or why it couldn't start. */
type ScriptRun = { id: number; line?: number; output: string; exit?: number | null; error?: string };

/** The line of a code block at `pos` that the cursor is on (1-based), or null when the cursor is elsewhere. */
function cursorLine(editor: TiptapEditor, pos: number | undefined): { number: number; text: string } | null {
  const block = pos === undefined ? null : editor.state.doc.nodeAt(pos);
  if (pos === undefined || !block) return null;
  const offset = editor.state.selection.head - (pos + 1);
  if (offset < 0 || offset > block.content.size) return null;
  const text = block.textContent;
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return { number: text.slice(0, start).split("\n").length, text: text.slice(start, end < 0 ? undefined : end) };
}

function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [run, setRun] = useState<ScriptRun | null>(null);
  // The output panel scrolls past a fixed height; expanded, it shows everything.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = outputRef.current;
    setOverflows(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [run?.output, run?.error, wrap, expanded]);
  const lang = ALIASES[node.attrs.language] ?? node.attrs.language ?? "";
  const label = LANGUAGES.find(([id]) => id === lang)?.[1] ?? (lang || "Plain text");
  const canRun = runnable(node.attrs.language);
  const running = !!run && run.exit === undefined && run.error === undefined;
  // The line "Run line" would run (null when the cursor isn't on a non-blank line here); re-read on every selection change.
  const line = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const at = canRun ? cursorLine(e, getPos()) : null;
      return at?.text.trim() ? at.number : null;
    },
  });

  const live = useRef<number | null>(null);
  /** Runs the whole block, or just `line`. */
  const start = (only?: { number: number; text: string }) => {
    if (live.current !== null) return;
    const id = ++runIds;
    live.current = id;
    const patch = (f: (r: ScriptRun) => ScriptRun) => setRun((r) => (r?.id === id ? f(r) : r));
    setRun({ id, line: only?.number, output: "" });
    api.runScript(id, node.attrs.language, only?.text ?? node.textContent, (chunk) => patch((r) => ({ ...r, output: (r.output + chunk).slice(-MAX_OUTPUT) }))).then(
      (exit) => patch((r) => ({ ...r, exit })),
      (e) => patch((r) => ({ ...r, error: String(e) })),
    ).finally(() => {
      if (live.current === id) live.current = null;
    });
  };
  const runLine = () => {
    const only = cursorLine(editor, getPos());
    if (!only?.text.trim()) return;
    // A Python line taken out of its `for` or `def` would be an IndentationError with its indent.
    start(lang === "python" ? { ...only, text: only.text.trimStart() } : only);
  };
  const runLineRef = useRef(runLine);
  runLineRef.current = runLine;
  useEffect(() => {
    if (!canRun) return;
    const entry = { editor, pos: getPos, runLine: () => runLineRef.current() };
    runners.add(entry);
    return () => void runners.delete(entry);
  }, [canRun, editor, getPos]);
  // A script doesn't outlive its block: closing the page or deleting the block stops it.
  useEffect(() => () => void (live.current !== null && api.stopScript(live.current)), []);

  return (
    <NodeViewWrapper className="code-block group/code">
      <div contentEditable={false} className="code-toolbar">
        <button onClick={(e) => setMenu(e.currentTarget)} className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-hover">
          {label} <ChevronDown size={12} />
        </button>
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/code:opacity-100">
          {canRun && (
            <>
              <button
                // Keep the cursor (and so the line) where it is.
                onMouseDown={(e) => e.preventDefault()}
                onClick={runLine}
                disabled={running || line === null}
                title={line === null ? "Put the cursor on a line to run just that line (⌃E)" : `Run line ${line} (⌃E)`}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-50"
              >
                <FileTerminal size={12} /> Run line
              </button>
              <button onClick={() => start()} disabled={running} title="Run the whole block" className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-50">
                <FilePlay size={12} /> Run
              </button>
            </>
          )}
          <button onClick={() => setWrap((w) => !w)} className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover ${wrap ? "text-ink" : ""}`}>
            <WrapText size={12} /> Wrap
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(node.textContent);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre className={wrap ? "wrap" : ""}>
        <NodeViewContent<"code"> as="code" className={lang ? `language-${lang}` : undefined} />
      </pre>
      {run && (
        <div contentEditable={false} className="code-output">
          <div className="code-output-bar">
            {running ? (
              <>
                <LoaderCircle size={12} className="animate-spin" /> {run.line ? `Running line ${run.line}…` : "Running…"}
              </>
            ) : (
              <span className={run.error || run.exit ? "text-[var(--c-red-text)]" : ""}>
                {run.line ? `Line ${run.line} · ` : ""}
                {run.error ? "Couldn't run" : run.exit === null ? "Stopped" : `Exited with ${run.exit}`}
              </span>
            )}
            <span className="ml-auto flex items-center gap-0.5">
              {(expanded || overflows) && (
                <button onClick={() => setExpanded((x) => !x)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover">
                  {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />} {expanded ? "Collapse" : "Expand"}
                </button>
              )}
              {running ? (
                <button onClick={() => api.stopScript(run.id)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover">
                  <Square size={11} /> Stop
                </button>
              ) : (
                <button onClick={() => setRun(null)} title="Clear output" className="grid size-5 place-items-center rounded hover:bg-hover">
                  <X size={12} />
                </button>
              )}
            </span>
          </div>
          {(run.output || run.error) && (
            <pre ref={outputRef} className={`${wrap ? "wrap" : ""} ${expanded ? "expanded" : ""}`}>
              {run.error ?? run.output}
            </pre>
          )}
        </div>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => (setMenu(null), setQuery(""))} className="w-72 p-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a language…"
            className="mb-1 h-7 w-full rounded-md border border-line bg-side px-2 text-sm text-ink outline-none focus:border-[var(--blue)]"
          />
          <div className="max-h-64 overflow-y-auto">
            {LANGUAGES.filter(([, name]) => name.toLowerCase().includes(query.toLowerCase())).map(([id, name]) => (
              <MenuItem
                key={id || "plain"}
                label={name}
                hint={runnable(id) ? RUN_SETUP[id] : undefined}
                right={id === lang ? <Check size={14} className="text-muted" /> : null}
                onClick={() => {
                  updateAttributes({ language: id || null });
                  setMenu(null);
                  setQuery("");
                }}
              />
            ))}
          </div>
        </Popover>
      )}
    </NodeViewWrapper>
  );
}

// ---------- image ----------

// A width (px) keeps a resized image's size; its height follows the aspect ratio. In Markdown the
// width is Obsidian's: ![alt|320](src). Obsidian's ![alt|320x200](src) reads too, keeping only the width.
const WIDTH_IN_ALT = /^(.*?)\s*\|\s*(\d+)(?:x\d+)?$/;

export const ImageBlock = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (el) => Number.parseInt(el.getAttribute("width") ?? "", 10) || null },
    };
  },
  parseMarkdown: (token, h) => {
    const sized = WIDTH_IN_ALT.exec(token.text ?? "");
    return h.createNode("image", { src: token.href, title: token.title, alt: sized ? sized[1] : token.text, width: sized ? Number(sized[2]) || null : null });
  },
  renderMarkdown: (node) => {
    const { src, alt, title, width } = node.attrs ?? {};
    const label = `${alt ?? ""}${width ? `|${width}` : ""}`;
    return title ? `![${label}](${src ?? ""} "${title}")` : `![${label}](${src ?? ""})`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("imageFiles"),
        props: {
          // Files dropped (e.g. from Finder) or pasted are copied into `.assets/`: images are embedded,
          // anything else is attached (see FileAttachment).
          handleDrop: (view, event, _slice, moved) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (moved || !files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            void insertFiles(view, files, at ? at.pos : view.state.selection.from, editor.storage.fileAttachment.page);
            return true;
          },
          handlePaste: (view, event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            void insertFiles(view, files, view.state.selection.from, editor.storage.fileAttachment.page);
            return true;
          },
        },
      }),
    ];
  },
});

/** Saves each file into `.assets/` and puts it in the page at `pos`, in order: an image block or an attachment. */
async function insertFiles(view: EditorView, files: File[], pos: number, page: string | null) {
  for (const file of files) {
    const { schema } = view.state;
    let node;
    try {
      const bytes = await file.arrayBuffer();
      if (file.type.startsWith("image/")) {
        const src = await api.saveAsset(file.name || "image.png", [...new Uint8Array(bytes)]);
        node = schema.nodes.image.create({ src, alt: file.name.replace(/\.\w+$/, "") });
      } else {
        const name = file.name || "file";
        const src = assetHref(await api.attachBytes(name, bytes, page));
        node = schema.nodes.paragraph.create(null, schema.nodes.fileAttachment.create({ src, name }));
      }
    } catch (e) {
      console.error(`Couldn't save ${file.name}`, e);
      continue;
    }
    if (view.isDestroyed) return;
    const at = Math.min(pos, view.state.doc.content.size);
    const tr = view.state.tr.replaceRangeWith(at, at, node);
    view.dispatch(tr);
    // The next file goes right after this one.
    pos = tr.mapping.map(at);
  }
}

/** The `/File` command: asks for files to attach and puts them at the cursor, each on its own line. */
export async function pickAttachments(editor: TiptapEditor) {
  const page = editor.storage.fileAttachment.page;
  const picked = await openDialog({ multiple: true, title: "Attach files" });
  const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
  const lines: JSONContent[] = [];
  for (const path of paths) {
    try {
      const src = assetHref(await api.attachFile(path, page));
      lines.push({ type: "paragraph", content: [{ type: "fileAttachment", attrs: { src, name: path.split(/[\\/]/).pop() } }] });
    } catch (e) {
      console.error(`Couldn't attach ${path}`, e);
    }
  }
  if (lines.length && !editor.isDestroyed) editor.chain().focus().insertContent(lines).run();
}

// ---------- file attachment ----------

/**
 * `[Report.pdf](.assets/Report-123.pdf)`: a link to a file in the workspace's `.assets/` folder, shown
 * as a chip that opens the file. Plain Markdown, the same form imports write attachments in, so other
 * apps see an ordinary link.
 */
const ATTACHMENT = /^\[((?:\\.|[^\]\\\n])*)\]\((\.assets\/[^)\s]+)\)/;

/** A vault path as written in a Markdown link: spaces, brackets and `%` escaped as `%XX` (as Obsidian and GitHub read them). */
export const assetHref = (path: string) => path.replace(/[ %()<>[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** The vault path a link points to (its `%XX` escapes decoded). */
export function assetPath(href: string) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    // `src` is the link as written in the Markdown; assetPath() gives the file's vault path.
    return { src: { default: "" }, name: { default: "" } };
  },
  addStorage() {
    return { page: null as string | null };
  },
  parseHTML() {
    // Ahead of the link mark, which also matches `a[href]`.
    return [{ tag: "a[data-attachment]", priority: 60, getAttrs: (el) => ({ src: el.getAttribute("href"), name: el.textContent }) }];
  },
  renderHTML({ node }) {
    return ["a", { href: node.attrs.src, "data-attachment": "" }, node.attrs.name];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
  // When the last link to a file leaves the page (Backspace, cut, deleting its block, its bin
  // button), the file leaves `.assets/` too, unless another page links to it. It waits in the Trash:
  // if the link comes back (undo, pasted elsewhere), showing it brings the file back (file_size).
  addProseMirrorPlugins() {
    const { name, storage } = this;
    const linked = (doc: PMNode) => {
      const srcs = new Set<string>();
      doc.descendants((n) => void (n.type.name === name && srcs.add(n.attrs.src)));
      return srcs;
    };
    return [
      new Plugin({
        key: new PluginKey("attachmentFiles"),
        view: (view) => {
          let current = linked(view.state.doc);
          return {
            update: (v, prev) => {
              if (v.state.doc === prev.doc) return;
              const next = linked(v.state.doc);
              const page = storage.page;
              for (const src of current) {
                if (!next.has(src) && page) void api.deleteAttachment(assetPath(src), page).catch(() => {});
              }
              current = next;
            },
          };
        },
      }),
    ];
  },
  markdownTokenizer: {
    name: "fileAttachment",
    level: "inline",
    // Never right after "!": that's an image.
    start: (src: string) => src.search(/(?<!!)\[(?:\\.|[^\]\\\n])*\]\(\.assets\//),
    tokenize(src) {
      const m = ATTACHMENT.exec(src);
      return m ? { type: "fileAttachment", raw: m[0], name: m[1].replace(/\\(.)/g, "$1"), src: m[2] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "fileAttachment", attrs: { src: token.src, name: token.name } }),
  renderMarkdown: (node) => `[${String(node.attrs?.name ?? "").replace(/[\\[\]]/g, "\\$&")}](${node.attrs?.src})`,
});

const ATTACHMENT_ICONS: [RegExp, typeof FileText][] = [
  [/\.(pdf|docx?|odt|rtf|txt|md|pages)$/i, FileText],
  [/\.(xlsx?|ods|csv|tsv|numbers)$/i, FileSpreadsheet],
  [/\.(pptx?|odp|key)$/i, Presentation],
  [/\.(zip|gz|tgz|bz2|xz|7z|rar|tar|dmg)$/i, FileArchive],
  [/\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i, FileMusic],
  [/\.(mp4|mov|m4v|mkv|avi|webm)$/i, FileVideoCamera],
  [/\.(png|jpe?g|gif|webp|heic|tiff?|bmp|svg|psd)$/i, FileImage],
  [/\.(json|ya?ml|xml|html?|css|js|ts|tsx|py|rb|go|rs|java|c|cpp|h|sh|sql)$/i, FileCode],
];

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) (n /= 1024), u++;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/**
 * An attached file: its icon, name and size. Click opens it: text and code in a tab with a code
 * editor, anything else in its own app; ⌘-click shows it in Finder. Its bin (on hover) removes it
 * from the page, and with it the file (see FileAttachment's plugin); undo brings both back.
 */
function AttachmentView({ node, selected, deleteNode }: NodeViewProps) {
  const { src, name } = node.attrs as { src: string; name: string };
  const { openPage } = useVault();
  // undefined: not known (yet, or this app can't tell); null: the file isn't there.
  const [size, setSize] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.fileSize(assetPath(src)).then(
      (s) => alive && setSize(s),
      () => alive && setSize(undefined),
    );
    return () => {
      alive = false;
    };
  }, [src]);
  const missing = size === null;
  const Icon = ATTACHMENT_ICONS.find(([re]) => re.test(name) || re.test(src))?.[1] ?? FileGeneric;
  // Text and code open in a tab of their own, in a code editor (desktop); the rest in their own app.
  const inTab = !missing && currentPlatform() === "desktop" && opensInEditor(name || src);
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    if (missing) return;
    if (inTab && !e.metaKey) return openPage(fileTab(assetPath(src)), { newTab: true });
    void api.openAttachment(assetPath(src), e.metaKey).catch(() => setSize(null));
  };
  const remove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deleteNode();
  };
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-attachment
      onClick={open}
      title={missing ? `${src}\nThis file isn't in the workspace` : `${name}\nClick to open${inTab ? " in a tab" : ""} · ⌘-click to show in Finder`}
      className={`group/att relative mx-px inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-line bg-side px-2 py-0.5 align-middle text-[0.9em] leading-normal hover:bg-hover ${
        selected ? "ring-2 ring-[var(--blue)]/50" : ""
      } ${missing ? "opacity-60" : ""}`}
    >
      <Icon size={15} className="shrink-0 text-muted" />
      <span className={`min-w-0 truncate text-ink ${missing ? "line-through" : ""}`}>{name || src.split("/").pop()}</span>
      {size != null && <span className="shrink-0 text-xs text-faint">{formatFileSize(size)}</span>}
      {missing && <span className="shrink-0 text-xs text-faint">missing</span>}
      {/* Floats over the chip's end on hover, so nothing around the chip moves. */}
      <button
        title="Delete file"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={remove}
        className="absolute top-1/2 right-1 hidden size-5 -translate-y-1/2 place-items-center rounded border border-line bg-raised text-muted shadow-sm group-hover/att:grid hover:text-[var(--c-red-text)]"
      >
        <Trash2 size={13} />
      </button>
    </NodeViewWrapper>
  );
}

function ImageView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const [link, setLink] = useState("");
  if (!node.attrs.src) {
    return (
      <NodeViewWrapper contentEditable={false} className="my-1">
        <div className="rounded-md bg-side p-3">
          <div className="mb-2 flex items-center gap-2 text-sm text-muted">
            <ImageIcon size={16} /> Add an image
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim()) updateAttributes({ src: link.trim() });
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && deleteNode()}
              placeholder="Paste the image link…"
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-sm text-ink outline-none focus:border-[var(--blue)]"
            />
            <button className="h-8 rounded-md bg-[var(--blue)] px-3 text-sm font-medium text-white">Embed image</button>
          </form>
        </div>
      </NodeViewWrapper>
    );
  }
  return (
    <ImageBlockView
      src={node.attrs.src}
      alt={node.attrs.alt ?? ""}
      width={node.attrs.width}
      selected={selected}
      onDelete={deleteNode}
      onResize={(width) => updateAttributes({ width })}
    />
  );
}

/** Narrowest an image can be dragged to, in px. */
const MIN_IMAGE_WIDTH = 48;

/**
 * An image block: a hover toolbar (view full size, copy, delete), handles on both sides to resize it
 * (double-click one for the image's own size); double-click the image to view it full size.
 */
function ImageBlockView({
  src,
  alt,
  width,
  selected,
  onDelete,
  onResize,
}: {
  src: string;
  alt: string;
  width: number | null;
  selected: boolean;
  onDelete: () => void;
  onResize: (width: number | null) => void;
}) {
  const url = useAssetUrl(src);
  const [viewing, setViewing] = useState(false);
  const [copied, setCopied] = useState(false);
  // The width while a handle is dragged; saved to the page when it's let go.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const img = useRef<HTMLImageElement>(null);
  // Toolbar buttons act on mouse down and keep the editor from treating the press as its own.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  // `side` is 1 for the right handle, -1 for the left: dragging either outwards widens the image.
  const startResize = (side: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = img.current;
    // The node view's own box spans the page's width: the widest the image can be.
    const max = el?.parentElement?.parentElement?.clientWidth;
    if (!el || !max) return;
    const startX = e.clientX;
    const startWidth = el.getBoundingClientRect().width;
    let next = startWidth;
    const move = (ev: MouseEvent) => {
      next = Math.round(Math.min(max, Math.max(MIN_IMAGE_WIDTH, startWidth + side * (ev.clientX - startX))));
      setDragWidth(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.removeProperty("cursor");
      setDragWidth(null);
      if (next !== Math.round(startWidth)) onResize(next);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const shown = dragWidth ?? width;
  const diagram = isEditableDiagram(src);
  const editDiagram = () =>
    api.readAsset(src).then(
      (buf) =>
        openDiagramEditor({
          svg: new Uint8Array(buf),
          onSave: (bytes) => api.writeAsset(src, [...bytes]).then(() => assetChanged(src)),
        }),
      (e) => console.error("Couldn't open the diagram", e),
    );
  return (
    <NodeViewWrapper className={`group/img relative my-1 w-fit max-w-full ${selected ? "rounded ring-2 ring-[var(--blue)]/50" : ""}`}>
      {url ? (
        <>
          <img ref={img} src={url} alt={alt} style={shown ? { width: shown } : undefined} className="block max-w-full rounded-sm" draggable={false} />
          {/* Covers the photo so WebKit's Live Text can't pick out words in it: a click selects the
              image block, a double-click views it full size (or edits it, for a draw.io diagram). */}
          <div className="absolute inset-0" onDoubleClick={() => (diagram ? void editDiagram() : setViewing(true))} />
          {([-1, 1] as const).map((side) => (
            <button
              key={side}
              contentEditable={false}
              title="Drag to resize · double-click for the original size"
              onMouseDown={startResize(side)}
              onDoubleClick={act(() => onResize(null))}
              className={`absolute top-0 bottom-0 grid w-4 cursor-col-resize place-items-center transition-opacity ${side < 0 ? "left-0" : "right-0"} ${dragWidth === null ? "opacity-0 group-hover/img:opacity-100" : "opacity-100"}`}
            >
              <span className="h-12 max-h-[50%] w-1.5 rounded-full border border-white/80 bg-black/55 shadow-sm" />
            </button>
          ))}
        </>
      ) : (
        <div className="h-24 w-64 max-w-full animate-pulse rounded-sm bg-hover" />
      )}
      {url && (
        <div
          contentEditable={false}
          className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-line bg-raised/95 p-0.5 opacity-0 shadow-pop transition-opacity group-hover/img:opacity-100"
        >
          {diagram && (
            <ImgButton title="Edit diagram" onMouseDown={act(() => void editDiagram())}>
              <Pencil size={14} />
            </ImgButton>
          )}
          <ImgButton title="View full size" onMouseDown={act(() => setViewing(true))}>
            <Maximize2 size={14} />
          </ImgButton>
          <ImgButton
            title={copied ? "Copied" : "Copy image"}
            onMouseDown={act(() =>
              copyImage(url).then(
                () => (setCopied(true), setTimeout(() => setCopied(false), 1200)),
                () => { },
              ),
            )}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </ImgButton>
          <ImgButton title="Delete image" onMouseDown={act(onDelete)}>
            <Trash2 size={14} />
          </ImgButton>
        </div>
      )}
      {viewing && url && <Lightbox url={url} alt={alt} onClose={() => setViewing(false)} />}
    </NodeViewWrapper>
  );
}

const ImgButton = ({ title, onMouseDown, children }: { title: string; onMouseDown: (e: React.MouseEvent) => void; children: React.ReactNode }) => (
  <button title={title} onMouseDown={onMouseDown} className="grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
    {children}
  </button>
);

/** The image filling the window over a dimmed page; a click anywhere or Escape closes it. */
function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div onMouseDown={onClose} className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/85 p-8">
      <img src={url} alt={alt} className="max-h-[88vh] max-w-[92vw] object-contain shadow-2xl select-none" draggable={false} />
      {alt && <div className="max-w-[80vw] truncate text-sm text-white/70">{alt}</div>}
      <button title="Close (Esc)" className="absolute top-4 right-4 grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10">
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}

/** Copies an image as PNG (the type the clipboard takes everywhere). */
async function copyImage(url: string) {
  const blob = await (await fetch(url)).blob();
  const png =
    blob.type === "image/png"
      ? blob
      : await new Promise<Blob>((resolve, reject) => {
        const img = new window.Image(); // (Image here is the editor extension)
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d")!.drawImage(img, 0, 0);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png");
        };
        img.onerror = reject;
        img.src = url;
      });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Images can point into the workspace's `.assets/` folder, which the webview can't load directly. */
function useAssetUrl(src: string) {
  const local = src.startsWith(".assets/");
  const [url, setUrl] = useState<string | null>(local ? null : src);
  // Bumped when the file is rewritten (an edited diagram), to load it again.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!local) return;
    const onChange = (e: Event) => (e as CustomEvent<string>).detail === src && setVersion((v) => v + 1);
    window.addEventListener(ASSET_CHANGED, onChange);
    return () => window.removeEventListener(ASSET_CHANGED, onChange);
  }, [src, local]);
  useEffect(() => {
    if (!local) return setUrl(src);
    let alive = true;
    assetUrl(src).then((u) => alive && setUrl(u)).catch(() => { });
    return () => {
      alive = false;
    };
  }, [src, local, version]);
  return url;
}
