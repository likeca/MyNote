---
icon: 🧱
tags: [guide, editor]
---
Everything on a page is a block: a paragraph, a heading, a list, a table. You can add, convert, colour, move and nest blocks, and every one is saved as readable Markdown.

## Adding blocks

- Type `/` to open the block menu. Keep typing to filter it, for example `/todo` or `/col`. The menu is grouped into Basic blocks, Inline, Database, Media, Layout and Colors.
- Hover a block and click `+` to add a new block below it.
- Or type Markdown at the start of a line:

| Type                             | To get            |
| -------------------------------- | ----------------- |
| `#`, `##` or `###`, then a space | Heading 1, 2 or 3 |
| `-`, then a space                | Bulleted list     |
| `1.`, then a space               | Numbered list     |
| `[]`, then a space               | To-do list        |
| `>`, then a space                | Quote             |
| Three backticks, then a space    | Code block        |
| `---`                            | Divider           |

## Moving and changing blocks

Hover a block to see the `⋮⋮` handle on its left.

- **Drag** the handle to move the block.
- **Click** it to open the block menu: **Turn into**, **Color**, **Duplicate** (`⌘D`) and **Delete**. Type in the menu's search box to find an action.
- `⌘⌥0` to `⌘⌥8` turn the current block into another type. See [[Keyboard shortcuts]].

## Selecting several blocks

To delete, copy or cut several blocks at once (text, files, images, whatever they are), select them whole:

- **Drag from the margin:** press beside the text, in the page's left or right margin or the space below it, and drag across the blocks. A box shows what you're selecting.
- **From the keyboard:** press `Esc` to select the block with the cursor, then `⇧↑` or `⇧↓` to add the blocks above or below it.
- **Shift-click** another block to stretch the selection to it.

Selected blocks are tinted. Press `Backspace` or `Delete` to delete them, or click the `⋮⋮` handle of any of them (or right-click one) for a menu that acts on them all: **Delete**, **Duplicate**, **Color** and **Turn into**. Attached files on deleted lines go to the Trash and come back with `⌘Z`. `⌘C` and `⌘X` copy and cut the blocks. `Esc` again, or a click in the text, goes back to a cursor. On a database's page, its views stay when the text around them is deleted.

## Every block

### Text and headings

Plain text is a paragraph. There are three levels of heading, and headings make up the outline on the right of the page.

### Lists

- Bulleted lists
  - Press Tab to nest an item, and Shift-Tab to move it back out
- Another item

1. Numbered lists
2. Count for you

- [ ] To-do lists
- [x] Click a box to tick it

### Toggle

<details>
<summary>Click the arrow to open this toggle</summary>

Toggles hide content until you need it. Anything can go inside, including lists, tables and code.

Whether a toggle is open or closed is saved with the page.

</details>

<details>
<summary><h3>Toggle headings open and close too</h3></summary>

A toggle heading is a heading with a toggle's arrow: everything under it folds away. Type `/Toggle heading 1`, `2` or `3`, or use **Turn into** on a heading or a toggle. Toggle headings show in the page's outline, like other headings.

</details>

### Quote

> Quotes set words apart from the rest of the page.

### Callout

> [!yellow] 💡
> Callouts make something stand out. Click the icon to change it, and use **Color** in the block menu to change the background. See [[Formatting and colours]].

### Divider

A divider is a line across the page:

---

### Table

`/Table` adds a table with a header row. Tab moves to the next cell, and adds a new row when you're in the last one.

Hover the table to work on it:

- **Rows and columns:** a grip shows beside the row and above the column under the pointer. Drag it to move the row or column, or click it to colour, insert, duplicate, clear or delete it.
- **Adding:** click the `+` under the table for a new row, or beside it for a new column. Drag the `+` to add several at once.
- **Cells:** select some cells, or right-click one, to colour or clear them. A colour is either the text's or the cell's background.
- **The whole table:** its `⋮⋮` handle (or a right-click) turns the **header row** and **header column** on or off, makes it **fit to page width**, colours every cell, or **turns it into a database**. The first column becomes the rows' names and the others text properties.
- **Widths:** drag a column's right border to resize it.

The cells stay a plain Markdown table. Headers, colours and widths are saved in a comment just above it, which other Markdown apps ignore.

| Star    | Constellation | Colour |
| ------- | ------------- | ------ |
| Antares | Scorpius      | Red    |
| Rigel   | Orion         | Blue   |
| Sirius  | Canis Major   | White  |

### Code

```js
// Pick the language from the menu at the top of this block.
// Hover the block for Wrap and Copy. Tab indents.
const greet = (name) => `Hello, ${name}!`;
```

On the desktop app, a **Bash**, **Bash + profile**, **Shell**, **Zsh** or **Python** block can be run: hover it and click **Run** to run the whole block, or put the cursor on a line and press `Ctrl E` (or click **Run line**) to run just that line. It runs in your workspace folder. **Bash** runs on its own, without your startup files. **Bash + profile** first loads `~/.bash_profile` (or `~/.profile`), **Zsh** loads `~/.zprofile` and `~/.zshrc`, aliases included, and **Shell** runs Bash with the `PATH` and exports from your own shell's startup files. **Python** runs `python3` (`python` on Windows) with that same `PATH`, so it's the Python you'd get in Terminal, Homebrew's or pyenv's included; a line run on its own loses its indent, so a line from inside a `for` or `def` still runs. The language menu shows what each one loads. Its output appears under the block until you clear it, and is still there when you come back from another page or tab (a script still running keeps going meanwhile), but it isn't saved in the page and is gone when MyNote quits. **Stop** ends a script that's still running, and so does deleting its block. Only run scripts you trust: they can do anything you can.

### Image

`/Image`, then paste a link to an image and click **Embed image**. Images you paste or drop on the page are copied into its `_assets/` folder (see File, below); images that come in with an import, into the workspace's `_assets/` folder.

To resize an image, hover it and drag the handle on either side; it keeps its proportions. Double-click a handle to go back to the image's own size. The width is saved in the page the way Obsidian writes it, `![description|320](link)` for 320 pixels wide.

### File

`/File` picks files on your computer to attach to the page, or drag files from Finder onto the page (or paste them). Each is copied into an `_assets/` folder in the page's own folder, next to its sub-pages: a page "Launch plan" keeps its files in `Launch plan/_assets/`, under their own names, so they're versioned with your pages. Rename, move or delete the page and its files go with it. A file shows as a chip with its name and size. In the page it's an ordinary link, `[Q3 Report.pdf](Launch%20plan/_assets/Q3%20Report.pdf)` (spaces are written `%20`), so other Markdown apps can open it too.

Click a file to open it. On the desktop app, text and code (JSON, YAML, CSV, scripts, configs and the like) open in a tab of their own, in the same code editor as VS Code, with VS Code's Monokai colours: highlighting for its language, find and replace (`⌘F`), several cursors. What you type saves as you go, and `⌘S` saves straight away. Clicking the file again goes back to its tab. Pictures, sound, video, PDFs, office documents and archives open in their own app instead; so does any file from the tab's buttons, which also show it in Finder. `⌘`-click a file to show it in Finder.

To delete a file, take it off the page: hover it and click the bin, or select it and press Backspace (deleting its line does it too). The file leaves the page's folder, and the folder goes too once it's empty. It waits in the Trash for 30 days, so undoing, or pasting it on another page, brings it back. If another page links to the same file, the file stays for it.

Everything attached goes into git with the page: big files make the repository, and every sync, bigger.

### Equation

Write maths in LaTeX, as in Notion. `/Block equation` (or `$$` and a space on an empty line) adds one on its own line; `/Inline equation`, or `⌘⇧E`, adds one in the text, and turns selected text into one. Typing `$x^2$` makes an inline equation too. Click an equation to edit it: the page shows the result as you type, and `Enter` (`⌘Enter` in a block equation) or a click outside finishes. In the page, a block equation is `$$` lines around the LaTeX and an inline one is `$x^2$`, as in Obsidian and GitHub. Prices like $5 and $10 stay text.

A block equation is centred; to align it left, use the alignment buttons next to **Done** while you edit it. The page keeps that as a `% align: left` line at the top of the LaTeX, a comment other apps skip. For several lines, end each one with `\\`, and put them in `\begin{aligned} … \end{aligned}` with an `&` before the `=` to line them up.

While you edit an equation, the two **A** buttons make the LaTeX you're typing bigger or smaller. MyNote remembers the size for the next equation you edit; it doesn't change the equation in the page.

### Draw.io diagram

`/Draw.io` opens draw.io's editor over the page. Draw, then save and exit, and the diagram appears where you typed the command. To change it later, hover it and click the pencil, or double-click it. Editing needs an internet connection: the editor is draw.io's own, loaded from embed.diagrams.net, and your diagram is handed to it inside MyNote's window.

Each diagram is a `.drawio.svg` file in the page's `_assets/` folder: a picture with the diagram stored inside. The page shows it like any image (you can resize it the same way), other Markdown apps show the picture, and draw.io's desktop app or its VS Code extension can open the file and edit it.

### Columns

<div class="columns">
<div class="column">

`/2 columns`, `/3 columns` and `/4 columns` lay blocks out side by side.

</div>
<div class="column">

Each column holds any blocks you like, such as lists, callouts or code.

</div>
</div>

### Pages, links and databases

- `/Page` creates a sub-page and links to it where you typed. See [[Pages and sub-pages]].
- `/Link to page` links to a page that already exists, the same as typing `[[`. See [[Links and backlinks]].
- `/Database – Inline` creates a database and shows it inside the page. `/Database – Full page` creates it as a sub-page. See [[Databases]].
- `/Date or reminder` inserts today's date.
- Paste a web address on its own and it becomes a mention, as in Notion: the site's icon and the page's title, fetched by the desktop app. A GitHub repository shows as its name with its owner's avatar after it. Click a mention to open the page. Press `⌘Z` straight after pasting to keep the plain link instead, or paste onto selected text to link that text.

## How blocks are stored

Each block has a Markdown form that other editors can read. Open this page's file in a text editor to see them for yourself.

| Block           | Markdown                                                 |
| --------------- | -------------------------------------------------------- |
| Heading         | `## Heading`                                             |
| Bulleted list   | `- item`                                                 |
| Numbered list   | `1. item`                                                |
| To-do           | `- [ ] task` and `- [x] done`                            |
| Quote           | `> text`                                                 |
| Callout         | `> [!yellow] 💡`, then `> text` lines                    |
| Toggle          | `<details><summary>…</summary>…</details>`               |
| Toggle heading  | `<details><summary><h2>…</h2></summary>…</details>`      |
| Columns         | `<div class="columns"><div class="column">…</div></div>` |
| Divider         | `---`                                                    |
| Code            | Three backticks and the language                         |
| Image           | `![description](link)`                                   |
| Resized image   | `![description\|320](link)`                              |
| Draw.io diagram | `![Diagram](Page/_assets/….drawio.svg)`                  |
| File            | `[Report.pdf](Page/_assets/Report.pdf)`                  |
| Block equation  | `$$` lines around the LaTeX                              |
| Inline equation | `$x^2$`                                                  |
| Page link       | `[[Ideas]]`                                              |
| Link mention    | `[Title](https://… "mention")`                           |
| Inline database | `![[Roadmap]]`                                           |
| Colour          | `<span data-color="red">…</span>`                        |

> [!gray] 📁
> Opening and saving a page doesn't reformat it, so your git history only shows real changes. See [[Your files on disk]].
