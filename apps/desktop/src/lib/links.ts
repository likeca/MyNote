import { openUrl } from "@tauri-apps/plugin-opener";

/** Project links: change these when the repository and funding pages are set up. */
export const LINKS = {
  repo: "https://github.com/likeca/MyNote",
  issues: "https://github.com/likeca/MyNote/issues",
  sponsor: "https://github.com/likeca/MyNote",
  kofi: "https://ko-fi.com/devianlabs",
  website: "https://github.com/likeca/MyNote",
  devianlabs: "https://devianlabs.com",
  node: "https://nodejs.org/en/download",
};

export const open = (url: string) => openUrl(url).catch(() => window.open(url, "_blank"));
