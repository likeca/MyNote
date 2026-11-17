import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "../lib/api";

/** Where the last errors are kept (ui-state.json in the app's settings folder), newest first. */
const KEY = "errors";
const KEEP = 10;

type Entry = { at: string; kind: string; message: string; stack?: string; component?: string };

/** Adds an error to the saved list, so what happened can be found after a reload or restart. */
export async function recordError(kind: string, error: unknown, component?: string) {
  const e = error instanceof Error ? error : new Error(String(error));
  const entry: Entry = { at: new Date().toISOString(), kind, message: e.message, stack: e.stack, component };
  try {
    const saved = JSON.parse((await api.uiStateGet(KEY)) ?? "[]") as Entry[];
    await api.uiStateSet(KEY, JSON.stringify([entry, ...saved].slice(0, KEEP)));
  } catch {
    /* outside the desktop app (tests, the browser) there's nowhere to keep it */
  }
}

/** Errors outside React's drawing (event handlers, promises) are kept too; they don't blank the window. */
export function recordGlobalErrors() {
  window.addEventListener("error", (e) => void recordError("error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => void recordError("unhandledrejection", e.reason));
}

/**
 * Catches an error while drawing the app, which would otherwise leave an empty (black) window
 * until a restart: shows what happened, keeps it in the saved errors, and offers a reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; component?: string }> {
  state: { error: Error | null; component?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ component: info.componentStack ?? undefined });
    void recordError("render", error, info.componentStack ?? undefined);
  }

  render() {
    const { error, component } = this.state;
    if (!error) return this.props.children;
    const details = `${error.message}\n\n${error.stack ?? ""}${component ? `\n\nIn:${component}` : ""}`;
    return (
      <div data-tauri-drag-region className="grid h-full place-items-center bg-surface p-8 text-ink">
        <div className="w-full max-w-xl">
          <h1 className="text-lg font-semibold">MyNote ran into a problem</h1>
          <p className="mt-1 text-sm text-muted">Your pages are saved. Reload to carry on; the details below are kept for fixing it.</p>
          <pre className="mt-4 max-h-64 overflow-auto rounded-md border border-line bg-side p-3 font-mono text-xs whitespace-pre-wrap text-muted select-text">{details}</pre>
          <div className="mt-4 flex gap-2">
            <button onClick={() => window.location.reload()} className="rounded-md bg-[var(--blue)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110">
              Reload
            </button>
            <button onClick={() => void navigator.clipboard.writeText(details)} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-hover">
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
