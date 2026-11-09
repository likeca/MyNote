import { Extension, type Editor } from "@tiptap/core";
import { NodeRangeSelection, getNodeRangeDecorations } from "@tiptap/extension-node-range";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/** The blocks a block selection holds: each node and where it starts. */
export function selectedBlocks(selection: NodeRangeSelection): { node: PMNode; pos: number }[] {
  return selection.ranges.flatMap((r) => (r.$from.nodeAfter ? [{ node: r.$from.nodeAfter, pos: r.$from.pos }] : []));
}

/**
 * Deletes the selected blocks in one step (one ⌘Z brings them all back), and leaves the cursor
 * where they were. A database page's own views stay: they can't be deleted from their page.
 */
export function deleteBlocks(editor: Editor, selection: NodeRangeSelection) {
  const tr = editor.state.tr;
  const blocks = selectedBlocks(selection).filter((b) => b.node.type.name !== "databaseViews");
  for (const b of blocks.reverse()) tr.delete(tr.mapping.map(b.pos), tr.mapping.map(b.pos + b.node.nodeSize));
  if (!tr.docChanged) return false;
  // An emptied page keeps one empty line to type in.
  if (tr.doc.childCount === 0) tr.insert(0, editor.schema.nodes.paragraph.create());
  const at = Math.min(tr.mapping.map(selection.from), tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/**
 * Selecting whole blocks, as in Notion: Esc selects the block with the cursor, Shift-↑ / Shift-↓
 * grow the selection by a block, Shift-click stretches it to the clicked block, and a drag from the
 * page's margin draws a box across blocks (see `selectBlocksBetween`). Backspace or Delete deletes
 * them all (files on deleted lines go to the Trash as usual), as does the block menu's Delete with
 * them selected; ⌘C / ⌘X copy and cut them.
 */
export const BlockSelect = Extension.create({
  name: "blockSelect",
  // Below the menus (slash commands, links, mentions): their Esc closes them first.
  priority: 50,
  addKeyboardShortcuts() {
    const set = (sel: NodeRangeSelection | TextSelection) => (this.editor.view.dispatch(this.editor.state.tr.setSelection(sel).scrollIntoView()), true);
    return {
      Escape: () => {
        const { selection, doc } = this.editor.state;
        if (selection instanceof NodeRangeSelection) return false;
        if (!(selection instanceof TextSelection)) return false;
        return set(NodeRangeSelection.create(doc, selection.from, selection.to));
      },
      "Shift-ArrowUp": () => {
        const { selection } = this.editor.state;
        return selection instanceof NodeRangeSelection && set(selection.extendBackwards());
      },
      "Shift-ArrowDown": () => {
        const { selection } = this.editor.state;
        return selection instanceof NodeRangeSelection && set(selection.extendForwards());
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockSelect"),
        props: {
          decorations: (state) => (state.selection instanceof NodeRangeSelection ? getNodeRangeDecorations([...state.selection.ranges]) : null),
          attributes: (state): Record<string, string> => (state.selection instanceof NodeRangeSelection ? { class: "has-block-selection" } : {}),
          handleDOMEvents: {
            // Esc on selected blocks clears them, back to a cursor. Handled here (not as a shortcut,
            // which would select the block again), and not stopped: it goes on, e.g. to close the peek.
            // Backspace and Delete delete them, ahead of the editor's own deleting (which would
            // refuse a selection holding a database page's views).
            keydown: (view, event) => {
              const { selection } = view.state;
              if (!(selection instanceof NodeRangeSelection)) return false;
              if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault();
                deleteBlocks(this.editor, selection);
                return true;
              }
              if (event.key !== "Escape") return false;
              view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(selection.from))));
              return true;
            },
            // Shift-click with blocks selected: the selection reaches the clicked block.
            mousedown: (view, event) => {
              const { selection, doc } = view.state;
              if (!event.shiftKey || event.button !== 0 || !(selection instanceof NodeRangeSelection)) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              event.preventDefault();
              const anchor = at.pos < selection.from ? selection.to : selection.from;
              view.dispatch(view.state.tr.setSelection(NodeRangeSelection.create(doc, anchor, at.pos)));
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** Selects the page's top-level blocks whose boxes overlap `top`–`bottom` (window coordinates), if any. */
export function selectBlocksBetween(editor: Editor, top: number, bottom: number) {
  const { view } = editor;
  let from: number | null = null;
  let to: number | null = null;
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    const box = dom?.getBoundingClientRect?.();
    if (!box || box.bottom < top || box.top > bottom) return;
    from ??= offset;
    to = offset + node.nodeSize;
  });
  if (from === null || to === null) return false;
  view.dispatch(view.state.tr.setSelection(NodeRangeSelection.create(view.state.doc, from, to, 0)));
  view.focus();
  return true;
}
