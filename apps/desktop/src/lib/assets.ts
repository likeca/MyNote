/**
 * Files in the workspace: a page's attached files and uploaded images live in an `_assets/` folder
 * inside the page's own folder (`Projects/Plan/_assets/report.pdf`); files of no page (imports) in
 * the workspace's `_assets/`.
 */
const IN_ASSETS = /(^|\/)_assets\//;

/** Whether `path` (a link's target, an icon, a cover) is a file in the workspace's attachments. */
export const isAssetPath = (path: string | null | undefined) => !!path && !/^[a-z][a-z0-9+.-]*:/i.test(path) && IN_ASSETS.test(path);
