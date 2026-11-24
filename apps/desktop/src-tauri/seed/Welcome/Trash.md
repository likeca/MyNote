---
icon: 🗑️
tags: [guide]
---
Deleting a page moves it, and everything inside it, to the Trash. A message at the bottom of the window offers **Undo**.

## Deleting a page

- Choose **Move to Trash** in the page's `•••` menu, or in the `•••` menu next to it in the sidebar.
- Sub-pages, and the rows of a database, go with it.
- The files attached to it go with it, and come back if you restore it.
- When an agent deletes a page, it goes to the same Trash.

## The Trash

Open **Trash** at the bottom of the sidebar, below Settings.

- Search it by title or by where the page used to be. Files are found by name or folder.
- **Restore** puts a page back where it was. If that name is taken by then, the restored page is renamed.
- Files you deleted from a page are listed under **Files**. **Restore** puts one back in its folder and its link at the end of its page, which opens. If its page is in the Trash too, restore the page first.
- **Delete forever** removes one page or file, and **Empty Trash** removes everything.
- Pages and files are deleted for good after **30 days**.

<details>
<summary>Where trashed pages go</summary>

Trashed pages move to a hidden `.trash/` folder in the workspace, and files deleted from a page to `.trash/.files/`. Git ignores that folder, and trashed pages are left out of search, links and the MCP server.

Even after a page is deleted forever, every earlier version is still in git history. See [[History and sync]].

</details>
