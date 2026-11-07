/**
 * Attached files open in tabs of their own, in a code editor (components/FileEditor): a tab's
 * path is `@file/` and the file's workspace path, e.g. `@file/.assets/Notes/config.json`.
 */
const PREFIX = "@file/";

export const isFileTab = (path: string | null | undefined) => !!path?.startsWith(PREFIX);
export const fileTab = (asset: string) => PREFIX + asset;
export const fileOfTab = (path: string) => path.slice(PREFIX.length);
export const fileName = (asset: string) => asset.split("/").pop() ?? asset;

/** Files a code editor can't show (pictures, sound, video, documents, archives…): they open in their own app. */
const OWN_APP =
  /\.(png|jpe?g|gif|webp|heic|heif|avif|tiff?|bmp|ico|icns|psd|ai|sketch|fig|xd|mp3|wav|m4a|aac|flac|ogg|opus|aiff?|mp4|mov|m4v|mkv|avi|webm|pdf|docx?|xlsx?|pptx?|odt|ods|odp|key|pages|numbers|rtf|epub|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|pkg|exe|msi|dll|so|dylib|bin|iso|woff2?|ttf|otf|eot|sqlite3?|db|class|jar|wasm|o|a)$/i;
export const opensInEditor = (name: string) => !OWN_APP.test(name);
