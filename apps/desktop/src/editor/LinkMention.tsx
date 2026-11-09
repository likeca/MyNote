import { Node } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { open } from "../lib/links";

/**
 * A link mention, as Notion has: a web page shown inline as its site's icon and its title (a GitHub
 * repository as its name, its owner's avatar after it). A bare URL pasted into a page becomes one;
 * ⌘Z straight after gives the plain link back. In Markdown it's a link with the title "mention",
 * `[Page title](https://… "mention")`, which other apps show as an ordinary link.
 */

/** What a page at a URL looks like, fetched once per session (by the desktop app). */
type Preview = { title: string | null; icon: string | null; avatar?: string | null };
const previews = new Map<string, Promise<Preview>>();
export function linkPreview(url: string): Promise<Preview> {
  let p = previews.get(url);
  if (!p) {
    p = api.linkPreview(url).catch(() => ({ title: null, icon: null, avatar: null }));
    previews.set(url, p);
  }
  return p;
}

/** A title for a page whose own isn't known (yet): its address without the scheme. */
export function urlLabel(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

const MENTION = /^\[((?:\\.|[^\]\\\n])*)\]\((?:<([^>\n]+)>|([^)\s]+)) "mention"\)/;
const escapeTitle = (t: string) => t.replace(/[\\[\]]/g, "\\$&");
/** In angle brackets when the address has spaces or brackets in it, as CommonMark allows. */
const destination = (href: string) => (/[\s()<>]/.test(href) ? `<${href}>` : href);

const isUrl = (text: string) => /^https?:\/\/[^\s]+$/.test(text);

export const LinkMention = Node.create({
  name: "linkMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  // Ahead of the Link extension's paste handling.
  priority: 150,

  addAttributes() {
    return {
      href: { default: "" },
      title: { default: "" },
      // While its title and icon are being fetched (never saved).
      loading: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-mention]", getAttrs: (el) => ({ href: el.getAttribute("href") ?? "", title: el.textContent ?? "" }) }];
  },

  renderHTML({ node }) {
    return ["a", { href: node.attrs.href, "data-mention": "" }, node.attrs.title || urlLabel(node.attrs.href)];
  },

  renderText({ node }) {
    return node.attrs.href;
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkMentionView, { as: "span" });
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("linkMentionPaste"),
        props: {
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData("text/plain").trim() ?? "";
            const { selection } = view.state;
            // Onto selected text it links that text; ⇧⌘V pastes it as typed; in code it's code.
            const plain = (view as EditorView & { input?: { shiftKey?: boolean } }).input?.shiftKey;
            if (!isUrl(text) || !selection.empty || plain || selection.$from.parent.type.spec.code) return false;
            pasteMention(view, text);
            return true;
          },
        },
      }),
    ];
  },

  markdownTokenizer: {
    name: "linkMention",
    level: "inline",
    start: (src: string) => src.search(/\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]+>|[^)\s]+) "mention"\)/),
    tokenize(src) {
      const m = MENTION.exec(src);
      return m ? { type: "linkMention", raw: m[0], title: m[1].replace(/\\(.)/g, "$1"), href: m[2] ?? m[3] } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "linkMention", attrs: { href: token.href, title: token.title } }),
  renderMarkdown: (node) => `[${escapeTitle(String(node.attrs?.title || urlLabel(node.attrs?.href ?? "")))}](${destination(node.attrs?.href ?? "")} "mention")`,
});

/**
 * Pastes a URL as Notion does: as a mention straight away, made from the plain link in a step of
 * its own, so ⌘Z gives the link back. Its title and icon arrive when the page has been fetched.
 */
function pasteMention(view: EditorView, href: string) {
  const { schema } = view.state;
  const from = view.state.selection.from;
  const link = schema.marks.link?.create({ href });
  view.dispatch(view.state.tr.replaceSelectionWith(schema.text(href, link ? [link] : []), false).scrollIntoView());
  const mention = schema.nodes.linkMention.create({ href, title: urlLabel(href), loading: true });
  view.dispatch(closeHistory(view.state.tr).replaceWith(from, from + href.length, mention).scrollIntoView());
  void linkPreview(href).then(({ title }) => {
    if (view.isDestroyed) return;
    const tr = view.state.tr;
    view.state.doc.descendants((node, pos) => {
      if (node.type === mention.type && node.attrs.href === href && node.attrs.loading) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: title || node.attrs.title, loading: false });
      }
    });
    // The title arriving isn't a step to undo.
    if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
  });
}

function LinkMentionView({ node }: NodeViewProps) {
  const href = node.attrs.href as string;
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let live = true;
    void linkPreview(href).then((p) => live && setPreview(p));
    return () => void (live = false);
  }, [href]);
  return (
    <NodeViewWrapper as="span" className={`wikilink link-mention${node.attrs.loading ? " loading" : ""}`} data-mention="" title={href} onClick={() => open(href)}>
      <span className="wikilink-icon" contentEditable={false}>
        {preview?.icon ? <img src={preview.icon} alt="" className="size-[1em] rounded-[3px] object-contain" draggable={false} /> : <Globe size={15} />}
      </span>
      <span className="wikilink-title">{node.attrs.title || urlLabel(href)}</span>
      {/* Whose it is, after the title (a GitHub repository's owner), as Notion shows it. */}
      {preview?.avatar && <img src={preview.avatar} alt="" contentEditable={false} className="link-mention-avatar" draggable={false} />}
    </NodeViewWrapper>
  );
}
