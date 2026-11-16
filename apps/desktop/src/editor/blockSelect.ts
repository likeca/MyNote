import { Extension, type Editor } from "@tiptap/core";
import { NodeRangeSelection, getNodeRangeDecorations } from "@tiptap/extension-node-range";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { canJoin } from "@tiptap/pm/transform";

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
      // Into or out of the toggle above (lists, tables and code blocks handle their own Tab first).
      Tab: () => nestBlocks(this.editor, 1),
      "Shift-Tab": () => nestBlocks(this.editor, -1),
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
              // Tab and ⇧Tab move selected blocks into and out of toggles, ahead of the Tab of a
              // table or code block (next cell, indent) that would otherwise take it.
              if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                if (!nestBlocks(this.editor, event.shiftKey ? -1 : 1)) return false;
                event.preventDefault();
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

/** Sibling blocks from `from` to `to` (their boundaries) in a parent at `depth`. */
type Run = { from: number; to: number; depth: number };

/** Blocks that hold the page's blocks: blocks inside them can move into a toggle beside them. */
const CONTAINERS = ["doc", "detailsContent", "column"];

/**
 * The blocks Tab moves: the selected blocks, or the block the cursor is in (a toggle's whole self
 * from its title). Selected lines in a table, callout or quote move the whole table, callout or
 * quote. A cursor in a list, table or code, or a selection in a list, is left to their own Tab.
 */
function runToMove(state: EditorState): Run | null {
  const { selection } = state;
  if (selection instanceof NodeRangeSelection) {
    const first = selection.ranges[0].$from;
    // Only the title of a toggle selected: the toggle is what moves.
    if (first.parent.type.name === "details") return { from: first.before(), to: first.after(), depth: first.depth - 1 };
    if (CONTAINERS.includes(first.parent.type.name)) return { from: first.pos, to: selection.ranges[selection.ranges.length - 1].$to.pos, depth: first.depth };
    // Inside a table, callout or quote: the whole of it (the block in the page holding the selection).
    for (let d = first.depth; d >= 1; d--) {
      if (LISTS.includes(first.node(d).type.name)) return null;
      if (CONTAINERS.includes(first.node(d - 1).type.name)) return { from: first.before(d), to: first.after(d), depth: d - 1 };
    }
    return null;
  }
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const depth = $from.parent.type.name === "detailsSummary" ? $from.depth - 1 : $from.depth;
  if (depth < 1 || !CONTAINERS.includes($from.node(depth - 1).type.name)) return null;
  return { from: $from.before(depth), to: $from.after(depth), depth: depth - 1 };
}

/**
 * Tab and ⇧Tab, as in Notion: Tab puts the blocks inside the toggle (or toggle heading) just above
 * them, at its end, opening it; ⇧Tab takes blocks in a toggle out, to just after it. One undo step;
 * the blocks stay selected (or the cursor stays where it was in them). False when they can't move.
 */
export function nestBlocks(editor: Editor, dir: 1 | -1): boolean {
  const { state } = editor;
  const run = runToMove(state);
  if (!run) return false;
  const { doc } = state;
  const $at = doc.resolve(run.from);
  const blocks = doc.slice(run.from, run.to).content;
  const tr = state.tr;
  let start: number;
  let depth: number;
  if (dir === 1) {
    const index = $at.index();
    const prev = index > 0 ? $at.parent.child(index - 1) : null;
    if (prev?.type.name !== "details") return false;
    // The end of the toggle's contents: just inside its two closing tokens.
    const end = run.from - 2;
    const only = prev.child(1).childCount === 1 ? prev.child(1).firstChild : null;
    // A toggle with nothing in it yet (one empty line) takes the blocks in its place.
    start = only?.type.name === "paragraph" && only.content.size === 0 ? end - only.nodeSize : end;
    tr.delete(run.from, run.to).replaceWith(start, end, blocks);
    if (!prev.attrs.open) tr.setNodeAttribute(run.from - prev.nodeSize, "open", true);
    depth = run.depth + 2;
  } else {
    if ($at.parent.type.name !== "detailsContent") return false;
    const after = $at.after(run.depth - 1);
    // Taking everything out leaves the toggle one empty line, as a new toggle has.
    const all = run.from === $at.start() && run.to === $at.end();
    tr.insert(after, blocks);
    if (all) tr.replaceWith(run.from, run.to, state.schema.nodes.paragraph.create());
    else tr.delete(run.from, run.to);
    start = after - (run.to - run.from) + (all ? 2 : 0);
    depth = run.depth - 2;
  }
  const shift = start - run.from;
  const { selection } = state;
  tr.setSelection(
    selection instanceof NodeRangeSelection
      ? NodeRangeSelection.create(tr.doc, start, start + blocks.size, depth)
      : TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift),
  );
  // Where the move put two lists of one kind side by side, they're one list: Markdown can't keep
  // them apart (the file would read back as one), so the page shows them joined now. Latest first,
  // so the earlier positions still hold; the selection follows.
  const seams = dir === 1 ? [start] : [start + blocks.size, run.from];
  for (const pos of seams) joinLists(tr, pos);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const LISTS = ["bulletList", "orderedList", "taskList"];

/** Joins the lists on either side of `pos` when they're lists of the same kind. */
function joinLists(tr: Transaction, pos: number) {
  if (pos <= 0 || pos >= tr.doc.content.size) return;
  const $pos = tr.doc.resolve(pos);
  const [a, b] = [$pos.nodeBefore, $pos.nodeAfter];
  if (a && b && a.type === b.type && LISTS.includes(a.type.name) && canJoin(tr.doc, pos)) tr.join(pos);
}

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
