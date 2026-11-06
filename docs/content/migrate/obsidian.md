---
title: Move from Obsidian
description: Open your Obsidian vault in MyNote as it is, or import a copy of it, and see what carries over.
---
Obsidian and MyNote both keep notes as Markdown files in a folder, and MyNote uses Obsidian's syntax for links, embeds and callouts. So there's very little to move. There are two ways in.

| | Open your vault | Import a copy |
|---|---|---|
| Your files | Stay where they are. MyNote and Obsidian both work on the same folder. | Copied into your MyNote workspace, under one new page. Your vault isn't touched. |
| Good for | Switching over, or using both apps side by side | Adding your vault to a workspace you already have |
| Callouts | Kept in Obsidian's style | Changed to MyNote's colours and icons |
| Attachments | Stay where they are | Copied into `.assets/` |

## Open your vault

1. In MyNote, open **Settings → Workspace** and click **Open another…**.
2. Choose your vault's folder.

That's it. If the vault isn't a git repository yet, MyNote makes it one and saves its current state as the first commit, so every change from now on has history. It also tells git to ignore Obsidian's window layout files (`.obsidian/workspace*.json`), which change every time you click around.

Your pages, folders, links, embeds, tags and frontmatter work as they are. Keep Obsidian open on the same folder if you like: each app picks up the other's changes as they happen.

> [!blue] 💡
> Already sync your vault with the Obsidian Git plugin, or another git setup? MyNote uses the same repository. Add its address in **Settings → Git & sync** and it pulls and pushes in the background. See [History and sync](/docs/guide/history-and-sync/).

## Import a copy

1. Click **Import** at the bottom of the sidebar, or open **Settings → Import**.
2. Under **Obsidian**, click **Choose vault folder…** and choose your vault.

Everything goes under a new page named after your vault, as one git commit you can undo.

- Pages and folders keep their structure, and `[[links]]` keep working.
- Attachments (images, PDFs and other files) are copied into the workspace's `.assets/` folder, and image embeds (`![[photo.png]]`) point to the copies.
- Embedded notes (`![[Note]]`) show as cards that open the note.
- Callouts become MyNote callouts with matching colours and icons: a `[!warning]` turns yellow with ⚠️, a `[!tip]` green with 💡.
- Hidden folders such as `.obsidian` and `.trash` are skipped.

## What carries over, and what doesn't

| In Obsidian | In MyNote |
|---|---|
| Notes and folders | Pages and sub-pages |
| `[[Links]]`, `[[Note\|alias]]`, `[[Note#Heading]]` | Links, with backlinks |
| Frontmatter (`tags`, `aliases` and your own fields) | Kept in the file. `tags` show as the page's tags. |
| Callouts | Callouts |
| Images and attachments | Images and files |
| Daily notes | Ordinary pages: there's no daily-note button |
| Canvas (`.canvas`) | Kept as a file, but MyNote can't show canvases |
| Dataview and other plugin queries | Shown as code blocks. A MyNote [database](/docs/guide/databases/) can often do the same job. |
| Community plugins and themes | Not carried over. MyNote has [its own plugins](/docs/plugins/). |

## After moving

- **Gather similar notes into a database.** Create one with `/Database – Full page` and move notes of one kind (books, projects, meetings) into it: each becomes a row, and its frontmatter fields become the row's values, with table, board and calendar views. See [Databases](/docs/guide/databases/).
- **Use it on your phone.** Connect a git repository, then set up sync in the MyNote phone app. See [History and sync](/docs/guide/history-and-sync/#on-your-phone).
- **Connect your AI agents.** They can search and update your notes, and only the pages you share. See [Connect your AI agents](/docs/guide/connect-your-ai-agents/).

Something didn't come across as you expected? [Open an issue](https://github.com/likeca/MyNote/issues).
