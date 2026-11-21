import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import type { NoteMeta } from "../lib/api";
import { PAGE_DRAG, type PageDrag } from "../lib/pageDrag";
import { placeFile } from "./blocks";

/**
 * Where a page dragged from the sidebar would land in `editor`, with the pointer at (x, y): the
 * text position nearest it, when the pointer is over this editor's page (its text or the margins
 * beside it; below the text is the end). Nothing over the title, the top bar or another page.
 */
function dropPos(editor: Editor, x: number, y: number): number | null {
  const { view } = editor;
  if (editor.isDestroyed || !view.dom.isConnected) return null;
  const under = document.elementFromPoint(x, y);
  const page = view.dom.closest("[data-page-view]");
  if (!under || !page || under.closest("[data-page-view]") !== page || under.closest("header")) return null;
  const r = view.dom.getBoundingClientRect();
  if (y < r.top) return null;
  if (y > r.bottom) return view.state.doc.content.size;
  return view.posAtCoords({ left: Math.min(Math.max(x, r.left + 1), r.right - 1), top: y })?.pos ?? null;
}

/** Puts a link to `path` at `pos`, with a space either side where it would touch a word. */
function insertLink(editor: Editor, pos: number, path: string, notes: NoteMeta[]) {
  const title = notes.find((n) => n.path === path)?.title ?? path.split("/").pop()!.replace(/\.md$/, "");
  // A title shared with another page links by path, so it opens this one (as "[[" does).
  const target = notes.filter((n) => n.title.toLowerCase() === title.toLowerCase()).length > 1 ? path.replace(/\.md$/, "") : title;
  const { state, view } = editor;
  const tr = state.tr;
  const link = state.schema.nodes.wikiLink.create({ target });
  let end = placeFile(tr, link, Math.min(pos, tr.doc.content.size));
  const $end = tr.doc.resolve(end);
  if ($end.parent.inlineContent && $end.nodeBefore?.type === link.type) {
    const after = $end.nodeAfter;
    if (after?.isText && !/^\s/.test(after.text!)) tr.insertText(" ", end);
    const start = end - link.nodeSize;
    const before = tr.doc.resolve(start).nodeBefore;
    if (before?.isText && !/\s$/.test(before.text!)) (tr.insertText(" ", start), end++);
    tr.setSelection(TextSelection.create(tr.doc, end));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Lets pages dragged from the sidebar drop into this editor as links (see lib/pageDrag). */
export function usePageDrop(editor: Editor | null, getNotes: () => NoteMeta[]) {
  const notes = useRef(getNotes);
  notes.current = getNotes;
  useEffect(() => {
    if (!editor) return;
    let caret: HTMLDivElement | null = null;
    const hide = () => {
      caret?.remove();
      caret = null;
    };
    const onDrag = (e: Event) => {
      const d = (e as CustomEvent<PageDrag>).detail;
      if (d.phase === "end") return hide();
      const pos = dropPos(editor, d.x, d.y);
      if (pos === null) return hide();
      d.handled = true;
      if (d.phase === "drop") {
        hide();
        insertLink(editor, pos, d.path, notes.current());
        return;
      }
      // A caret where the link would go.
      const c = editor.view.coordsAtPos(pos);
      if (!caret) {
        caret = document.createElement("div");
        caret.className = "pointer-events-none fixed z-50 w-0.5 rounded-full bg-[var(--blue)]";
        document.body.append(caret);
      }
      Object.assign(caret.style, { left: `${c.left - 1}px`, top: `${c.top}px`, height: `${Math.max(16, c.bottom - c.top)}px` });
    };
    window.addEventListener(PAGE_DRAG, onDrag);
    return () => {
      window.removeEventListener(PAGE_DRAG, onDrag);
      hide();
    };
  }, [editor]);
}
