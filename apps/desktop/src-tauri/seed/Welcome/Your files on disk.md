---
icon: 📁
tags: [guide, files]
---
A workspace is an ordinary folder of Markdown files, and a git repository. Nothing is locked inside MyNote. The first workspace is `~/MyNote`, and **Settings → Workspace** shows where the current one is.

## What's in the folder

```
MyNote/
├── Welcome.md
├── Welcome/
│   ├── Appearance.md
│   ├── Connect your AI agents.md
│   └── …
├── Ideas.md
├── Roadmap.md
├── Roadmap/
│   ├── Design the database views.md
│   └── …
├── .assets/        uploaded icons and imported images
├── .trash/         pages in the Trash, ignored by git
├── .mynote/        workspace settings, such as the AI policy (an older .betelgeuse/ folder is renamed to this automatically)
└── .git/           every version of every page
```

| In MyNote                   | On disk                                                  |
| --------------------------- | -------------------------------------------------------- |
| Page                        | `Title.md`. The file name is the title.                  |
| Sub-page                    | `Parent/Child.md`, nested under `Parent.md`              |
| Icon, tags, cover and style | YAML frontmatter at the top of the file                  |
| Page link                   | `[[Ideas]]`, which also counts as a backlink on Ideas    |
| Database                    | A page with `type: database`, with its rows as sub-pages |
| History                     | Git commits                                              |

## Frontmatter

<details>
<summary>Every key MyNote uses</summary>

| Key         | Example                | Meaning                                      |
| ----------- | ---------------------- | -------------------------------------------- |
| `icon`      | `icon: 📁`             | The page icon: an emoji, an icon or an image |
| `cover`     | `cover: gradient_3`    | A gradient, `color_blue`, or an image link   |
| `tags`      | `tags: [guide, files]` | The page's tags                              |
| `font`      | `font: serif`          | `serif` or `mono` style                      |
| `small`     | `small: true`          | Small text                                   |
| `fullWidth` | `fullWidth: false`     | Full width (`true`) or a narrow column       |
| `ai`        | `ai: false`            | Hide from AI agents, or `true` to share      |
| `order`     | `order: 2`             | Its place among sibling pages in the sidebar |
| `type`      | `type: database`       | Makes the page a database                    |

A database row's frontmatter also holds its property values, such as `Status: Done`. See [[Databases]].

</details>

## Editing with other tools

Obsidian, VS Code, a terminal or plain git can work on the workspace while MyNote is open. MyNote watches the folder and reloads open pages when their files change.

- **Obsidian** reads links, callouts and embeds, because MyNote uses Obsidian's syntax for them.
- Colours, toggles and columns are small HTML tags, so any Markdown viewer still shows their text.
- Opening and saving a page in MyNote doesn't reformat it, so diffs only show what you changed.

See [[Writing and blocks]] for the Markdown behind each block, and [[History and sync]] for git.
