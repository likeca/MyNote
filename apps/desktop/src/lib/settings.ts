import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { NO_COLORS, colorsCss, isHex, sanitizeColors, type CustomColors, type Tone } from "./customColors";

/** "black" is dark mode with true-black surfaces. */
export type Mode = "system" | "light" | "dark" | "black";
export type Palette = "mynote" | "graphite" | "midnight";
export type TextSize = "small" | "default" | "large";

export type Settings = {
  mode: Mode;
  palette: Palette;
  accent: string;
  textSize: TextSize;
  /** Page text zoom on top of the text size (⌘+ and ⌘−): 1 is 100%. */
  textZoom: number;
  /** Pages use the whole window width, unless a page sets its own `fullWidth`. */
  fullWidth: boolean;
  /** Seconds of quiet before auto-committing; 0 turns it off. */
  autocommit: number;
  /** Seconds between automatic syncs with the remote; 0 turns it off. */
  autosync: number;
  /** Mark pages hidden from (or, in share-only mode, not shared with) AI agents in the sidebar. */
  sidebarAiBadges: boolean;
  /** How many Recents rows the sidebar shows; its height stays fixed at this many. */
  recentRows: number;
  /** Access Key of the person's own Unsplash developer app, for cover photo search. */
  unsplashKey: string;
  /** Fine-tuned theme colours (Appearance → Colours), per theme, on top of the palette. */
  colors: CustomColors;
};

export const ACCENTS: { id: string; label: string; color: string }[] = [
  { id: "ember", label: "Ember", color: "#e2582b" },
  { id: "blue", label: "Blue", color: "#2383e2" },
  { id: "violet", label: "Violet", color: "#7c5cff" },
  { id: "emerald", label: "Emerald", color: "#10a37f" },
  { id: "rose", label: "Rose", color: "#e0457b" },
  { id: "amber", label: "Amber", color: "#d98a0b" },
];

export const PALETTES: { id: Palette; label: string; hint: string; swatch: [string, string, string] }[] = [
  { id: "mynote", label: "MyNote", hint: "Warm ember neutrals", swatch: ["#1b1715", "#221d1a", "#e2582b"] },
  { id: "graphite", label: "Graphite", hint: "Neutral greys", swatch: ["#191919", "#202020", "#9b9b9b"] },
  { id: "midnight", label: "Midnight", hint: "Cool blue slate", swatch: ["#13161d", "#191d26", "#5b7cfa"] },
];

const DEFAULTS: Settings = { mode: "system", palette: "mynote", accent: "ember", textSize: "default", textZoom: 1, fullWidth: true, autocommit: 8, autosync: 300, sidebarAiBadges: false, recentRows: 5, unsplashKey: "", colors: NO_COLORS };

/** The steps ⌘+ and ⌘− move through, like a browser's zoom. */
const TEXT_ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const KEY = "mynote-settings";
// Legacy name (before the rename to MyNote): read once if the new key is absent.
const LEGACY_KEY = "betelgeuse-settings";

function load(): Settings {
  try {
    const saved = localStorage.getItem(KEY);
    const s: Settings = { ...DEFAULTS, ...JSON.parse(saved ?? localStorage.getItem(LEGACY_KEY) ?? "{}") };
    // Legacy palette id (before the rename to MyNote).
    if ((s.palette as string) === "betelgeuse") s.palette = "mynote";
    s.colors = sanitizeColors(s.colors);
    if (!(typeof s.textZoom === "number" && s.textZoom >= TEXT_ZOOMS[0] && s.textZoom <= TEXT_ZOOMS.at(-1)!)) s.textZoom = 1;
    if (saved === null) {
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* fine: re-read next launch */
      }
    }
    return s;
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* settings still apply for this session */
  }
  apply();
  if ("autocommit" in patch) api.setAutocommit(current.autocommit).catch(() => {});
  if ("autosync" in patch) api.setAutosync(current.autosync).catch(() => {});
  listeners.forEach((l) => l());
}

/** Zooms page text one step in (1) or out (-1), or back to 100% (0). Returns the new zoom. */
export function zoomText(step: 1 | -1 | 0): number {
  const z = current.textZoom;
  const bigger = TEXT_ZOOMS.filter((s) => s > z + 0.001);
  const smaller = TEXT_ZOOMS.filter((s) => s < z - 0.001);
  const next = step === 0 ? 1 : step > 0 ? (bigger[0] ?? z) : (smaller.at(-1) ?? z);
  updateSettings({ textZoom: next });
  return next;
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

/** The theme showing now: Light, Dark or Black (System follows the OS). */
export const themeTone = (s: Settings): Tone => (s.mode === "black" ? "black" : s.mode === "dark" || (s.mode === "system" && systemDark()) ? "dark" : "light");

/** The accent's colour: one of `ACCENTS`, or a custom `#rrggbb`. */
export const accentColor = (accent: string) => ACCENTS.find((a) => a.id === accent)?.color ?? (isHex(accent) ? accent : ACCENTS[0].color);

/** Whether the Dock shows the dark icon, so it changes only when the theme flips. */
let dockDark: boolean | undefined;

/**
 * Writes the appearance settings onto <html> (data attributes, the accent and the theme's custom
 * colours), and matches the Dock icon.
 */
function apply() {
  const root = document.documentElement;
  const tone = themeTone(current);
  const dark = tone !== "light";
  root.dataset.theme = dark ? "dark" : "light";
  if (tone === "black") root.dataset.black = "";
  else delete root.dataset.black;
  root.dataset.palette = current.palette;
  root.dataset.text = current.textSize;
  root.style.setProperty("--blue", accentColor(current.accent));
  root.style.setProperty("--text-zoom", String(current.textZoom));
  root.style.colorScheme = dark ? "dark" : "light";
  let sheet = document.getElementById("custom-colors");
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "custom-colors";
    document.head.appendChild(sheet);
  }
  sheet.textContent = colorsCss(current.colors[tone]);
  if (dark !== dockDark) {
    dockDark = dark;
    api.setDockIcon(dark).catch(() => {}); // only the macOS app has a Dock icon
  }
}

/** Applies settings at startup and follows the OS theme while in System mode. */
export function useApplySettings() {
  useEffect(() => {
    apply();
    api.setAutocommit(current.autocommit).catch(() => {});
    api.setAutosync(current.autosync).catch(() => {});
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => current.mode === "system" && apply();
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);
}

// Apply before React renders to avoid a flash of the wrong theme.
apply();
