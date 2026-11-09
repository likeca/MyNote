import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import { isAssetPath } from "../lib/assets";
import { textColor } from "../lib/colors";

/**
 * Page icons, stored as a frontmatter string:
 *   "🚀"                    an emoji
 *   "lucide:Rocket:blue"    a flat icon in one of the palette colours
 *   "Page/_assets/logo-123.png"  a custom image uploaded into the page's folder
 *   "https://…/icon.png"    an image link
 */
export type ParsedIcon =
  | { kind: "emoji"; value: string }
  | { kind: "lucide"; name: string; color: string }
  | { kind: "image"; src: string; local: boolean };

export function parseIcon(icon: string): ParsedIcon {
  if (icon.startsWith("lucide:")) {
    const [, name, color = "default"] = icon.split(":");
    if (name) return { kind: "lucide", name, color };
  }
  if (isAssetPath(icon)) return { kind: "image", src: icon, local: true };
  if (/^https?:\/\//.test(icon)) return { kind: "image", src: icon, local: false };
  return { kind: "emoji", value: icon };
}

export const lucideIcon = (name: string, color: string) => `lucide:${name}:${color}`;

// Every Lucide icon, loaded the first time a page shows one, so the app starts without them.
let iconMap: Record<string, LucideIcon> | null = null;
let loadingIcons: Promise<Record<string, LucideIcon>> | null = null;
export function loadIcons() {
  loadingIcons ??= import("./lucideIcons").then((m) => (iconMap = m.icons as Record<string, LucideIcon>));
  return loadingIcons;
}

function LucidePageIcon({ name, color, size, className }: { name: string; color: string; size: number; className: string }) {
  const [map, setMap] = useState(iconMap);
  useEffect(() => {
    if (!map) loadIcons().then(setMap);
  }, [map]);
  const Component = map?.[name];
  if (!Component) return <span style={{ width: size, height: size }} className={`inline-block shrink-0 ${className}`} />;
  return <Component size={size} strokeWidth={size > 40 ? 1.5 : 2} className={`shrink-0 ${className}`} style={{ color: textColor(color) ?? "var(--muted)" }} />;
}

const assetUrls = new Map<string, Promise<string>>();

/** Loads a vault asset as an object URL, cached for the session. */
export function assetUrl(path: string): Promise<string> {
  let url = assetUrls.get(path);
  if (!url) {
    // The webview works out most image types from their bytes, but shows SVG only when told it's SVG.
    const type = /\.svg$/i.test(path) ? "image/svg+xml" : "";
    url = api.readAsset(path).then((buf) => URL.createObjectURL(new Blob([buf], { type })));
    url.catch(() => assetUrls.delete(path));
    assetUrls.set(path, url);
  }
  return url;
}

/** Event (detail: the asset's path) telling views showing an asset that it changed. */
export const ASSET_CHANGED = "mynote:asset-changed";

/** Forgets a rewritten asset's cached URL and has the views showing it load it again. */
export function assetChanged(path: string) {
  assetUrls.get(path)?.then(URL.revokeObjectURL, () => {});
  assetUrls.delete(path);
  window.dispatchEvent(new CustomEvent(ASSET_CHANGED, { detail: path }));
}

function AssetImage({ src, local, size }: { src: string; local: boolean; size: number }) {
  const [url, setUrl] = useState(local ? null : src);
  useEffect(() => {
    if (!local) return setUrl(src);
    let alive = true;
    assetUrl(src).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [src, local]);
  const style: CSSProperties = { width: size, height: size };
  return url ? <img src={url} alt="" draggable={false} style={style} className="shrink-0 rounded-[3px] object-cover" /> : <span style={style} className="inline-block shrink-0" />;
}

export function PageIcon({ icon, size = 16, className = "" }: { icon: string; size?: number; className?: string }) {
  const parsed = parseIcon(icon);
  if (parsed.kind === "lucide") return <LucidePageIcon name={parsed.name} color={parsed.color} size={size} className={className} />;
  if (parsed.kind === "image") return <AssetImage src={parsed.src} local={parsed.local} size={size} />;
  return (
    // A line icon only fills ~85% of its box, so emoji are drawn at that size to look the same.
    <span className={`inline-grid shrink-0 place-items-center leading-none ${className}`} style={{ fontSize: Math.round(size * 0.88), width: size, height: size }}>
      {parsed.value}
    </span>
  );
}
