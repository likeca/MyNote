import { useCallback, useSyncExternalStore } from "react";

/** A run of a shell or Python block (or one of its lines): its output so far, then its exit code (null when stopped) or why it couldn't start. */
export type ScriptRun = { id: number; line?: number; output: string; exit?: number | null; error?: string };

/**
 * Code blocks' runs, kept for the session outside the editor: switching tabs unmounts a page's
 * editor, but its blocks' output (and scripts still running) stay, and show again when the page
 * does. A block finds its run again by its page and its code.
 */
type Entry = { key: number; page: string; code: string; run: ScriptRun | null; claimed: boolean };

const entries = new Map<number, Entry>();
const listeners = new Map<number, Set<() => void>>();
let nextKey = 0;

/** The run a code block mounting on `page` with `code` takes up: one left by its earlier mount, or a new, empty one. */
export function claimRun(page: string, code: string): number {
  for (const e of entries.values()) {
    if (!e.claimed && e.page === page && e.code === code) {
      e.claimed = true;
      return e.key;
    }
  }
  const key = ++nextKey;
  entries.set(key, { key, page, code, run: null, claimed: true });
  return key;
}

/** Marks the entry as shown by a mounted block (again, after a remount in development). */
export function holdRun(key: number) {
  const e = entries.get(key);
  if (e) e.claimed = true;
}

/**
 * The block unmounted. With its editor gone (a tab switched, the page closed), its run stays for
 * when the page is shown again. With the editor still open, the block was deleted, unless it shows
 * up again straight away (dragged elsewhere): its script is stopped and its output dropped.
 */
export function releaseRun(key: number, editorGone: () => boolean, stop: (id: number) => void) {
  const e = entries.get(key);
  if (!e) return;
  e.claimed = false;
  setTimeout(() => {
    if (e.claimed || editorGone()) return;
    if (e.run && e.run.exit === undefined && e.run.error === undefined) stop(e.run.id);
    entries.delete(key);
    listeners.delete(key);
  });
}

/** The block's code changed: found by its new code after a remount. */
export function setRunCode(key: number, code: string) {
  const e = entries.get(key);
  if (e) e.code = code;
}

export function updateRun(key: number, f: (run: ScriptRun | null) => ScriptRun | null) {
  const e = entries.get(key);
  if (!e) return;
  e.run = f(e.run);
  for (const l of listeners.get(key) ?? []) l();
}

export function useScriptRun(key: number): ScriptRun | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set.add(onChange));
      return () => void set.delete(onChange);
    },
    [key],
  );
  return useSyncExternalStore(subscribe, () => entries.get(key)?.run ?? null);
}
