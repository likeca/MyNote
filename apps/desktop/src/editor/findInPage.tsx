import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEditorState, type Editor as TiptapEditor } from "@tiptap/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Find in page (⌘F): every match of the search in the page's text is highlighted, the current one
 * more strongly; Enter and ⇧Enter step through them. Case-insensitive. Matches can't run across
 * blocks, or across a page link, mention or equation inside a line.
 */

export type Match = { from: number; to: number };
type FindState = { query: string; active: number; matches: Match[]; decorations: DecorationSet };

export const findKey = new PluginKey<FindState>("findInPage");

/** Where `query` appears in `doc`'s text, in order. */
export function findMatches(doc: PMNode, query: string): Match[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text, and the document position of each of its characters (an inline node
    // such as a page link stands in as one character no search matches).
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        const t = child.text ?? "";
        for (let i = 0; i < t.length; i++) at.push(pos + 1 + offset + i);
        text += t;
      } else {
        at.push(pos + 1 + offset);
        text += "\uFFFC";
      }
    });
    // Lower-casing can change a string's length (İ); then it's matched as written.
    const lower = text.toLowerCase();
    const hay = lower.length === text.length ? lower : text;
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push({ from: at[i], to: at[i + q.length - 1] + 1 });
    return false;
  });
  return out;
}

function build(doc: PMNode, query: string, active: number): FindState {
  const matches = findMatches(doc, query);
  const current = matches.length ? Math.min(Math.max(active, 0), matches.length - 1) : 0;
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "find-match find-match-current" : "find-match" })),
  );
  return { query, active: current, matches, decorations };
}

export const FindInPage = Extension.create({
  name: "findInPage",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: "", active: 0, matches: [], decorations: DecorationSet.empty }),
          apply: (tr, old) => {
            const meta = tr.getMeta(findKey) as { query?: string; active?: number } | undefined;
            if (meta) return build(tr.doc, meta.query ?? old.query, meta.active ?? old.active);
            // Edits while searching: the matches follow the text.
            return tr.docChanged && old.query ? build(tr.doc, old.query, old.active) : old;
          },
        },
        props: { decorations: (state) => findKey.getState(state)?.decorations },
      }),
    ];
  },
});

const setFind = (view: EditorView, meta: { query?: string; active?: number }) => view.dispatch(view.state.tr.setMeta(findKey, meta).setMeta("addToHistory", false));

/** The search the bar opens on: the last one, as the page search box does. */
let lastQuery = "";

/** Fired when a page is asked to show where something is in it (see findOnOpen). */
export const FIND_REQUEST = "mynote:find-request";
let pending: { path: string; query: string } | null = null;

/**
 * Opening a page from a search: once it's showing, it finds `query` in it as ⌘F does, so the
 * matches are highlighted and the first is scrolled to.
 */
export function findOnOpen(path: string, query: string) {
  pending = { path, query };
  window.dispatchEvent(new Event(FIND_REQUEST));
}

/** The search waiting for `path`, taken (once), made the bar's search. */
export function takeFindRequest(path: string): string | null {
  if (pending?.path !== path) return null;
  const { query } = pending;
  pending = null;
  lastQuery = query;
  return query;
}

/**
 * The bar over the page. `focusKey` changes on each ⌘F (or search that opened the page), which
 * puts the cursor back in it on the last search, selected.
 */
export function FindBar({ editor, focusKey, onClose }: { editor: TiptapEditor; focusKey: number; onClose: () => void }) {
  const [query, setQuery] = useState(lastQuery);
  const input = useRef<HTMLInputElement>(null);
  const { count, active } = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = findKey.getState(e.state);
      return { count: s?.matches.length ?? 0, active: s?.active ?? 0 };
    },
  });

  useEffect(() => {
    setQuery(lastQuery);
    // After the new search is in the box.
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [focusKey]);

  useEffect(() => {
    lastQuery = query;
    setFind(editor.view, { query, active: 0 });
  }, [query, editor]);

  // Closing (or leaving the page) takes the highlights away.
  useEffect(() => () => void (!editor.isDestroyed && setFind(editor.view, { query: "" })), [editor]);

  // The current match is scrolled into view when it's off screen.
  useLayoutEffect(() => {
    const el = editor.view.dom.querySelector(".find-match-current");
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 96 || r.bottom > window.innerHeight - 48) el.scrollIntoView({ block: "center" });
  }, [editor, active, count, query]);

  const step = (dir: 1 | -1) => count && setFind(editor.view, { active: (active + dir + count) % count });
  const close = () => {
    // The cursor goes to the match that was showing, as in a browser.
    const m = findKey.getState(editor.state)?.matches[active];
    onClose();
    if (m) editor.chain().focus().setTextSelection(m).scrollIntoView().run();
    else editor.commands.focus();
  };

  const button = "grid size-6 place-items-center rounded text-muted enabled:hover:bg-hover disabled:opacity-35";
  return (
    <div className="find-bar absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border border-line bg-raised py-1 pr-1 pl-2.5 shadow-pop">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? -1 : 1));
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
        }}
        placeholder="Find in page"
        className="h-6 w-48 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
      />
      <span className="min-w-12 text-right text-xs text-faint tabular-nums">{query ? (count ? `${active + 1}/${count}` : "No results") : ""}</span>
      <button onClick={() => step(-1)} disabled={!count} title="Previous (⇧↵)" className={button}>
        <ChevronUp size={15} />
      </button>
      <button onClick={() => step(1)} disabled={!count} title="Next (↵)" className={button}>
        <ChevronDown size={15} />
      </button>
      <button onClick={close} title="Close (Esc)" className={button}>
        <X size={14} />
      </button>
    </div>
  );
}
