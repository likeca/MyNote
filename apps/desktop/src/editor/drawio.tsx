/**
 * draw.io diagrams. They're edited in draw.io's own editor, embed.diagrams.net (so editing needs the
 * internet), shown over the whole window and talking to MyNote with postMessage; the diagram is handed
 * to it and back, not uploaded. A diagram is kept as a `.drawio.svg` in the page's `_assets/`: an SVG
 * picture with the diagram inside, so a page shows it as an ordinary image (Markdown
 * `![Diagram](Page/_assets/….drawio.svg)`)
 * and draw.io's desktop app or VS Code extension can open the file too.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { assetChanged } from "../components/PageIcon";
import { api } from "../lib/api";
import { isAssetPath } from "../lib/assets";

const ORIGIN = "https://embed.diagrams.net";
/** Shape libraries on, Save plus Save & Exit buttons, "Unsaved changes" while there are some. */
const EDITOR_URL = `${ORIGIN}/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1&modified=unsavedChanges&lang=en`;
/** How long draw.io gets to load before MyNote says it can't be reached. */
const LOAD_TIMEOUT_MS = 20_000;

/** Whether an image is a draw.io diagram MyNote can edit: one of the workspace's own `.drawio.svg` files. */
export const isEditableDiagram = (src: string) => isAssetPath(src) && /\.drawio\.svg$/i.test(src);

/**
 * Opens draw.io on a new, blank diagram. Its first save puts it in the page where the cursor was;
 * later saves (before Exit) update that same file.
 */
export function newDiagram(editor: Editor) {
  const at = editor.state.selection.from;
  let src: string | null = null;
  openDiagramEditor({
    onSave: async (bytes) => {
      if (src) {
        await api.writeAsset(src, [...bytes]);
        return assetChanged(src);
      }
      src = await api.saveAsset("Diagram.drawio.svg", [...bytes], editor.storage.fileAttachment.page);
      if (editor.isDestroyed) return;
      editor.chain().insertContentAt(Math.min(at, editor.state.doc.content.size), { type: "image", attrs: { src, alt: "Diagram" } }).run();
    },
  });
}

/**
 * Opens draw.io over the window. `svg` is the `.drawio.svg` to edit (none: a new, blank diagram). Each
 * save hands `onSave` the diagram as `.drawio.svg` bytes; the editor closes on Exit, or Save & Exit once saved.
 */
export function openDiagramEditor({ svg, onSave }: { svg?: Uint8Array; onSave: (bytes: Uint8Array) => Promise<void> }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  // draw.io reads a diagram inside an SVG from a data URI.
  root.render(<DiagramEditor diagram={svg ? svgDataUri(svg) : ""} onSave={onSave} onClose={close} />);
}

function DiagramEditor({ diagram, onSave, onClose }: { diagram: string; onSave: (bytes: Uint8Array) => Promise<void>; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    const post = (msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(msg), ORIGIN);
    let ready = false;
    let exitAfterSave = false;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN || e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let msg: { event?: string; exit?: boolean; data?: string };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.event) {
        case "init":
          ready = true;
          setUnreachable(false);
          post({ action: "load", xml: diagram, title: "Diagram", dark: document.documentElement.dataset.theme === "dark" });
          break;
        case "save":
          // Asks for the diagram as an SVG with the diagram inside: it comes back as an `export` event.
          // Light on white, so it reads in any theme and anywhere else the Markdown is shown.
          exitAfterSave = !!msg.exit;
          post({ action: "export", format: "xmlsvg", theme: "light", background: "#ffffff", border: 8, spinKey: "saving" });
          break;
        case "export":
          if (!msg.data) return;
          onSave(svgBytes(msg.data)).then(
            () => (exitAfterSave ? onClose() : post({ action: "status", modified: false })),
            (err) => post({ action: "dialog", title: "Couldn't save the diagram", message: String(err), button: "OK", modified: true }),
          );
          break;
        case "exit":
          onClose();
          break;
      }
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => !ready && setUnreachable(true), LOAD_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [diagram, onSave, onClose]);
  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-surface">
      {/* The window's own buttons sit in the top-left corner: a bar keeps them off draw.io's menus. */}
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center pl-[88px] text-sm text-muted">
        Diagram · draw.io
      </div>
      <iframe ref={frame} src={EDITOR_URL} title="draw.io" allow="clipboard-read; clipboard-write" className="min-h-0 w-full flex-1 border-0" />
      {unreachable && (
        <div className="absolute inset-x-0 top-10 bottom-0 grid place-items-center bg-surface">
          <div className="max-w-sm text-center text-sm text-muted">
            <p className="mb-1 font-medium text-ink">Couldn't reach draw.io</p>
            <p className="mb-4">Diagrams are edited in draw.io's online editor (embed.diagrams.net), so MyNote needs an internet connection for it.</p>
            <button onClick={onClose} className="h-8 rounded-md border border-line px-3 text-ink hover:bg-hover">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The bytes of an SVG data URI, base64 (how draw.io exports) or plain. */
function svgBytes(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(",");
  const head = dataUri.slice(0, comma);
  const body = dataUri.slice(comma + 1);
  if (!head.endsWith(";base64")) return new TextEncoder().encode(decodeURIComponent(body));
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function svgDataUri(svg: Uint8Array): string {
  let binary = "";
  for (const byte of svg) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
