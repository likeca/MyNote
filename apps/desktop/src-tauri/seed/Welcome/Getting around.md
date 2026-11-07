---
icon: 🧭
tags: [guide, basics]
---
MyNote has two parts: the sidebar on the left and the open page on the right.

## The sidebar

- **Search** finds pages by title and content. Press `⌘K` to open it from anywhere.
- **Favorites** lists the pages you've starred. It only appears once you have some.
- **The page tree** shows every page, with sub-pages nested under their parent. Click the arrow next to a page to expand it.
  - Hover a page and click `+` to add a page inside it.
  - Click `•••` to add it to Favorites, hide it from AI agents, duplicate it, add a page inside or move it to the Trash.
  - Drag a page up or down to change its place among the pages next to it. A line shows where it will land; press `Esc` to cancel.
- **Add new**, or the pen icon at the top, creates a page. So does `⌘N`.
- **Connect agents** sets up AI agents. See [[Connect your AI agents]].
- **Import**, items added by plugins (such as **Library** from Media Library), **Settings** and **Trash** are at the bottom. See [[Import]], [[Plugins]] and [[Trash]].
- The footer shows the workspace name and the git button: **Upload** (a cloud) once you've added a remote, or commit before that. See [[History and sync]].

Drag the sidebar's right edge to resize it. `⌘\` hides it. While it's hidden, hover the left edge of the window to peek at it, then click the button at the top to keep it open.

## Search

`⌘K` (or `⌘P`) opens search. With nothing typed, it lists recent pages. Type to search page titles, tags and contents, with a snippet from each match. Use the arrow keys and Enter to open a result. The last result, **New page**, creates a page with the title you typed.

## On a page

- The breadcrumbs at the top show where the page sits. Click a parent page to open it.
- The arrows next to them go back and forward through the pages you've opened, like a browser (`⌘[` and `⌘]`).
- The top bar shows "Saving…" while you type, then when the page was last edited.
- The clock opens the page's history, the star adds it to Favorites, and `•••` opens the page menu. See [[Pages and sub-pages]].
- On a page with two or more headings, an outline appears on the right. Hover it to see the headings, and click one to jump to it.
- At the bottom, **backlinks** list every page that links to this one. See [[Links and backlinks]].

## Tabs and terminals

Each page opens in a tab at the top of the window. Click `+` there for **New tab**, which shows the same page again (`⌘T`), or **New terminal** (`Ctrl` + backtick). Right-click a tab to close it, the others or the ones to its right; a middle-click closes it too.

A terminal tab runs your own shell, as Terminal does, starting in the workspace folder, so you can use git, run scripts or start an agent next to your pages. It keeps running while you look at other tabs, and closing the tab ends it. Pages you open from a terminal tab open in a new tab beside it. In a terminal, `Ctrl` keys go to the shell (`Ctrl C`, `Ctrl R`…), and `⌘+` and `⌘−` zoom its text with the pages'. When the shell exits, press Enter to start a new one. Terminals aren't reopened the next time you start MyNote.

## Workspaces

A workspace is a folder. Click the workspace name at the bottom of the sidebar to switch: the menu lists the workspaces you've opened, newest first, with a tick on the open one. Click one to open it, or **Open another folder…** to pick a different folder. If you pick an empty one, MyNote sets it up with these guide pages and starts a git repository in it. Hover a workspace in the list and click `×` to take it off the list; the folder itself isn't touched. **Settings → Workspace** shows where the current workspace is.

> [!blue] 🗂️
> Next: [[Pages and sub-pages]] covers icons, covers, tags and the page menu.
