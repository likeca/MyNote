import { ask, message } from "@tauri-apps/plugin-dialog";
import { FileText, Search, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { attachmentIcon, formatFileSize } from "../editor/blocks";
import { api, type TrashedFile, type TrashItem } from "../lib/api";
import { timeAgo } from "../lib/time";
import { useVault } from "../lib/vault";
import { PageIcon } from "./PageIcon";
import { Popover } from "./Popover";

const titleOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

/**
 * Trash: deleted pages, and files deleted from their pages, with restore and delete-forever. A
 * restored file goes back in its folder, linked at the end of its page.
 */
export function TrashPanel({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const { refreshKey, refresh, openPage, notes } = useVault();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [files, setFiles] = useState<TrashedFile[]>([]);
  const [query, setQuery] = useState("");

  // Pages first: listing them also clears out what's older than 30 days, files included.
  const load = useCallback(
    () =>
      api
        .listTrash()
        .catch(() => [])
        .then(async (pages) => {
          setItems(pages);
          setFiles(await api.listTrashedFiles().catch(() => []));
        }),
    [],
  );
  useEffect(() => void load(), [load, refreshKey]);

  const restore = async (item: TrashItem) => {
    const path = await api.restoreTrash(item.id);
    await Promise.all([load(), refresh()]);
    openPage(path);
    onClose();
  };

  const purge = async (item?: TrashItem) => {
    const ok = await ask(
      item
        ? `Delete “${item.title}”${item.pages > 1 ? ` and its ${item.pages - 1} sub-page${item.pages > 2 ? "s" : ""}` : ""} forever?\n\nEarlier versions stay in git history.`
        : "Permanently delete everything in the Trash, pages and files?\n\nEarlier versions stay in git history.",
      { title: item ? "Delete forever" : "Empty Trash", kind: "warning", okLabel: item ? "Delete forever" : "Empty Trash" },
    );
    if (!ok) return;
    await api.purgeTrash(item?.id);
    load();
  };

  const restoreFile = async (file: TrashedFile) => {
    try {
      const page = await api.restoreTrashedFile(file.id);
      await Promise.all([load(), refresh()]);
      if (page) {
        openPage(page);
        onClose();
      }
    } catch (e) {
      await message(String(e), { title: "Restore", kind: "warning" });
      load();
    }
  };

  const purgeFile = async (file: TrashedFile) => {
    const ok = await ask(`Delete “${file.name}” forever?\n\nEarlier versions stay in git history.`, {
      title: "Delete forever",
      kind: "warning",
      okLabel: "Delete forever",
    });
    if (!ok) return;
    await api.purgeTrashedFile(file.id);
    load();
  };

  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || i.title.toLowerCase().includes(q) || i.original.toLowerCase().includes(q));
  const shownFiles = files.filter((f) => !q || f.name.toLowerCase().includes(q) || f.original.toLowerCase().includes(q));
  const empty = items !== null && items.length === 0 && files.length === 0;
  const pageTitle = (path: string) => notes.find((n) => n.path === path)?.title ?? titleOf(path);

  return (
    <Popover anchor={anchor} placement="right-start" onClose={onClose} className="flex max-h-[min(520px,70vh)] w-[420px] flex-col">
      <div className="p-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-[var(--search-bg)] px-2 focus-within:border-[var(--blue)]">
          <Search size={14} className="text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and files in Trash"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {items && shown.length === 0 && shownFiles.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
            <Trash2 size={22} className="text-faint" />
            {empty ? "Trash is empty" : "Nothing matches"}
          </div>
        )}
        {shown.length > 0 && shownFiles.length > 0 && <Heading>Pages</Heading>}
        {shown.map((item) => {
          const parent = item.original.includes("/") ? item.original.slice(0, item.original.lastIndexOf("/")) : null;
          return (
            <Row
              key={item.id}
              icon={item.icon ? <PageIcon icon={item.icon} size={16} /> : <FileText size={16} className="text-faint" />}
              title={item.title}
              detail={`${parent ? `in ${parent} · ` : ""}${timeAgo(item.deleted / 1000)}${item.pages > 1 ? ` · ${item.pages - 1} sub-page${item.pages > 2 ? "s" : ""}` : ""}`}
              onRestore={() => restore(item)}
              onPurge={() => purge(item)}
            />
          );
        })}
        {shownFiles.length > 0 && <Heading>Files</Heading>}
        {shownFiles.map((file) => {
          const Icon = attachmentIcon(file.name);
          return (
            <Row
              key={file.id}
              icon={<Icon size={16} className="text-faint" />}
              title={file.name}
              detail={`${file.page ? `from ${pageTitle(file.page)} · ` : ""}${timeAgo(file.deleted / 1000)} · ${formatFileSize(file.size)}`}
              hint={file.original}
              restoreTitle={file.page ? `Restore to “${pageTitle(file.page)}”` : "Restore"}
              onRestore={() => restoreFile(file)}
              onPurge={() => purgeFile(file)}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        <span className="flex-1 text-xs text-faint">Pages and files in Trash are deleted after 30 days.</span>
        {!empty && items && (
          <button onClick={() => purge()} className="rounded-md px-2 py-1 text-xs font-medium text-[var(--c-red-text)] hover:bg-hover">
            Empty Trash
          </button>
        )}
      </div>
    </Popover>
  );
}

function Heading({ children }: { children: string }) {
  return <div className="px-2 pt-2 pb-1 text-xs font-medium text-faint">{children}</div>;
}

function Row(p: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  hint?: string;
  restoreTitle?: string;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div title={p.hint} className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
      <span className="grid w-5 shrink-0 place-items-center">{p.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{p.title}</span>
        <span className="block truncate text-xs text-faint">{p.detail}</span>
      </span>
      <button title={p.restoreTitle ?? "Restore"} onClick={p.onRestore} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink">
        <Undo2 size={15} />
      </button>
      <button title="Delete forever" onClick={p.onPurge} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-[var(--c-red-text)]">
        <Trash2 size={15} />
      </button>
    </div>
  );
}
