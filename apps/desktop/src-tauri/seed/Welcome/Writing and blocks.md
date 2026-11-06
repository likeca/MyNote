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

On the desktop app, a **Bash**, **Bash + profile**, **Shell** or **Zsh** block can be run: hover it and click **Run** to run the whole block, or put the cursor on a line and press `Ctrl E` (or click **Run line**) to run just that line. It runs in your workspace folder. **Bash** runs on its own, without your startup files. **Bash + profile** first loads `~/.bash_profile` (or `~/.profile`), **Zsh** loads `~/.zprofile` and `~/.zshrc`, aliases included, and **Shell** runs Bash with the `PATH` and exports from your own shell's startup files. The language menu shows what each one loads. Its output appears under the block until you clear it, and isn't saved in the page. **Stop** ends a script that's still running, and so does closing the page. Only run scripts you trust: they can do anything you can.

### Image

`/Image`, then paste a link to an image and click **Embed image**. Images that come in with an import are copied into the workspace's `.assets/` folder.

To resize an image, hover it and drag the handle on either side; it keeps its proportions. Double-click a handle to go back to the image's own size. The width is saved in the page the way Obsidian writes it, `![description|320](link)` for 320 pixels wide.

### File

`/File` picks files on your computer to attach to the page, or drag files from Finder onto the page (or paste them). Each is copied into the workspace's `.assets/` folder, so it's versioned with your pages, and shows as a chip with its name and size. Click a file to open it in its app, or `⌘`-click it to show it in Finder. In the page it's an ordinary link, `[Report.pdf](.assets/Report-….pdf)`, so other Markdown apps can open it too.

Everything attached goes into git with the page: big files make the repository, and every sync, bigger.

### Draw.io diagram

`/Draw.io` opens draw.io's editor over the page. Draw, then save and exit, and the diagram appears where you typed the command. To change it later, hover it and click the pencil, or double-click it. Editing needs an internet connection: the editor is draw.io's own, loaded from embed.diagrams.net, and your diagram is handed to it inside MyNote's window.

Each diagram is a `.drawio.svg` file in `.assets/`: a picture with the diagram stored inside. The page shows it like any image (you can resize it the same way), other Markdown apps show the picture, and draw.io's desktop app or its VS Code extension can open the file and edit it.

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
| Draw.io diagram | `![Diagram](.assets/….drawio.svg)`                       |
| File            | `[Report.pdf](.assets/Report-….pdf)`                     |
| Page link       | `[[Ideas]]`                                              |
| Inline database | `![[Roadmap]]`                                           |
| Colour          | `<span data-color="red">…</span>`                        |

> [!gray] 📁
> Opening and saving a page doesn't reformat it, so your git history only shows real changes. See [[Your files on disk]].
