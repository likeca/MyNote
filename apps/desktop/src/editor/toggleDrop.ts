import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import type { Slice } from "@tiptap/pm/model";

/**
 * Dragging blocks to just below an open toggle, as in Notion: where the pointer is across the page
 * decides. In line with the toggle's contents (or further right), they go in at the end of the
 * toggle; under its arrow (further left), after it. Without this, the gap under a toggle's last line
 * is a few pixels high and everything else there meant "after the toggle", which, for the block
 * right after it, is where it already is: the drag did nothing.
 */
const EDGE = 24;

function intoToggle(view: EditorView, event: DragEvent, slice: Slice): number | null {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return null;
  const { doc } = view.state;
  let pos = dropPoint(doc, at.pos, slice) ?? at.pos;
  // Near the top edge of a block (a long code block, say, often the one being dragged): the gap
  // above it, as the line under a toggle is only a few pixels high.
  if (at.inside >= 0) {
    const block = view.nodeDOM(at.inside);
    if (doc.nodeAt(at.inside)?.isBlock && block instanceof HTMLElement && event.clientY - block.getBoundingClientRect().top < EDGE) pos = at.inside;
  }
  let into: number | null = null;
  // Toggles inside toggles: as far in as the pointer is.
  for (;;) {
    const before = doc.resolve(pos).nodeBefore;
    if (before?.type.name !== "details" || !before.attrs.open) break;
    const dom = view.nodeDOM(pos - before.nodeSize) as HTMLElement | null;
    const content = dom?.querySelector<HTMLElement>('[data-type="detailsContent"]');
    if (!content || event.clientX < content.getBoundingClientRect().left) break;
    pos -= 2; // inside the toggle's contents, at their end
    into = pos;
  }
  // Never into the toggle being dragged.
  const { selection } = view.state;
  if (into !== null && view.dragging?.move && into >= selection.from && into <= selection.to) return null;
  return into;
}

/** The line showing where the blocks go, along the bottom of the toggle's contents. */
function showLine(view: EditorView, pos: number | null) {
  let line = document.querySelector<HTMLElement>(".toggle-drop-line");
  document.body.toggleAttribute("data-drop-into-toggle", pos !== null);
  if (pos === null) return line?.remove();
  const content = (view.domAtPos(pos).node as HTMLElement).closest?.('[data-type="detailsContent"]');
  if (!content) return line?.remove();
  const r = content.getBoundingClientRect();
  if (!line) {
    line = document.createElement("div");
    line.className = "toggle-drop-line pointer-events-none fixed z-50 h-[3px] rounded-full bg-[var(--blue)]";
    document.body.append(line);
  }
  Object.assign(line.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${r.bottom - 1}px` });
}

export const ToggleDrop = Extension.create({
  name: "toggleDrop",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("toggleDrop"),
        props: {
          handleDOMEvents: {
            dragover: (view, event) => {
              showLine(view, view.dragging ? intoToggle(view, event, view.dragging.slice) : null);
              return false;
            },
            dragleave: (view, event) => {
              if (!view.dom.contains(event.relatedTarget as Node | null)) showLine(view, null);
              return false;
            },
            dragend: (view) => (showLine(view, null), false),
          },
          handleDrop: (view, event, slice, moved) => {
            const into = intoToggle(view, event, slice);
            showLine(view, null);
            if (into === null) return false;
            event.preventDefault();
            const tr = view.state.tr;
            if (moved) tr.deleteSelection();
            const at = tr.mapping.map(into);
            tr.replaceRange(at, at, slice);
            // The moved block stays selected, as after any other drop.
            const node = slice.openStart === 0 && slice.content.childCount === 1 ? slice.content.firstChild : null;
            if (node && tr.doc.nodeAt(at)?.type === node.type) tr.setSelection(NodeSelection.create(tr.doc, at));
            view.dispatch(tr.setMeta("uiEvent", "drop").scrollIntoView());
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});
