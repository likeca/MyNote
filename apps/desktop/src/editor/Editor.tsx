import { Extension, type Editor as CoreEditor } from "@tiptap/core";
import type { NestedOptions } from "@tiptap/extension-drag-handle";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { DetailsContent } from "@tiptap/extension-details";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Focus } from "@tiptap/extensions";
import { TableKit } from "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowUpRight,
  Bold,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  GripVertical,
  Highlighter,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Palette,
  Plus,
  Quote,
  RefreshCw,
  SquareCode,
  Strikethrough,
  Table2,
  Trash2,
  Type,
} from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PageIcon } from "../components/PageIcon";
import { MenuDivider, MenuItem, MenuSection, Popover } from "../components/Popover";
import { bgColor, textColor } from "../lib/colors";
import { wantsNewTab } from "../lib/nav";
import { Callout, CodeBlock, ColorMark, Column, ColumnList, DatabaseEmbed, DatabaseViews, FileAttachment, ImageBlock, PageContext, Toggle, ToggleHeadingIcon, ToggleSummary, toggleLevel, turnIntoToggle, unwrapToggle } from "./blocks";
import { ColorList } from "./ColorList";
import { ColorTableCell, ColorTableHeader, SimpleTable, cellColor, colorTable } from "./table";
import { TableControls, TableMenu, TableOptions } from "./TableControls";
import { normalizeMarkdown } from "./markdown";
import { BlockEquation, InlineEquation, MathAwareMarkdown } from "./math";
import { LINK_DATABASE, MentionSuggestion, NEW_SUBPAGE, PageLinkSuggestion, SlashCommand, type PageActions, type PageLinkOptions } from "./suggestions";
import { WikiLink } from "./WikiLink";

type Props = PageLinkOptions & {
  initial: string;
  page: PageActions;
  onChange: (markdown: string) => void;
  /** A page link was clicked; `newTab` for ⌘/Ctrl-click. */
  onOpenLink: (target: string, newTab: boolean) => void;
  /** Filled with the editor once it exists (the page title moves the cursor into it). */
  editorRef?: { current: TiptapEditor | null };
};

type TurnInto = { id: string; label: string; icon: ReactNode; active: (e: CoreEditor) => boolean; run: (e: CoreEditor) => void };

const inWrapper = (e: CoreEditor) => ["listItem", "taskItem", "blockquote", "callout", "details", "heading"].some((n) => e.isActive(n));

/** Starts a Turn into; on a toggle's title, the toggle is unwrapped first (its title becomes a heading of `level`, or text), its contents following, as in Notion. */
const turn = (e: CoreEditor, level: 1 | 2 | 3 | null = null) => (toggleLevel(e) === undefined ? e.chain().focus() : e.chain().focus().command(unwrapToggle(level)));

/** Block conversions shared by the block menu, the bubble menu and Cmd+Opt shortcuts. */
export const TURN_INTO: TurnInto[] = [
  { id: "text", label: "Text", icon: <Type size={16} />, active: (e) => e.isActive("paragraph") && !inWrapper(e), run: (e) => turn(e).clearNodes().run() },
  { id: "h1", label: "Heading 1", icon: <Heading1 size={16} />, active: (e) => e.isActive("heading", { level: 1 }), run: (e) => turn(e, 1).clearNodes().setNode("heading", { level: 1 }).run() },
  { id: "h2", label: "Heading 2", icon: <Heading2 size={16} />, active: (e) => e.isActive("heading", { level: 2 }), run: (e) => turn(e, 2).clearNodes().setNode("heading", { level: 2 }).run() },
  { id: "h3", label: "Heading 3", icon: <Heading3 size={16} />, active: (e) => e.isActive("heading", { level: 3 }), run: (e) => turn(e, 3).clearNodes().setNode("heading", { level: 3 }).run() },
  { id: "todo", label: "To-do list", icon: <ListTodo size={16} />, active: (e) => e.isActive("taskList"), run: (e) => turn(e).clearNodes().toggleTaskList().run() },
  { id: "bullet", label: "Bulleted list", icon: <List size={16} />, active: (e) => e.isActive("bulletList"), run: (e) => turn(e).clearNodes().toggleBulletList().run() },
  { id: "number", label: "Numbered list", icon: <ListOrdered size={16} />, active: (e) => e.isActive("orderedList"), run: (e) => turn(e).clearNodes().toggleOrderedList().run() },
  // On a block, these turn it into a toggle (its text becomes the title); on a toggle's title, they
  // switch it between a plain toggle and a toggle heading in place.
  ...([null, 1, 2, 3] as const).map(
    (level): TurnInto => ({
      id: level ? `toggle-h${level}` : "toggle",
      label: level ? `Toggle heading ${level}` : "Toggle list",
      icon: level ? <ToggleHeadingIcon level={level} size={16} /> : <ChevronRight size={16} />,
      active: (e) => toggleLevel(e) === level,
      run: (e) => (toggleLevel(e) === undefined ? e.chain().focus().clearNodes() : e.chain().focus()).command(turnIntoToggle(level)).run(),
    }),
  ),
  { id: "code", label: "Code", icon: <SquareCode size={16} />, active: (e) => e.isActive("codeBlock"), run: (e) => turn(e).clearNodes().toggleCodeBlock().run() },
  { id: "quote", label: "Quote", icon: <Quote size={16} />, active: (e) => e.isActive("blockquote"), run: (e) => turn(e).clearNodes().toggleBlockquote().run() },
  { id: "callout", label: "Callout", icon: <Lightbulb size={16} />, active: (e) => e.isActive("callout"), run: (e) => turn(e).clearNodes().wrapIn("callout").run() },
];

/** Block shortcuts: ⌘⌥0–8 turn into, ⌘D duplicates the current block, ⌘⇧H highlights. */
const BlockKeys = Extension.create({
  name: "blockKeys",
  addKeyboardShortcuts() {
    const by = (id: string) => () => (TURN_INTO.find((t) => t.id === id)!.run(this.editor), true);
    return {
      "Mod-Alt-0": by("text"),
      "Mod-Alt-1": by("h1"),
      "Mod-Alt-2": by("h2"),
      "Mod-Alt-3": by("h3"),
      "Mod-Alt-4": by("todo"),
      "Mod-Alt-5": by("bullet"),
      "Mod-Alt-6": by("number"),
      "Mod-Alt-7": by("toggle"),
      "Mod-Alt-8": by("code"),
      "Mod-d": () => {
        const { $from } = this.editor.state.selection;
        if ($from.depth < 1) return false;
        return this.editor.chain().insertContentAt($from.after(1), $from.node(1).toJSON()).run();
      },
      "Mod-Shift-h": () => this.editor.chain().focus().setColor({ bg: "yellow" }).run(),
    };
  },
});

/** Everything that defines the document and its Markdown form (shared with the round-trip tests). */
export function contentExtensions() {
  return [
    StarterKit.configure({
      underline: false, // no Markdown syntax for it
      codeBlock: false,
      link: { openOnClick: false, autolink: true },
      dropcursor: { color: "var(--blue)", width: 3 },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Notion's simple tables: headers, cell colours, fit to page width and column widths dragged by
    // their right border, all kept in the Markdown (table.ts).
    TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
    ColorTableCell,
    ColorTableHeader,
    SimpleTable.configure({ resizable: true, cellMinWidth: 80, lastColumnResizable: true }),
    ImageBlock,
    FileAttachment,
    CodeBlock,
    BlockEquation,
    InlineEquation,
    ColorMark,
    Callout,
    Toggle,
    ToggleSummary,
    DetailsContent,
    ColumnList,
    Column,
    DatabaseEmbed,
    DatabaseViews,
    MathAwareMarkdown.configure({ indentation: { style: "space", size: 2 } }),
    WikiLink,
  ];
}

export function Editor({ initial, onChange, onOpenLink, getNotes, createPage, page, editorRef }: Props) {
  const editor = useEditor({
    extensions: [
      ...contentExtensions(),
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node, pos, editor: e }) => {
          if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
          if (node.type.name === "detailsSummary") {
            const level = e.state.doc.resolve(pos).parent.attrs.level;
            return level ? `Toggle heading ${level}` : "Toggle";
          }
          return e.isEmpty ? "Write something, or press '/' for commands…" : "Press '/' for commands";
        },
      }),
      // Marks the block holding the cursor; only that one shows its placeholder (index.css).
      Focus.configure({ className: "has-focus", mode: "deepest" }),
      BlockKeys,
      SlashCommand.configure({ page }),
      PageLinkSuggestion.configure({ getNotes, createPage }),
      MentionSuggestion.configure({ getNotes, createPage }),
    ],
    content: initial,
    contentType: "markdown",
    onUpdate: ({ editor }) => onChange(normalizeMarkdown(editor.getMarkdown())),
    editorProps: {
      attributes: { class: "mynote-prose", spellcheck: "true" },
      handleClickOn: (_view, _pos, node, _nodePos, event) => {
        if (node.type.name !== "wikiLink") return false;
        event.preventDefault();
        onOpenLink(node.attrs.target, wantsNewTab(event));
        return true;
      },
    },
  });

  // Files attached in this editor go in its page's folder.
  const pagePath = useContext(PageContext);
  useEffect(() => {
    if (editor) editor.storage.fileAttachment.page = pagePath;
  }, [editor, pagePath]);

  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor;
    return () => {
      if (editorRef.current === editor) editorRef.current = null;
    };
  }, [editor, editorRef]);

  if (!editor) return null;

  return (
    <>
      <BlockHandle editor={editor} onOpenLink={onOpenLink} />
      <FormatMenu editor={editor} />
      <EditorContent editor={editor} />
      <SubpagePrompt editor={editor} page={page} />
      <DatabasePicker editor={editor} getNotes={getNotes} />
    </>
  );
}

// ---------- "/linked database" ----------

/** Picks an existing database to embed where "/linked database" was typed. */
function DatabasePicker({ editor, getNotes }: { editor: TiptapEditor; getNotes: PageLinkOptions["getNotes"] }) {
  const [at, setAt] = useState<{ pos: number; rect: DOMRect } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const dom = editor.view.dom;
    const open = () => {
      const pos = editor.state.selection.from;
      const c = editor.view.coordsAtPos(pos);
      setQuery("");
      setActive(0);
      setAt({ pos, rect: new DOMRect(c.left, c.top, 0, c.bottom - c.top) });
    };
    dom.addEventListener(LINK_DATABASE, open);
    return () => dom.removeEventListener(LINK_DATABASE, open);
  }, [editor]);

  if (!at) return null;
  const q = query.trim().toLowerCase();
  const databases = getNotes()
    .filter((n) => n.kind === "database" && (!q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)))
    .slice(0, 50);
  const close = () => (setAt(null), editor.commands.focus());
  const pick = (path: string) => {
    setAt(null);
    editor
      .chain()
      .focus()
      .insertContentAt(Math.min(at.pos, editor.state.doc.content.size), [{ type: "databaseEmbed", attrs: { target: path.replace(/\.md$/, "") } }, { type: "paragraph" }])
      .run();
  };
  return (
    <Popover anchor={at.rect} onClose={close} className="flex max-h-96 w-80 flex-col p-1">
      <input
        autoFocus
        value={query}
        onChange={(e) => (setQuery(e.target.value), setActive(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((i) => Math.min(i + 1, databases.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)));
          if (e.key === "Enter" && databases[active]) (e.preventDefault(), pick(databases[active].path));
        }}
        placeholder="Search for a database…"
        className="mb-1 h-8 w-full shrink-0 rounded-md border border-line bg-side px-2 text-sm text-ink outline-none focus:border-[var(--blue)]"
      />
      <div className="min-h-0 overflow-y-auto">
        {databases.length ? (
          databases.map((n, i) => (
            <MenuItem
              key={n.path}
              active={i === active}
              icon={n.icon ? <PageIcon icon={n.icon} size={15} /> : <Table2 size={15} />}
              label={n.title}
              hint={n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")).split("/").pop() : undefined}
              onClick={() => pick(n.path)}
            />
          ))
        ) : (
          <p className="px-2 py-1.5 text-sm text-faint">No databases found</p>
        )}
      </div>
    </Popover>
  );
}

// ---------- "/page" ----------

/** Names the sub-page "/page" is about to create, then links it where the command was typed. */
function SubpagePrompt({ editor, page }: { editor: TiptapEditor; page: PageActions }) {
  const [at, setAt] = useState<{ pos: number; rect: DOMRect } | null>(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    const dom = editor.view.dom;
    const open = () => {
      const pos = editor.state.selection.from;
      const c = editor.view.coordsAtPos(pos);
      setTitle("");
      setAt({ pos, rect: new DOMRect(c.left, c.top, 0, c.bottom - c.top) });
    };
    dom.addEventListener(NEW_SUBPAGE, open);
    return () => dom.removeEventListener(NEW_SUBPAGE, open);
  }, [editor]);

  if (!at) return null;
  const name = title.trim();
  // Pages are files, so a sub-page can't share its name with a sibling: that name links the one there.
  const existing = name ? page.findSubpage(name) : undefined;
  const close = () => (setAt(null), editor.commands.focus());
  const create = async () => {
    setAt(null);
    const path = existing ?? (await page.createSubpage(name || "Untitled"));
    // By path, not title: another page elsewhere may share the title.
    const target = path.replace(/\.md$/, "");
    editor
      .chain()
      .focus()
      .insertContentAt(Math.min(at.pos, editor.state.doc.content.size), [{ type: "wikiLink", attrs: { target } }, { type: "text", text: " " }])
      .run();
  };
  return (
    <Popover anchor={at.rect} onClose={close} className="w-72 p-1.5">
      <form onSubmit={(e) => (e.preventDefault(), create())}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Page name"
          className="h-8 w-full rounded-md border border-line bg-raised px-2 text-sm text-ink outline-none focus:border-[var(--blue)]"
        />
      </form>
      <p className="px-1 pt-1.5 text-[11px] text-faint">
        {existing ? <>“{name}” is already a page here · ↵ to link it</> : <>↵ to create the page · Esc to cancel</>}
      </p>
    </Popover>
  );
}

// ---------- block handle ----------

export type MenuAt = { el: HTMLElement | DOMRect; node: PMNode; pos: number; link?: string };

function BlockHandle({ editor, onOpenLink }: { editor: TiptapEditor; onOpenLink: Props["onOpenLink"] }) {
  const target = useRef<{ node: PMNode; pos: number } | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [tableMenu, setTableMenu] = useState<DOMRect | null>(null);

  // Right-clicking a block opens its menu (the one behind the grip) at the cursor. Selected text
  // keeps the system menu, for Copy / Look Up / spelling.
  useEffect(() => {
    const dom = editor.view.dom;
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea")) return;
      // In a table: rows, columns and the table itself. The clicked cell gets the cursor, unless it's
      // part of cells already selected (so a multi-cell selection can be merged or cleared).
      const cell = t.closest("td, th");
      if (cell && editor.view.dom.contains(cell)) {
        e.preventDefault();
        const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
        const sel = editor.state.selection;
        const inSelection = sel instanceof CellSelection && at && at.pos >= sel.from && at.pos <= sel.to;
        if (at && !inSelection) editor.chain().focus().setTextSelection(at.pos).run();
        setTableMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
        return;
      }
      if (!target.current) return;
      const sel = editor.state.selection;
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!sel.empty && !(sel instanceof NodeSelection) && at && at.pos >= sel.from && at.pos <= sel.to) return;
      e.preventDefault();
      const link = t.closest<HTMLElement>("[data-wikilink]")?.dataset.target;
      setMenu({ el: new DOMRect(e.clientX, e.clientY, 0, 0), ...target.current, link });
    };
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [editor]);
  // The pointer's height, for the toggle rule in NESTED (rules don't get coordinates).
  useEffect(() => {
    const track = (e: MouseEvent) => void (pointerY = e.clientY);
    window.addEventListener("mousemove", track, { capture: true, passive: true });
    return () => window.removeEventListener("mousemove", track, { capture: true });
  }, []);
  // Nudges the handle beside the block's first line (and left of list markers). Applied straight to
  // the element in the same tick the handle moves; a React state update would land a frame later
  // and make the handle visibly jump twice when moving between blocks.
  const inner = useRef<HTMLDivElement>(null);

  const addBelow = () => {
    const t = target.current;
    if (!t) return;
    const empty = t.node.type.name === "paragraph" && t.node.content.size === 0;
    if (empty) {
      editor.chain().focus().setTextSelection(t.pos + 1).insertContent("/").run();
    } else {
      const at = t.pos + t.node.nodeSize;
      editor.chain().insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(at + 2).focus().run();
    }
  };

  return (
    <>
      <DragHandle
        editor={editor}
        nested={NESTED}
        onNodeChange={({ node, pos }) => {
          target.current = node ? { node, pos } : null;
          const dom = node ? (editor.view.nodeDOM(pos) as HTMLElement | null) : null;
          const { x, y } = dom instanceof HTMLElement ? handleOffset(dom, node!.type.name) : { x: 0, y: 0 };
          if (inner.current) inner.current.style.transform = `translate(${-x}px, ${y}px)`;
        }}
      >
        <div ref={inner} className="flex items-center pr-1">
          <button onClick={addBelow} title="Click to add below" className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-hover hover:text-muted">
            <Plus size={17} />
          </button>
          <div
            role="button"
            title="Drag to move · Click to open menu"
            onClick={(e) => target.current && setMenu({ el: e.currentTarget, ...target.current })}
            className="block-grip grid h-6 w-[18px] cursor-grab place-items-center rounded text-faint hover:bg-hover hover:text-muted"
          >
            <GripVertical size={16} />
          </div>
        </div>
      </DragHandle>
      {menu && <BlockMenu editor={editor} {...menu} onOpenLink={onOpenLink} onClose={() => setMenu(null)} />}
      {tableMenu && <TableMenu editor={editor} at={tableMenu} onClose={() => setTableMenu(null)} />}
      <TableControls editor={editor} />
    </>
  );
}

const HANDLE_HEIGHT = 24;

/** Where the pointer last was, vertically (see BlockHandle). */
let pointerY = Number.NaN;

const NESTED: NestedOptions = {
  // No edge detection: by default, nearing a block's left edge hands the handle to its parent, so
  // reaching for the handle of a block inside columns jumped it to the whole column row.
  edgeDetection: "none",
  // A column on its own isn't a block you'd move; its contents are.
  rules: [
    { id: "noBareColumns", evaluate: ({ node }) => (node.type.name === "column" ? 1000 : 0) },
    // A toggle's title and content are parts of it, not blocks: the toggle is what the handle moves
    // and its menu changes.
    { id: "noToggleParts", evaluate: ({ node }) => (node.type.name === "detailsSummary" || node.type.name === "detailsContent" ? 1000 : 0) },
    // Over a toggle's arrow column the pointer resolves to just before the toggle, which belongs to the
    // toggle around it: keep the handle where it is rather than jumping to that outer toggle on the
    // way to the handle of a nested one.
    { id: "toggleArrowColumn", evaluate: ({ $pos }) => ($pos.nodeAfter?.type.name === "details" ? 1000 : 0) },
    // A toggle takes the handle only beside its title. Beside its contents (the column under its
    // arrow, a code block's edges) the pointer resolves to the toggle itself, which pulled the handle
    // up to the title on the way to the handle of a block inside it; there it stays on that block.
    {
      id: "toggleByItsTitle",
      evaluate: ({ node, pos, view }) => {
        if (node.type.name !== "details" || Number.isNaN(pointerY)) return 0;
        const summary = (view.nodeDOM(pos) as HTMLElement | null)?.querySelector(":scope > div > summary");
        return summary && pointerY > summary.getBoundingClientRect().bottom ? 1000 : 0;
      },
    },
    // A table moves as a whole; its rows, cells and the text in them get no handles of their own.
    // ($pos is where the pointer is, the same for every candidate: only what's above this one counts,
    // or the table would rule itself out too.)
    {
      id: "noTableInsides",
      evaluate: ({ $pos, depth }) => {
        for (let d = depth - 1; d > 0; d--) if ($pos.node(d).type.name === "table") return 1000;
        return 0;
      },
    },
  ],
};

/** Blocks with a left bar, icon or arrow: handles for blocks inside them sit outside the decoration. */
const DECORATED = 'blockquote, .callout, [data-type="details"]';

/**
 * Where to nudge the block handle so it sits beside the block's first line of text:
 * down to that line's centre, and (for bullets/numbers) left of the list marker.
 */
function handleOffset(dom: HTMLElement, type: string): { x: number; y: number } {
  // Outermost quote/callout/toggle around this block, else (for list items) the list itself,
  // whose left padding holds the bullet or number.
  let anchor: HTMLElement | null = null;
  for (let el = dom.parentElement; el && !el.classList.contains("ProseMirror"); el = el.parentElement) {
    if (el.matches(DECORATED)) anchor = el;
  }
  if (!anchor && type === "listItem") anchor = dom.parentElement;
  const x = anchor ? Math.max(0, dom.getBoundingClientRect().left - anchor.getBoundingClientRect().left) : 0;
  // The first line of text: the block itself, or e.g. the <p> inside a list item, to-do or callout.
  const line = dom.matches("p, h1, h2, h3, h4, h5, h6, pre, summary") ? dom : (dom.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6, pre, summary") ?? dom);
  const style = getComputedStyle(line);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || HANDLE_HEIGHT;
  const top = line.getBoundingClientRect().top - dom.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0);
  return { x, y: Math.max(0, Math.round(top + lineHeight / 2 - HANDLE_HEIGHT / 2)) };
}

const NODE_LABELS: Record<string, string> = {
  paragraph: "Text",
  bulletList: "Bulleted list",
  orderedList: "Numbered list",
  taskList: "To-do list",
  listItem: "List item",
  taskItem: "To-do",
  details: "Toggle list",
  codeBlock: "Code",
  blockquote: "Quote",
  callout: "Callout",
  columnList: "Columns",
  databaseEmbed: "Database",
  databaseViews: "Database views",
  table: "Table",
  image: "Image",
  blockEquation: "Equation",
  horizontalRule: "Divider",
};

export function BlockMenu({ editor, el, node, pos, link, onOpenLink, onClose }: MenuAt & { editor: TiptapEditor; onOpenLink: Props["onOpenLink"]; onClose: () => void }) {
  const [sub, setSub] = useState<{ kind: "turn" | "color"; el: HTMLElement } | null>(null);
  const [query, setQuery] = useState("");
  // The block's text, from its first line to its last: the title of a toggle, the items of a list.
  // (Positions just inside a toggle or list aren't in any text, and conversions then act on the wrong block.)
  const selectBlock = () => {
    const { doc } = editor.state;
    const from = Selection.near(doc.resolve(pos + 1)).from;
    const to = Math.max(from, Selection.near(doc.resolve(pos + node.nodeSize - 1), -1).to);
    editor.chain().focus().setTextSelection({ from, to }).run();
  };
  const finish = (fn: () => void) => {
    fn();
    onClose();
  };
  const q = query.toLowerCase();
  // A database page's own views: they only move (see DatabaseViews).
  const fixed = node.type.name === "databaseViews";
  const show = (label: string) => label.toLowerCase().includes(q);
  const label =
    node.type.name === "heading" ? `Heading ${node.attrs.level}` : node.type.name === "details" && node.attrs.level ? `Toggle heading ${node.attrs.level}` : (NODE_LABELS[node.type.name] ?? node.type.name);

  return (
    <Popover anchor={el} onClose={onClose} className="w-64 p-1">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search actions…"
        className="mb-1 h-7 w-full rounded-md border border-line bg-side px-2 text-sm text-ink outline-none focus:border-[var(--blue)]"
      />
      {link && (
        <>
          <MenuSection label="Page link" />
          {show("Open page") && <MenuItem icon={<ArrowUpRight size={15} />} label="Open page" onClick={() => finish(() => onOpenLink(link, false))} />}
          {show("Open in new tab") && <MenuItem icon={<ExternalLink size={15} />} label="Open in new tab" hint="⌘ click" onClick={() => finish(() => onOpenLink(link, true))} />}
          <MenuDivider />
        </>
      )}
      <MenuSection label={label} />
      {!fixed && node.type.name !== "table" && show("Turn into") && (
        <MenuItem icon={<RefreshCw size={15} />} label="Turn into" right={<ChevronRight size={14} className="text-faint" />} onClick={(e) => setSub({ kind: "turn", el: e.currentTarget })} />
      )}
      {!fixed && show("Color") && (
        <MenuItem icon={<Palette size={15} />} label="Color" right={<ChevronRight size={14} className="text-faint" />} onClick={(e) => setSub({ kind: "color", el: e.currentTarget })} />
      )}
      {node.type.name === "table" && !q && <TableOptions editor={editor} table={{ node, pos }} onDone={onClose} />}
      {fixed && <p className="px-2 py-1.5 text-xs leading-relaxed text-faint">Drag ⋮⋮ to move the views above or below the page's text.</p>}
      <MenuDivider />
      {!fixed && show("Duplicate") && (
        <MenuItem icon={<Copy size={15} />} label="Duplicate" hint="⌘D" onClick={() => finish(() => editor.chain().insertContentAt(pos + node.nodeSize, node.toJSON()).run())} />
      )}
      {!fixed && show("Delete") && (
        <MenuItem
          icon={<Trash2 size={15} />}
          label="Delete"
          hint="Del"
          danger
          onClick={() => finish(() => editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run())}
        />
      )}

      {sub?.kind === "turn" && (
        <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)} className="w-56 p-1">
          {TURN_INTO.map((t) => (
            <MenuItem
              key={t.id}
              icon={t.icon}
              label={t.label}
              onClick={() =>
                finish(() => {
                  selectBlock();
                  t.run(editor);
                })
              }
            />
          ))}
        </Popover>
      )}
      {sub?.kind === "color" && (
        <ColorList
          anchor={sub.el}
          placement="right-start"
          onClose={() => setSub(null)}
          onPick={(attrs) =>
            finish(() => {
              if (node.type.name === "callout") {
                const color = attrs.bg ?? attrs.color ?? "gray";
                editor.chain().command(({ tr }) => (tr.setNodeMarkup(pos, undefined, { ...node.attrs, color }), true)).run();
              } else if (node.type.name === "table") {
                colorTable(editor, { node, pos }, cellColor(attrs));
              } else {
                selectBlock();
                editor.chain().focus().setColor(attrs).setTextSelection(pos + node.nodeSize - 1).run();
              }
            })
          }
        />
      )}
    </Popover>
  );
}

// ---------- selection bubble menu ----------

function FormatMenu({ editor }: { editor: TiptapEditor }) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const [open, setOpen] = useState<{ kind: "turn" | "color" | "bg"; el: HTMLElement } | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      color: e.getAttributes("color") as { color?: string; bg?: string },
      block: TURN_INTO.find((t) => t.active(e))?.label ?? "Text",
    }),
  });

  const applyLink = () => {
    const chain = editor.chain().focus().extendMarkRange("link");
    (href.trim() ? chain.setLink({ href: href.trim() }) : chain.unsetLink()).run();
    setLinking(false);
  };

  const marks = [
    { key: "bold", icon: <Bold size={15} strokeWidth={2.5} />, run: () => editor.chain().focus().toggleBold().run(), label: "Bold ⌘B" },
    { key: "italic", icon: <Italic size={15} />, run: () => editor.chain().focus().toggleItalic().run(), label: "Italic ⌘I" },
    { key: "strike", icon: <Strikethrough size={15} />, run: () => editor.chain().focus().toggleStrike().run(), label: "Strikethrough ⌘⇧S" },
    { key: "code", icon: <Code size={15} />, run: () => editor.chain().focus().toggleCode().run(), label: "Inline code ⌘E" },
  ] as const;

  const sep = <span className="mx-0.5 h-5 w-px bg-line" />;

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top-start", offset: 8 }}
      // Text formatting only: not while a block is being dragged, nor for the block selection the
      // drag handle makes (showing it there covers the drop target and cancels the drag).
      shouldShow={({ editor: e, view, state, from, to }) =>
        from !== to &&
        !view.dragging &&
        !(state.selection instanceof NodeSelection) &&
        !(state.selection instanceof NodeRangeSelection) &&
        // A whole row or column (from its handle) has its own menu.
        !(state.selection instanceof CellSelection && (state.selection.isRowSelection() || state.selection.isColSelection())) &&
        !e.isActive("codeBlock") &&
        !e.isActive("wikiLink") &&
        !e.isActive("databaseEmbed") &&
        !e.isActive("image")
      }
    >
      <div className="flex h-9 items-center gap-0.5 rounded-lg border border-line bg-raised p-1 text-sm text-ink shadow-pop">
        {linking ? (
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyLink();
              if (e.key === "Escape") setLinking(false);
            }}
            onBlur={() => setLinking(false)}
            placeholder="Paste link, or leave empty to remove"
            className="w-72 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-faint"
          />
        ) : (
          <>
            <button onClick={(e) => setOpen({ kind: "turn", el: e.currentTarget })} className="flex h-7 items-center gap-1 rounded-md px-2 whitespace-nowrap hover:bg-hover">
              {state.block} <ChevronDown size={13} className="text-faint" />
            </button>
            {sep}
            <button
              title="Link"
              onClick={() => {
                setHref(editor.getAttributes("link").href ?? "");
                setLinking(true);
              }}
              className={`flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover ${state.link ? "text-[var(--blue)]" : ""}`}
            >
              <Link2 size={15} /> Link
            </button>
            {sep}
            {marks.map((b) => (
              <button key={b.key} title={b.label} onClick={b.run} className={`grid size-7 place-items-center rounded-md hover:bg-hover ${state[b.key] ? "text-[var(--blue)]" : ""}`}>
                {b.icon}
              </button>
            ))}
            {sep}
            <button title="Text color" onClick={(e) => setOpen({ kind: "color", el: e.currentTarget })} className="flex h-7 items-center gap-0.5 rounded-md px-1.5 hover:bg-hover">
              <span className="grid size-5 place-items-center text-[15px] font-semibold" style={{ color: textColor(state.color.color) ?? "var(--ink)" }}>
                A
              </span>
              <ChevronDown size={12} className="text-faint" />
            </button>
            <button title="Background color" onClick={(e) => setOpen({ kind: "bg", el: e.currentTarget })} className="flex h-7 items-center gap-0.5 rounded-md px-1.5 hover:bg-hover">
              <span className="relative grid size-5 place-items-center">
                <Highlighter size={15} />
                <span
                  className="absolute -bottom-0.5 left-0.5 h-[3px] w-4 rounded-full border border-line"
                  style={{ background: bgColor(state.color.bg) ?? "transparent" }}
                />
              </span>
              <ChevronDown size={12} className="text-faint" />
            </button>
          </>
        )}
      </div>
      {open?.kind === "turn" && (
        <Popover anchor={open.el} onClose={() => setOpen(null)} className="w-56 p-1">
          <MenuSection label="Turn into" />
          {TURN_INTO.map((t) => (
            <MenuItem
              key={t.id}
              icon={t.icon}
              label={t.label}
              right={state.block === t.label ? <span className="text-muted">✓</span> : null}
              onClick={() => {
                t.run(editor);
                setOpen(null);
              }}
            />
          ))}
        </Popover>
      )}
      {(open?.kind === "color" || open?.kind === "bg") && (
        <ColorList
          anchor={open.el}
          only={open.kind === "color" ? "text" : "bg"}
          current={state.color}
          onClose={() => setOpen(null)}
          onPick={(attrs) => {
            editor.chain().focus().setColor(attrs).run();
            setOpen(null);
          }}
        />
      )}
    </BubbleMenu>
  );
}
