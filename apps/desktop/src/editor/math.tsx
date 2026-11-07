/**
 * Equations, as in Notion: a block equation (`$$` lines around LaTeX) and an inline one (`$…$` in a
 * sentence), rendered with KaTeX. The Markdown is what Obsidian, GitHub and Notion's exports use.
 * Click an equation to edit its LaTeX; the page shows the result as you type.
 *
 * Inline `$…$` follows the usual rules, so prices stay text: no space just inside the dollars, no
 * digit right after the closing one ("$5 and $10" isn't math), and `\$` is a dollar sign.
 */
import { InputRule, Node, type Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import katex from "katex";
import { AArrowDown, AArrowUp, Sigma, TextAlignCenter, TextAlignStart } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../components/Popover";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    equations: {
      /** Adds an empty block equation at the cursor and opens it for editing. */
      insertBlockEquation: () => ReturnType;
      /** Turns the selected text into an inline equation, or adds an empty one and opens it. */
      insertInlineEquation: () => ReturnType;
    };
  }
  interface Storage {
    /** Set when an equation is added empty: the next one to appear opens for editing. */
    blockEquation: { editNext: boolean };
    inlineEquation: { editNext: boolean };
  }
}

/** `$$`, the LaTeX (lines, but no blank one), `$$`, each on its own line; or `$$x$$` on one line. */
const BLOCK = /^\$\$[ \t]*\n?((?:(?!\n[ \t]*\n)[\s\S])*?)\n?[ \t]*\$\$[ \t]*(?:\n|$)/;
/** `$x$`: not touching spaces inside, no digit after (a price), `\$` escaped. */
const INLINE = /^\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?!\d)/;
/** The same, anywhere in a run of text (not after a backslash or another `$`). */
const INLINE_IN_TEXT = /(?<![\\$])\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?!\d)/g;
/** A block equation's first line when it's aligned left: a LaTeX comment, so other apps just centre it. */
const ALIGN_LEFT = /^%[ \t]*align:[ \t]*left[ \t]*(?:\n|$)/;

/**
 * The Markdown extension, writing text that reads like an equation (typed `\$x\$`, or pasted) with
 * its dollars escaped, so it doesn't come back as one. Other dollars ("$5 and $10") stay as they are.
 */
export const MathAwareMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.editor.markdown as unknown as { escapeMarkdownSyntax?: (text: string) => string } | undefined;
    const base = manager?.escapeMarkdownSyntax?.bind(manager);
    if (!manager || !base) return;
    manager.escapeMarkdownSyntax = (text) => base(text).replace(INLINE_IN_TEXT, (_, latex: string) => `\\$${latex}\\$`);
  },
});

export const BlockEquation = Node.create({
  name: "blockEquation",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? "" },
      // "left" or "center": KaTeX's flush-left display, or its usual centring.
      align: { default: "center", parseHTML: (el) => (el.getAttribute("data-align") === "left" ? "left" : "center") },
    };
  },
  addStorage() {
    return { editNext: false };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="block-math"]' }];
  },
  renderHTML({ node }) {
    return ["div", { "data-type": "block-math", "data-latex": node.attrs.latex, "data-align": node.attrs.align }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EquationView);
  },
  addCommands() {
    return {
      insertBlockEquation:
        () =>
        ({ editor, commands }) => {
          editor.storage.blockEquation.editNext = true;
          return commands.insertContent({ type: this.name });
        },
    };
  },
  // `$$` and a space on an empty line starts one, as `/Block equation` does.
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== "paragraph" || $from.parent.textContent.trim() !== "$$") return null;
          this.storage.editNext = true;
          state.tr.replaceWith($from.before(), $from.after(), this.type.create());
        },
      }),
    ];
  },
  markdownTokenizer: {
    name: "blockEquation",
    level: "block",
    start: (src: string) => src.search(/^\$\$/m),
    tokenize(src) {
      const m = BLOCK.exec(src);
      if (!m) return undefined;
      const latex = m[1].trim();
      const left = ALIGN_LEFT.exec(latex);
      return { type: "blockEquation", raw: m[0], latex: left ? latex.slice(left[0].length).trim() : latex, align: left ? "left" : "center" };
    },
  },
  parseMarkdown: (token) => ({ type: "blockEquation", attrs: { latex: token.latex, align: token.align } }),
  // Left alignment rides along as a LaTeX comment, which other apps' renderers skip.
  renderMarkdown: (node) => `$$\n${node.attrs?.align === "left" ? "% align: left\n" : ""}${node.attrs?.latex ?? ""}\n$$`,
});

export const InlineEquation = Node.create({
  name: "inlineEquation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? "" } };
  },
  addStorage() {
    return { editNext: false };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="inline-math"]' }];
  },
  renderHTML({ node }) {
    return ["span", { "data-type": "inline-math", "data-latex": node.attrs.latex }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EquationView);
  },
  addCommands() {
    return {
      insertInlineEquation:
        () =>
        ({ editor, state, commands }) => {
          const { from, to, empty } = state.selection;
          const text = empty ? "" : state.doc.textBetween(from, to, " ").trim();
          if (!text) editor.storage.inlineEquation.editNext = true;
          return commands.insertContentAt({ from, to }, { type: this.name, attrs: { latex: text } });
        },
    };
  },
  // ⌘⇧E, as in Notion.
  addKeyboardShortcuts() {
    return { "Mod-Shift-e": () => this.editor.commands.insertInlineEquation() };
  },
  // Typing `$x^2$` turns into an equation when the closing `$` goes in.
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![\\$\w])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },
  markdownTokenizer: {
    name: "inlineEquation",
    level: "inline",
    // A `$` that isn't escaped, isn't part of `$$`, and starts something.
    start: (src: string) => src.search(/(?<![\\$])\$(?=[^\s$])/),
    tokenize(src) {
      const m = INLINE.exec(src);
      return m ? { type: "inlineEquation", raw: m[0], latex: m[1] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "inlineEquation", attrs: { latex: token.latex } }),
  renderMarkdown: (node) => (node.attrs?.latex ? `$${node.attrs.latex}$` : ""),
});

/** LaTeX as KaTeX draws it; mistakes show in red instead of failing. */
function Tex({ latex, display, left = false }: { latex: string; display: boolean; left?: boolean }) {
  const html = useMemo(() => katex.renderToString(latex, { displayMode: display, fleqn: left, throwOnError: false, strict: "ignore" }), [latex, display, left]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A block or inline equation; click to edit its LaTeX. */
function EquationView({ node, editor, selected, updateAttributes, deleteNode, getPos }: NodeViewProps) {
  const block = node.type.name === "blockEquation";
  const latex = node.attrs.latex as string;
  const left = block && node.attrs.align === "left";
  const box = useRef<HTMLElement>(null);
  // While editing: what's typed, shown live in the page.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    const storage = editor.storage[block ? "blockEquation" : "inlineEquation"];
    if (!latex && storage.editNext) {
      storage.editNext = false;
      setDraft("");
    }
    // Only when it first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = draft ?? latex;
  const finish = () => {
    if (draft === null) return;
    const value = draft.trim();
    setDraft(null);
    // An inline equation left empty goes; an empty block one stays, waiting for its LaTeX.
    if (!block && !value) return deleteNode();
    if (value !== latex) updateAttributes({ latex: value });
    const pos = getPos();
    if (typeof pos === "number") editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
  };
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    if (editor.isEditable) setDraft(latex);
  };
  const ring = selected || draft !== null ? "ring-2 ring-[var(--blue)]/50" : "";
  return (
    <NodeViewWrapper
      as={block ? "div" : "span"}
      ref={box}
      contentEditable={false}
      data-equation={block ? "block" : "inline"}
      onClick={open}
      className={
        block
          ? `my-1 cursor-pointer rounded-md px-3 py-1 ${left ? "text-left" : "text-center"} hover:bg-hover ${ring}`
          : `mx-px cursor-pointer rounded px-0.5 hover:bg-hover ${ring}`
      }
    >
      {shown.trim() ? (
        <Tex latex={shown} display={block} left={left} />
      ) : block ? (
        <span className="flex items-center gap-2 py-2 text-left text-sm text-faint">
          <Sigma size={16} /> Add a TeX equation
        </span>
      ) : (
        <span className="text-faint">New equation</span>
      )}
      {draft !== null && box.current && (
        <EquationEditor
          anchor={box.current}
          block={block}
          value={draft}
          onChange={setDraft}
          onDone={finish}
          align={block ? (node.attrs.align as "left" | "center") : undefined}
          onAlign={(align) => updateAttributes({ align })}
        />
      )}
    </NodeViewWrapper>
  );
}

/** The font sizes (px) the LaTeX box steps through, and where the chosen one is kept on this computer. */
const FONT_SIZES = [11, 12, 13, 15, 17, 20, 24];
const FONT_KEY = "equation-editor-font-size";
const readFontSize = () => {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return FONT_SIZES.includes(n) ? n : 13;
  } catch {
    return 13;
  }
};

/**
 * The LaTeX of the equation being edited: Enter (⌘Enter in a block equation) or a click outside is
 * done. Its text can be made bigger or smaller; a block equation also picks its alignment here.
 */
function EquationEditor({
  anchor,
  block,
  value,
  onChange,
  onDone,
  align,
  onAlign,
}: {
  anchor: HTMLElement;
  block: boolean;
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
  align?: "left" | "center";
  onAlign: (align: "left" | "center") => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [font, setFont] = useState(readFontSize);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const resize = (by: 1 | -1) => {
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, FONT_SIZES.indexOf(font) + by))];
    setFont(next);
    try {
      localStorage.setItem(FONT_KEY, String(next));
    } catch {
      /* convenience only */
    }
    input.current?.focus();
  };
  const tool = (on: boolean) => `grid size-7 place-items-center rounded disabled:opacity-30 ${on ? "bg-hover text-ink" : "text-faint hover:text-ink"}`;
  return (
    <Popover anchor={anchor} onClose={onDone} className="w-[min(520px,92vw)] p-2">
      <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} className="flex items-end gap-2">
        <textarea
          ref={input}
          value={value}
          // A block equation's box grows with its lines (3 to 12), so bigger text doesn't hide any.
          rows={block ? Math.min(12, Math.max(3, value.split("\n").length)) : 1}
          spellCheck={false}
          placeholder={block ? "E = mc^2" : "x^2"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (!block || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onDone();
            }
          }}
          style={{ fontSize: font }}
          className="min-h-8 min-w-0 flex-1 resize-y rounded-md border border-line bg-[var(--search-bg)] px-2 py-1.5 font-mono text-ink outline-none focus:border-[var(--blue)]"
        />
        {/* The LaTeX's size here (not the equation's in the page), remembered for the next one. */}
        <div className="flex h-8 shrink-0 items-center rounded-md border border-line p-0.5">
          <button title="Smaller text" disabled={font === FONT_SIZES[0]} onClick={() => resize(-1)} className={tool(false)}>
            <AArrowDown size={15} />
          </button>
          <button title="Bigger text" disabled={font === FONT_SIZES[FONT_SIZES.length - 1]} onClick={() => resize(1)} className={tool(false)}>
            <AArrowUp size={15} />
          </button>
        </div>
        {align && (
          <div className="flex h-8 shrink-0 items-center rounded-md border border-line p-0.5">
            {(
              [
                ["left", TextAlignStart, "Align left"],
                ["center", TextAlignCenter, "Centre"],
              ] as const
            ).map(([value, Icon, title]) => (
              <button
                key={value}
                title={title}
                // Typing (and ⌘Enter) carries on in the LaTeX after picking an alignment.
                onClick={() => (onAlign(value), input.current?.focus())}
                className={tool(align === value)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
        )}
        <button onClick={onDone} className="h-8 shrink-0 rounded-md bg-[var(--blue)] px-3 text-sm font-medium text-white">
          Done <span className="opacity-70">{block ? "⌘↵" : "↵"}</span>
        </button>
      </div>
    </Popover>
  );
}

/** Puts a new, empty equation at the cursor for `/Block equation` and `/Inline equation`. */
export const insertEquation = (editor: Editor, block: boolean) =>
  block ? editor.chain().focus().insertBlockEquation().run() : editor.chain().focus().insertInlineEquation().run();
