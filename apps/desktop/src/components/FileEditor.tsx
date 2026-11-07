import { listen } from "@tauri-apps/api/event";
import { FileQuestion, FolderOpen, SquareArrowOutUpRight, WrapText } from "lucide-react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { fileName } from "../lib/fileTabs";
import { isQuietWrite, markQuietWrite } from "../lib/quiet";
import { useSettings } from "../lib/settings";

// Monaco's language services run in workers, bundled with the app (nothing is fetched).
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

/** Bigger files open in their own app: an editor this size gets slow. */
const MAX_BYTES = 10 * 1024 * 1024;
/** Edits save this long after the typing stops (⌘S saves at once). */
const SAVE_AFTER = 700;
const FONT = 13;

/**
 * VS Code's Monokai (its monokai-color-theme.json), for Monaco: its colours as VS Code has them,
 * on black instead of Monokai's dark olive (#272822), and its token colours given to the names
 * Monaco's highlighters use for the same things.
 */
monaco.editor.defineTheme("monokai", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "F8F8F2" },
    { token: "comment", foreground: "88846F" },
    { token: "string", foreground: "E6DB74" },
    { token: "string.escape", foreground: "AE81FF" },
    { token: "regexp", foreground: "E6DB74" },
    { token: "number", foreground: "AE81FF" },
    { token: "constant", foreground: "AE81FF" },
    { token: "keyword", foreground: "F92672" },
    { token: "operator", foreground: "F92672" },
    // A type the language has (`int`, `string`) is storage.type; a named one (`Editor`) a class name.
    { token: "type", foreground: "66D9EF", fontStyle: "italic" },
    { token: "type.identifier", foreground: "A6E22E", fontStyle: "underline" },
    { token: "predefined", foreground: "66D9EF" },
    { token: "identifier", foreground: "F8F8F2" },
    { token: "variable", foreground: "F8F8F2" },
    { token: "delimiter", foreground: "F8F8F2" },
    { token: "tag", foreground: "F92672" },
    { token: "metatag", foreground: "F92672" },
    { token: "attribute.name", foreground: "A6E22E" },
    { token: "attribute.value", foreground: "E6DB74" },
    { token: "invalid", foreground: "F44747" },
    // JSON: keys are support.type.property-name, string values Monokai's own JSON string colour.
    { token: "string.key.json", foreground: "66D9EF", fontStyle: "italic" },
    { token: "string.value.json", foreground: "CFCFC2" },
    { token: "keyword.json", foreground: "AE81FF" },
    // YAML keys are tag names (entity.name.tag) in VS Code.
    { token: "type.yaml", foreground: "F92672", fontStyle: "" },
    // Its true, false and null are constants (constant.language).
    { token: "keyword.yaml", foreground: "AE81FF" },
    // Monaco's Python marks a string's quotes as escapes; they're the string's own colour in VS Code.
    { token: "string.escape.python", foreground: "E6DB74" },
    // CSS properties are support.type.property-name.
    { token: "attribute.name.css", foreground: "66D9EF", fontStyle: "italic" },
    { token: "attribute.name.scss", foreground: "66D9EF", fontStyle: "italic" },
    { token: "attribute.name.less", foreground: "66D9EF", fontStyle: "italic" },
    { token: "keyword.md", foreground: "A6E22E", fontStyle: "bold" },
  ],
  colors: {
    "editor.background": "#000000",
    "editor.foreground": "#F8F8F2",
    "editorGutter.background": "#000000",
    "editor.selectionBackground": "#878B9180",
    "editor.selectionHighlightBackground": "#575B6180",
    "editor.wordHighlightBackground": "#4A4A7680",
    "editor.wordHighlightStrongBackground": "#6A6A9680",
    "editor.lineHighlightBackground": "#3E3D32",
    "editorLineNumber.foreground": "#90908A",
    "editorLineNumber.activeForeground": "#C2C2BF",
    "editorCursor.foreground": "#F8F8F0",
    "editorWhitespace.foreground": "#464741",
    "editorIndentGuide.background1": "#464741",
    "editorIndentGuide.activeBackground1": "#767771",
    "editorWidget.background": "#1E1F1C",
    "editorHoverWidget.background": "#414339",
    "editorHoverWidget.border": "#75715E",
    "editorSuggestWidget.background": "#000000",
    "editorSuggestWidget.border": "#75715E",
    "input.background": "#414339",
    "inputOption.activeBorder": "#75715E",
    "focusBorder": "#99947C",
    "widget.shadow": "#00000098",
    "list.hoverBackground": "#3E3D32",
    "list.activeSelectionBackground": "#75715E",
    "list.inactiveSelectionBackground": "#414339",
    "list.highlightForeground": "#F8F8F2",
    "peekView.border": "#75715E",
    "peekViewEditor.background": "#000000",
    "peekViewResult.background": "#1E1F1C",
    "peekViewTitle.background": "#1E1F1C",
  },
});

type Loaded = { kind: "loading" } | { kind: "ready" } | { kind: "missing" } | { kind: "binary" } | { kind: "large"; size: number } | { kind: "error"; message: string };
type Saved = "saved" | "unsaved" | "saving" | { error: string };

/** Text in UTF-8, or null for a file that isn't text (a NUL byte, or bytes that aren't UTF-8). */
function asText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * An attached file in its own tab, in Monaco (VS Code's editor): highlighting by its extension,
 * find and replace, multiple cursors. Edits save as you go (⌘S at once); a change made
 * elsewhere (an agent, another app) comes in while there's nothing unsaved here. Stays mounted
 * (hidden) while other tabs show, so undo and the scroll position last.
 */
export default function FileEditor({ path, active }: { path: string; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [saved, setSaved] = useState<Saved>("saved");
  const [wrap, setWrap] = useState(false);
  const [language, setLanguage] = useState("");
  const { textZoom } = useSettings();
  // Read when the editor is made, after the file loads.
  const textZoomRef = useRef(textZoom);
  textZoomRef.current = textZoom;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let model: monaco.editor.ITextModel | null = null;
    // What's on disk as far as we know: an edit differs from it until it's saved.
    let onDisk = "";
    const write = async () => {
      window.clearTimeout(timer);
      if (!model || model.getValue() === onDisk) return;
      const text = model.getValue();
      setSaved("saving");
      try {
        markQuietWrite(path);
        await api.writeAssetText(path, text);
        onDisk = text;
        if (alive) setSaved(model.getValue() === text ? "saved" : "unsaved");
      } catch (e) {
        if (alive) setSaved({ error: String(e) });
      }
    };

    (async () => {
      // `fileSize` also brings back a file the Trash took when its last link went (see open_attachment).
      const size = await api.fileSize(path).catch(() => null);
      if (!alive) return;
      if (size === null) return setLoaded({ kind: "missing" });
      if (size > MAX_BYTES) return setLoaded({ kind: "large", size });
      const text = asText(new Uint8Array(await api.readAsset(path)));
      if (!alive) return;
      if (text === null) return setLoaded({ kind: "binary" });
      onDisk = text;
      const uri = monaco.Uri.file(`/${path}`);
      monaco.editor.getModel(uri)?.dispose();
      // No language given: Monaco picks it from the file's extension (or name, like `Dockerfile`).
      model = monaco.editor.createModel(text, undefined, uri);
      setLanguage(monaco.languages.getLanguages().find((l) => l.id === model!.getLanguageId())?.aliases?.[0] ?? model.getLanguageId());
      const ed = monaco.editor.create(box.current!, {
        model,
        theme: "monokai",
        automaticLayout: true,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: Math.round(FONT * textZoomRef.current),
        lineHeight: 1.5,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        smoothScrolling: true,
        padding: { top: 12 },
      });
      editor.current = ed;
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void write());
      ed.onDidChangeModelContent(() => {
        setSaved(model!.getValue() === onDisk ? "saved" : "unsaved");
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void write(), SAVE_AFTER);
      });
      setLoaded({ kind: "ready" });
      if (activeRef.current) ed.focus();
    })().catch((e) => alive && setLoaded({ kind: "error", message: String(e) }));

    // Changed on disk by someone else: taken in (as an edit, so ⌘Z still works) unless there's
    // something unsaved here, which wins on the next save.
    const changed = listen<string[]>("vault-changed", async (e) => {
      if (!model || isQuietWrite(path) || !e.payload.some((p) => p.endsWith(`/${path}`))) return;
      if (model.getValue() !== onDisk) return;
      const bytes = await api.readAsset(path).catch(() => null);
      const text = bytes && asText(new Uint8Array(bytes));
      if (text === null || text === onDisk || !model || model.getValue() !== onDisk) return;
      onDisk = text;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      setSaved("saved");
    });

    return () => {
      alive = false;
      // Leaving (closing the tab, or the page): what's unsaved is saved.
      void write().finally(() => {
        editor.current?.dispose();
        editor.current = null;
        model?.dispose();
      });
      void changed.then((off) => off());
    };
  }, [path]);

  // The page text zoom (⌘+ / ⌘−) sizes the editor's text too.
  useEffect(() => {
    editor.current?.updateOptions({ fontSize: Math.round(FONT * textZoom) });
  }, [textZoom, loaded.kind]);
  useEffect(() => editor.current?.updateOptions({ wordWrap: wrap ? "on" : "off" }), [wrap]);

  // Shown again: type straight into it.
  useEffect(() => {
    if (active) requestAnimationFrame(() => editor.current?.focus());
  }, [active]);

  const status =
    saved === "saving" ? "Saving…" : saved === "unsaved" ? "Unsaved changes" : saved === "saved" ? "Saved" : `Couldn't save: ${saved.error}`;
  const tool = "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-ink";

  return (
    <div data-file-editor className={`absolute inset-0 flex flex-col bg-surface ${active ? "" : "invisible"}`}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="truncate text-sm font-medium text-ink">{fileName(path)}</span>
        <span className="min-w-0 truncate text-xs text-faint" title={path}>
          {path}
        </span>
        {loaded.kind === "ready" && (
          <span className={`shrink-0 text-xs ${typeof saved === "object" ? "text-[var(--c-red-text)]" : "text-faint"}`}>· {status}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {loaded.kind === "ready" && (
            <>
              <span className="px-2 text-xs text-faint">{language}</span>
              <button onClick={() => setWrap((w) => !w)} title="Wrap long lines" className={`${tool} ${wrap ? "bg-hover text-ink" : ""}`}>
                <WrapText size={14} /> Wrap
              </button>
            </>
          )}
          <button onClick={() => void api.openAttachment(path, true)} title="Show in Finder" className={tool}>
            <FolderOpen size={14} />
          </button>
          <button onClick={() => void api.openAttachment(path, false)} title="Open in its default app" className={tool}>
            <SquareArrowOutUpRight size={14} />
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" />
        {loaded.kind !== "ready" && loaded.kind !== "loading" && (
          <div className="absolute inset-0 grid place-items-center bg-surface">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <FileQuestion size={28} className="text-faint" />
              <p className="text-sm text-muted">
                {loaded.kind === "missing"
                  ? "This file isn't in the workspace any more."
                  : loaded.kind === "binary"
                    ? "This file isn't text, so it can't be edited here."
                    : loaded.kind === "large"
                      ? `This file is too big to edit here (${Math.round(loaded.size / 1024 / 1024)} MB).`
                      : `Couldn't open this file: ${loaded.message}`}
              </p>
              {loaded.kind !== "missing" && (
                <button onClick={() => void api.openAttachment(path, false)} className="rounded-md bg-[var(--blue)] px-3 py-1.5 text-sm font-medium text-white">
                  Open in its default app
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
