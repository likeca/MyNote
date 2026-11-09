//! The vault is a plain folder of Markdown files. A note `A/B.md` is the
//! sub-page of `A.md`, so a nested page tree maps 1:1 onto folders that
//! Obsidian, git and any agent can read without MyNote running.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    /// Frontmatter `type`, e.g. "database".
    pub kind: Option<String>,
    /// Frontmatter `ai`: `false` hides the page (and its sub-pages) from agents, `true` shares it.
    pub ai: Option<bool>,
    /// Frontmatter `order`: position among sibling pages (ascending; pages without one follow A–Z).
    pub order: Option<f64>,
    pub modified: u64,
    pub created: u64,
}

/// A database row: a direct sub-page of a database page, with its raw content.
#[derive(Serialize)]
pub struct Row {
    pub path: String,
    pub title: String,
    pub content: String,
    pub modified: u64,
    pub created: u64,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub icon: Option<String>,
    pub snippet: String,
    pub score: u32,
}

/// Resolves a vault-relative path, refusing anything that escapes the vault.
pub fn resolve(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    let safe = !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe {
        return Err(format!("invalid note path: {rel}"));
    }
    Ok(vault.join(p))
}

pub fn rel_string(vault: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault)
        .unwrap_or(abs)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn markdown_files(vault: &Path) -> impl Iterator<Item = PathBuf> {
    WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0 || {
                let name = e.file_name().to_string_lossy();
                // Attachment folders aren't page folders: Markdown files attached there aren't pages.
                !name.starts_with('.') && name != "node_modules" && !name.eq_ignore_ascii_case(ASSETS)
            }
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md"))
        .map(|e| e.into_path())
}

/// A page's file name without `.md`: its id among its sibling pages (and what `[[links]]` name).
pub fn title_of(rel: &str) -> String {
    let file = rel.rsplit('/').next().unwrap_or(rel);
    file.strip_suffix(".md").unwrap_or(file).to_string()
}

/// A page's name: its `title` frontmatter when it has one, else its file name. Pages in the same
/// place may share a name ("Salary" every month): their files are numbered ("Salary 2.md") and the
/// name is kept in `title`.
pub fn page_title(rel: &str, fm: &str) -> String {
    fm_string(fm, "title").filter(|t| !t.trim().is_empty()).unwrap_or_else(|| title_of(rel))
}

/// A top-level string value, reading the double-quoted (JSON-escaped) form `set_fm_string` writes.
fn fm_string(fm: &str, key: &str) -> Option<String> {
    fm.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if l.starts_with([' ', '\t']) || k.trim() != key {
            return None;
        }
        let v = v.trim();
        (!v.is_empty()).then(|| serde_json::from_str::<String>(v).unwrap_or_else(|_| unquote(v)))
    })
}

/// `content` with top-level frontmatter `key` set to the string `value`, or removed (`None`). An
/// emptied frontmatter block goes too.
pub fn set_fm_string(content: &str, key: &str, value: Option<&str>) -> String {
    let (fm, body) = split_frontmatter(content);
    let mut lines: Vec<String> = fm
        .lines()
        .filter(|l| l.starts_with([' ', '\t']) || l.split_once(':').is_none_or(|(k, _)| k.trim() != key))
        .map(str::to_string)
        .collect();
    if let Some(v) = value {
        lines.insert(0, format!("{key}: {}", serde_json::to_string(v).unwrap_or_default()));
    }
    if lines.iter().all(|l| l.trim().is_empty()) {
        return body.to_string();
    }
    format!("---\n{}\n---\n{body}", lines.join("\n"))
}

/// Keeps the page at `rel` named `name`: `title` frontmatter when its file name says otherwise.
fn keep_name(vault: &Path, rel: &str, name: &str) -> Result<(), String> {
    let content = read_note(vault, rel)?;
    let want = (title_of(rel) != name).then_some(name);
    let current = fm_string(split_frontmatter(&content).0, "title");
    if current.as_deref() != want {
        write_note(vault, rel, &set_fm_string(&content, "title", want))?;
    }
    Ok(())
}

/// Splits `---\n...\n---` frontmatter from the body. Returns ("", content) when absent.
pub fn split_frontmatter(content: &str) -> (&str, &str) {
    let Some(rest) = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n")) else {
        return ("", content);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let fm = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (fm, body);
        }
        offset += line.len();
    }
    ("", content)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    v.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(v)
        .to_string()
}

/// Minimal YAML reader for the scalar and list keys MyNote cares about.
pub fn fm_value(fm: &str, key: &str) -> Option<String> {
    fm.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key && !v.trim().is_empty()).then(|| unquote(v))
    })
}

pub fn fm_bool(fm: &str, key: &str) -> Option<bool> {
    match fm_value(fm, key)?.to_ascii_lowercase().as_str() {
        "true" | "yes" => Some(true),
        "false" | "no" => Some(false),
        _ => None,
    }
}

/// A finite number, e.g. `order: 2.5`; anything else reads as `None`.
pub fn fm_number(fm: &str, key: &str) -> Option<f64> {
    fm_value(fm, key)?.parse::<f64>().ok().filter(|n| n.is_finite())
}

pub fn fm_list(fm: &str, key: &str) -> Vec<String> {
    let mut lines = fm.lines();
    while let Some(l) = lines.next() {
        let Some((k, v)) = l.split_once(':') else { continue };
        if k.trim() != key {
            continue;
        }
        let v = v.trim();
        if let Some(inner) = v.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            return inner.split(',').map(unquote).filter(|s| !s.is_empty()).collect();
        }
        if !v.is_empty() {
            return vec![unquote(v)];
        }
        return lines
            .map_while(|l| l.trim_start().strip_prefix("- ").map(unquote))
            .collect();
    }
    Vec::new()
}

fn meta_for(vault: &Path, abs: &Path) -> NoteMeta {
    let rel = rel_string(vault, abs);
    let content = fs::read_to_string(abs).unwrap_or_default();
    let (fm, _) = split_frontmatter(&content);
    let (modified, created) = times(abs);
    NoteMeta {
        title: page_title(&rel, fm),
        icon: fm_value(fm, "icon"),
        tags: fm_list(fm, "tags"),
        kind: fm_value(fm, "type"),
        ai: fm_bool(fm, "ai"),
        order: fm_number(fm, "order"),
        path: rel,
        modified,
        created,
    }
}

/// (modified, created) in unix millis; created falls back to modified where unsupported.
fn times(abs: &Path) -> (u64, u64) {
    let millis = |t: std::io::Result<std::time::SystemTime>| {
        t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
    };
    let Ok(meta) = fs::metadata(abs) else { return (0, 0) };
    let modified = millis(meta.modified()).unwrap_or(0);
    (modified, millis(meta.created()).unwrap_or(modified))
}

/// Rows of the database page `rel`: the `.md` files directly inside its sub-page folder.
pub fn database_rows(vault: &Path, rel: &str) -> Result<Vec<Row>, String> {
    let dir = resolve(vault, children_dir(rel))?;
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut rows: Vec<Row> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .filter(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .map(|p| {
            let path = rel_string(vault, &p);
            let (modified, created) = times(&p);
            let content = fs::read_to_string(&p).unwrap_or_default();
            Row { title: page_title(&path, split_frontmatter(&content).0), content, path, modified, created }
        })
        .collect();
    // Rows with an `order` (e.g. imported in Notion's order) come first by it; the rest follow
    // in the order they were created.
    let mut keyed: Vec<(Option<f64>, Row)> = rows.into_iter().map(|r| (fm_number(split_frontmatter(&r.content).0, "order"), r)).collect();
    keyed.sort_by(|(oa, a), (ob, b)| {
        let by_order = match (oa, ob) {
            (Some(x), Some(y)) => x.total_cmp(y),
            (x, y) => y.is_some().cmp(&x.is_some()),
        };
        by_order.then_with(|| (a.created, a.title.to_lowercase()).cmp(&(b.created, b.title.to_lowercase())))
    });
    rows = keyed.into_iter().map(|(_, r)| r).collect();
    Ok(rows)
}

/// Copies a note next to itself as "Name copy". Sub-pages are not copied.
pub fn duplicate_note(vault: &Path, rel: &str) -> Result<String, String> {
    let dir = rel.rsplit_once('/').map_or("", |(d, _)| d);
    let name = format!("{} copy", page_title(rel, split_frontmatter(&read_note(vault, rel)?).0));
    let copy = unique_path(vault, dir, &sanitize_title(&name), None);
    fs::copy(resolve(vault, rel)?, resolve(vault, &copy)?).map_err(|e| e.to_string())?;
    keep_name(vault, &copy, &name)?;
    Ok(copy)
}

pub fn list_notes(vault: &Path) -> Vec<NoteMeta> {
    let mut notes: Vec<_> = markdown_files(vault).map(|p| meta_for(vault, &p)).collect();
    notes.sort_by_cached_key(|n| n.path.to_lowercase());
    notes
}

pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    fs::read_to_string(resolve(vault, rel)?).map_err(|e| e.to_string())
}

pub fn write_note(vault: &Path, rel: &str, content: &str) -> Result<(), String> {
    let abs = resolve(vault, rel)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(abs, content).map_err(|e| e.to_string())
}

pub fn sanitize_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if "/\\:*?\"<>|#^[]".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() || cleaned.starts_with('.') {
        "Untitled".into()
    } else {
        cleaned
    }
}

/// Directory that holds the sub-pages of `parent` (`A/B.md` -> `A/B`).
pub fn children_dir(parent: &str) -> &str {
    parent.strip_suffix(".md").unwrap_or(parent)
}

pub fn unique_path(vault: &Path, dir: &str, title: &str, except: Option<&str>) -> String {
    let join = |name: &str| if dir.is_empty() { format!("{name}.md") } else { format!("{dir}/{name}.md") };
    // A page named like the attachments folder would keep its sub-pages in its parent's attachments.
    let taken = |c: &str| (vault.join(c).exists() && Some(c) != except) || c.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(&format!("{ASSETS}.md")));
    let mut candidate = join(title);
    let mut n = 2;
    while taken(&candidate) {
        candidate = join(&format!("{title} {n}"));
        n += 1;
    }
    candidate
}

/// The name a page is given: trimmed, and "Untitled" when there's nothing left.
fn name_from(title: &str) -> String {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() { "Untitled".into() } else { t }
}

/// Creates an empty page named `title`. Its name needn't be free: the file is numbered instead
/// ("Salary 2.md") and keeps the name in its frontmatter.
pub fn create_note(vault: &Path, parent: Option<&str>, title: &str) -> Result<String, String> {
    let dir = parent.map(children_dir).unwrap_or("");
    let name = name_from(title);
    let rel = unique_path(vault, dir, &sanitize_title(&name), None);
    write_note(vault, &rel, "")?;
    keep_name(vault, &rel, &name)?;
    Ok(rel)
}

/// Renames a note: its file (and sub-page folder) takes the new name where that's free, links
/// to it follow, and the name goes in its frontmatter where the file had to be numbered.
pub fn rename_note(vault: &Path, rel: &str, new_title: &str) -> Result<String, String> {
    let name = name_from(new_title);
    let current = page_title(rel, split_frontmatter(&read_note(vault, rel)?).0);
    if name == current {
        return Ok(rel.to_string());
    }
    let old_title = title_of(rel);
    let dir = rel.rsplit_once('/').map_or("", |(d, _)| d);
    let stem = sanitize_title(&name);
    let new_rel = if stem == old_title { rel.to_string() } else { unique_path(vault, dir, &stem, Some(rel)) };
    if new_rel == rel {
        keep_name(vault, rel, &name)?;
        return Ok(new_rel);
    }
    let final_title = title_of(&new_rel);
    fs::rename(resolve(vault, rel)?, resolve(vault, &new_rel)?).map_err(|e| e.to_string())?;
    let old_children = vault.join(children_dir(rel));
    if old_children.is_dir() {
        fs::rename(old_children, vault.join(children_dir(&new_rel))).map_err(|e| e.to_string())?;
    }
    for file in markdown_files(vault) {
        let Ok(text) = fs::read_to_string(&file) else { continue };
        // Path links (`[[Areas/Old]]`, as relations name their database) follow too.
        let mut updated = rewrite_link_paths(&text, children_dir(rel), children_dir(&new_rel));
        updated = rewrite_links(&updated, &old_title, &final_title);
        updated = rewrite_attachment_links(&updated, rel, &new_rel);
        if updated != text {
            let _ = fs::write(&file, updated);
        }
    }
    keep_name(vault, &new_rel, &name)?;
    Ok(new_rel)
}

/// Moves a page (and its sub-pages) into the folder `dest_dir`: another page's sub-page folder, or
/// "" for the top level. Links that name the page or a sub-page by path follow it. Returns the new path.
pub fn move_note(vault: &Path, rel: &str, dest_dir: &str) -> Result<String, String> {
    let dest_dir = dest_dir.trim_matches('/');
    let own = children_dir(rel);
    let inside = |d: &str| d.eq_ignore_ascii_case(own) || d.to_lowercase().starts_with(&format!("{}/", own.to_lowercase()));
    if inside(dest_dir) {
        return Err("A page can't be moved inside itself.".into());
    }
    let dir = rel.rsplit_once('/').map_or("", |(d, _)| d);
    if dir == dest_dir {
        return Ok(rel.to_string());
    }
    if !dest_dir.is_empty() {
        resolve(vault, dest_dir)?;
    }
    let title = title_of(rel);
    let name = page_title(rel, split_frontmatter(&read_note(vault, rel)?).0);
    let new_rel = unique_path(vault, dest_dir, &title, None);
    let to = resolve(vault, &new_rel)?;
    fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::rename(resolve(vault, rel)?, &to).map_err(|e| e.to_string())?;
    let old_children = vault.join(own);
    if old_children.is_dir() {
        fs::rename(old_children, vault.join(children_dir(&new_rel))).map_err(|e| e.to_string())?;
    }
    // A folder left empty (the page was its only content) goes too.
    if !dir.is_empty() {
        let _ = fs::remove_dir(vault.join(dir));
    }
    let new_title = title_of(&new_rel);
    for file in markdown_files(vault) {
        let Ok(text) = fs::read_to_string(&file) else { continue };
        let mut updated = rewrite_link_paths(&text, own, children_dir(&new_rel));
        // Numbered to avoid a page of the same name there ("Plan 2"): title links follow, as on rename.
        if new_title != title {
            updated = rewrite_links(&updated, &title, &new_title);
        }
        updated = rewrite_attachment_links(&updated, rel, &new_rel);
        if updated != text {
            let _ = fs::write(&file, updated);
        }
    }
    // Numbered to fit in ("Plan 2.md"), it's still called what it was.
    keep_name(vault, &new_rel, &name)?;
    Ok(new_rel)
}

// ---------- Trash ----------
//
// Deleting moves a page (and its sub-pages) to `.trash/<id>/`, next to a `meta.json` recording
// where it came from. `.trash/` is git-ignored; git history still has every version.

pub const TRASH: &str = ".trash";
const TRASH_DAYS: u64 = 30;
/// In a trash item, the folder holding the trashed page's attached files.
const TRASHED_ATTACHMENTS: &str = ".assets";
/// In the Trash, attached files whose last link went: `.trash/.files/<millis>/<their path>`, kept
/// 30 days so undoing, or pasting the link elsewhere, brings them back. (Trash item ids are
/// alphanumeric, so this name can't clash with one.)
const RELEASED_FILES: &str = ".files";

#[derive(Serialize)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    /// Where the page lived, e.g. "Projects/Plan.md".
    pub original: String,
    /// Unix millis.
    pub deleted: u64,
    /// The page plus its sub-pages.
    pub pages: usize,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Moves a page and its sub-pages to the trash. Returns the trash item's id.
pub fn delete_note(vault: &Path, rel: &str) -> Result<String, String> {
    let src = resolve(vault, rel)?;
    if !src.is_file() {
        return Err(format!("no such page: {rel}"));
    }
    let mut id = now_millis().to_string();
    while vault.join(TRASH).join(&id).exists() {
        id.push('x');
    }
    let dir = vault.join(TRASH).join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = rel.rsplit('/').next().unwrap_or(rel);
    fs::rename(&src, dir.join(file)).map_err(|e| e.to_string())?;
    let children = vault.join(children_dir(rel));
    if children.is_dir() {
        fs::rename(&children, dir.join(children_dir(file))).map_err(|e| e.to_string())?;
    }
    // Its attached files are in its folder (its sub-pages' in theirs), so they went along.
    let meta = serde_json::json!({ "original": rel, "deleted": now_millis() });
    fs::write(dir.join("meta.json"), meta.to_string()).map_err(|e| e.to_string())?;
    Ok(id)
}

fn trash_meta(dir: &Path) -> Option<(String, u64)> {
    let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
    Some((meta.get("original")?.as_str()?.to_string(), meta.get("deleted")?.as_u64()?))
}

/// Lists trashed pages, newest first, permanently removing ones older than 30 days.
pub fn list_trash(vault: &Path) -> Vec<TrashItem> {
    let Ok(entries) = fs::read_dir(vault.join(TRASH)) else { return Vec::new() };
    let cutoff = now_millis().saturating_sub(TRASH_DAYS * 24 * 3600 * 1000);
    // Released attached files expire the same way.
    for stamp in fs::read_dir(vault.join(TRASH).join(RELEASED_FILES)).into_iter().flatten().filter_map(Result::ok) {
        if stamp.file_name().to_str().and_then(|s| s.parse::<u64>().ok()).is_some_and(|t| t < cutoff) {
            let _ = fs::remove_dir_all(stamp.path());
        }
    }
    let mut items: Vec<TrashItem> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let dir = e.path();
            let (original, deleted) = trash_meta(&dir)?;
            if deleted < cutoff {
                let _ = fs::remove_dir_all(&dir);
                return None;
            }
            let file = original.rsplit('/').next().unwrap_or(&original).to_string();
            let content = fs::read_to_string(dir.join(&file)).unwrap_or_default();
            // Pages, not the attached files that went to the Trash with them.
            let pages = WalkDir::new(&dir)
                .into_iter()
                .filter_entry(|f| f.file_name() != TRASHED_ATTACHMENTS && !f.file_name().to_string_lossy().eq_ignore_ascii_case(ASSETS))
                .filter_map(Result::ok)
                .filter(|f| f.path().extension().is_some_and(|x| x == "md"))
                .count();
            Some(TrashItem {
                id: e.file_name().to_string_lossy().into_owned(),
                title: page_title(&original, split_frontmatter(&content).0),
                icon: fm_value(split_frontmatter(&content).0, "icon"),
                original,
                deleted,
                pages,
            })
        })
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.deleted));
    items
}

fn trash_dir(vault: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid trash id".into());
    }
    Ok(vault.join(TRASH).join(id))
}

/// Puts a trashed page back where it was (renamed if that name is now taken). Returns its path.
pub fn restore_trash(vault: &Path, id: &str) -> Result<String, String> {
    let dir = trash_dir(vault, id)?;
    let (original, _) = trash_meta(&dir).ok_or("this item is no longer in the trash")?;
    let file = original.rsplit('/').next().unwrap_or(&original).to_string();
    let parent = original.rsplit_once('/').map_or("", |(d, _)| d);
    let dest = unique_path(vault, parent, &title_of(&original), None);
    let abs = resolve(vault, &dest)?;
    let name = page_title(&original, split_frontmatter(&fs::read_to_string(dir.join(&file)).unwrap_or_default()).0);
    fs::create_dir_all(abs.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::rename(dir.join(&file), &abs).map_err(|e| e.to_string())?;
    keep_name(vault, &dest, &name)?;
    let children = dir.join(children_dir(&file));
    if children.is_dir() {
        fs::rename(children, vault.join(children_dir(&dest))).map_err(|e| e.to_string())?;
    }
    // From before attachments lived in page folders: the page's files went to the Trash on their
    // own. They come back into its folder, and its links to them follow.
    let attachments = dir.join(TRASHED_ATTACHMENTS);
    if attachments.is_dir() {
        let to = vault.join(attachments_dir(&dest));
        fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
        merge_dir(&attachments, &to)?;
        for file in markdown_files(vault) {
            let Ok(text) = fs::read_to_string(&file) else { continue };
            let old = format!("{ASSETS}/{}", children_dir(&original));
            let updated = renamed_paths(&renamed_paths(&text, &link_path(&old), &link_path(&attachments_dir(&dest))), &old, &attachments_dir(&dest));
            if updated != text {
                let _ = fs::write(&file, updated);
            }
        }
    } else if dest != original {
        // Back under another name ("Plan 2"): links to its files follow its folder.
        for file in markdown_files(vault) {
            let Ok(text) = fs::read_to_string(&file) else { continue };
            let updated = rewrite_attachment_links(&text, &original, &dest);
            if updated != text {
                let _ = fs::write(&file, updated);
            }
        }
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Permanently deletes one trashed item, or everything when `id` is `None`.
pub fn purge_trash(vault: &Path, id: Option<&str>) -> Result<(), String> {
    match id {
        Some(id) => fs::remove_dir_all(trash_dir(vault, id)?).map_err(|e| e.to_string()),
        None => match fs::remove_dir_all(vault.join(TRASH)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

/// Yields the target of every `[[target|alias]]` / `[[target#heading]]` link.
pub fn wikilinks(text: &str) -> impl Iterator<Item = &str> {
    text.split("[[").skip(1).filter_map(|chunk| {
        let inner = chunk.split_once("]]")?.0;
        let target = inner.split(['|', '#']).next()?.trim();
        (!target.is_empty() && !target.contains('\n')).then_some(target)
    })
}

/// Rewrites the target of every `[[target]]`, `[[target|alias]]` and `[[target#heading]]` that
/// `f` maps to a new one; aliases, headings and everything else stay as they are.
fn rewrite_targets(text: &str, f: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("[[") {
        out.push_str(&rest[..i + 2]);
        rest = &rest[i + 2..];
        let end = rest.find([']', '|', '#', '\n', '[']).unwrap_or(rest.len());
        let closed = rest[end..].starts_with("]]") || rest[end..].starts_with('|') || rest[end..].starts_with('#');
        if let Some(new) = closed.then(|| f(&rest[..end])).flatten() {
            out.push_str(&new);
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

/// Case-insensitive, as links resolve (`[[ideas]]` opens `Ideas`).
fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Rewrites links that name a page by title.
fn rewrite_links(text: &str, old: &str, new: &str) -> String {
    rewrite_targets(text, |t| same(t.trim(), old).then(|| new.to_string()))
}

/// Rewrites links that name a page by path, `[[A/B]]`, or a page under it, `[[A/B/C]]`.
fn rewrite_link_paths(text: &str, old: &str, new: &str) -> String {
    rewrite_targets(text, |t| {
        let t = t.trim();
        if same(t, old) {
            return Some(new.to_string());
        }
        let head = t.get(..old.len())?;
        (same(head, old) && t[old.len()..].starts_with('/')).then(|| format!("{new}{}", &t[old.len()..]))
    })
}

/// Whether a link target (`[[Title]]` or `[[Path/To/Page]]`) names the page at `rel`.
pub fn link_matches(target: &str, rel: &str) -> bool {
    let target = target.strip_suffix(".md").unwrap_or(target);
    target.eq_ignore_ascii_case(&title_of(rel)) || target.eq_ignore_ascii_case(children_dir(rel))
}

pub fn backlinks(vault: &Path, rel: &str) -> Vec<NoteMeta> {
    markdown_files(vault)
        .filter(|p| rel_string(vault, p) != rel)
        .filter(|p| {
            fs::read_to_string(p).is_ok_and(|t| wikilinks(&t).any(|target| link_matches(target, rel)))
        })
        .map(|p| meta_for(vault, &p))
        .collect()
}

fn snippet_around(text: &str, byte_idx: usize, len: usize) -> String {
    let start = text[..byte_idx].char_indices().rev().nth(60).map_or(0, |(i, _)| i);
    let end = text[byte_idx + len..]
        .char_indices()
        .nth(100)
        .map_or(text.len(), |(i, _)| byte_idx + len + i);
    let mut s = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

pub fn search(vault: &Path, query: &str) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<SearchHit> = markdown_files(vault)
        .filter_map(|p| {
            let meta = meta_for(vault, &p);
            let content = fs::read_to_string(&p).ok()?;
            let (_, body) = split_frontmatter(&content);
            // Lowercasing can change byte lengths for some scripts; only use the
            // index for a snippet when it is still a valid boundary.
            let lower = body.to_lowercase();
            let body_hits = lower.matches(&q).count() as u32;
            let title_hit = meta.title.to_lowercase().contains(&q);
            let tag_hit = meta.tags.iter().any(|t| t.to_lowercase() == q.trim_start_matches('#'));
            let score = body_hits + if title_hit { 100 } else { 0 } + if tag_hit { 50 } else { 0 };
            if score == 0 {
                return None;
            }
            let snippet = match lower.find(&q) {
                Some(i) if lower.len() == body.len() && body.is_char_boundary(i) => snippet_around(body, i, q.len()),
                _ => body.trim().chars().take(140).collect(),
            };
            Some(SearchHit { path: meta.path, title: meta.title, icon: meta.icon, snippet, score })
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    hits.truncate(50);
    hits
}

/// A new, unused path in the attachments folder `dir` (`_assets/`, or a page's) for a file called
/// `name`: its stem cut down to letters, digits and dashes, plus a timestamp. `default_ext` is used
/// when `name` has no extension. Creates the folder.
fn new_asset(vault: &Path, dir: &str, name: &str, default_ext: Option<&str>) -> Result<(String, PathBuf), String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| e.len() <= 10 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(str::to_ascii_lowercase)
        .or_else(|| default_ext.map(str::to_string));
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // draw.io's apps know their diagrams by the double extension (`flow.drawio.svg`), so it's kept.
    let (stem, kind) = match stem.strip_suffix(".drawio") {
        Some(s) => (s.to_string(), ".drawio"),
        None => (stem, ""),
    };
    let stem: String = Some(stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect())
        .filter(|s: &String| !s.is_empty())
        .unwrap_or_else(|| "asset".into());
    let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let rel = match ext {
        Some(ext) => format!("{dir}/{stem}-{stamp}{kind}.{ext}"),
        None => format!("{dir}/{stem}-{stamp}{kind}"),
    };
    let abs = resolve(vault, &rel)?;
    fs::create_dir_all(abs.parent().unwrap()).map_err(|e| e.to_string())?;
    Ok((rel, abs))
}

/// Saves an uploaded image (a page icon, a pasted picture, a diagram) in `page`'s attachment
/// folder, or the workspace's `_assets/` without one; returns its vault path.
pub fn save_asset(vault: &Path, page: Option<&str>, name: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = page.map_or_else(|| ASSETS.to_string(), attachments_dir);
    let (rel, abs) = new_asset(vault, &dir, name, Some("png"))?;
    fs::write(abs, bytes).map_err(|e| e.to_string())?;
    Ok(rel)
}

// ---------- attachments ----------
//
// Files attached to a page live in an `_assets/` folder inside the page's own folder (where its
// sub-pages are): "Projects/Launch plan.md" keeps them in "Projects/Launch plan/_assets/", under
// their own names. Renaming, moving or deleting the page takes them along with its folder, and
// links to them follow. Files that belong to no page (import batches) are in the workspace's
// `_assets/`.

/// The folder `page`'s attachments live in.
pub fn attachments_dir(page: &str) -> String {
    format!("{}/{ASSETS}", children_dir(page))
}

/// A path as written in a Markdown link: what would end or break the link (spaces, brackets, `%`) is
/// escaped as `%XX`, the way Obsidian and GitHub read such links.
pub fn link_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            ' ' | '%' | '(' | ')' | '<' | '>' | '[' | ']' => out.push_str(&format!("%{:02X}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

/// A file's name as kept: no folders, control characters or leading dots, at most ~100 characters
/// before its extension; "file" when nothing's left.
fn clean_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let base: String = base.chars().map(|c| if c.is_control() || c == ':' { '-' } else { c }).collect();
    let base = base.trim().trim_start_matches('.').trim();
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, format!(".{e}")),
        _ => (base, String::new()),
    };
    let stem: String = stem.chars().take(100).collect();
    if stem.trim().is_empty() { format!("file{ext}") } else { format!("{}{ext}", stem.trim_end()) }
}

/// A new, unused path for `name` in `page`'s attachment folder: the name itself, or "name (2).ext"
/// when a file of that name is already there. Creates the folder.
fn new_attachment(vault: &Path, page: &str, name: &str) -> Result<(String, PathBuf), String> {
    let dir = attachments_dir(page);
    let abs_dir = resolve(vault, &dir)?;
    fs::create_dir_all(&abs_dir).map_err(|e| e.to_string())?;
    let name = clean_file_name(name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut candidate = name;
    let mut n = 2;
    while abs_dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    Ok((format!("{dir}/{candidate}"), abs_dir.join(candidate)))
}

/// Saves a file attached to `page` (dropped or pasted) in its attachment folder; returns its vault
/// path. Without a page, it goes in the workspace's `_assets/`, named like an image.
pub fn save_attachment(vault: &Path, page: Option<&str>, name: &str, bytes: &[u8]) -> Result<String, String> {
    let (rel, abs) = match page {
        Some(page) => new_attachment(vault, page, name)?,
        None => new_asset(vault, ASSETS, name, None)?,
    };
    fs::write(abs, bytes).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// Copies a file from anywhere on disk into `page`'s attachment folder; returns its vault path.
pub fn copy_attachment(vault: &Path, page: Option<&str>, src: &Path) -> Result<String, String> {
    if !src.is_file() {
        return Err(format!("not a file: {}", src.display()));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (rel, abs) = match page {
        Some(page) => new_attachment(vault, page, &name)?,
        None => new_asset(vault, ASSETS, &name, None)?,
    };
    fs::copy(src, abs).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// Removes `dir` and the folders above it while they're empty: an emptied `_assets/`, and then the
/// page folder it was in when nothing else is there, up to the workspace itself.
fn remove_empty_asset_dirs(vault: &Path, dir: Option<&Path>) {
    remove_empty_dirs(dir, vault);
}

/// Removes `dir` and the folders above it while they're empty, up to (not including) `stop`. A folder
/// holding only Finder's `.DS_Store` counts as empty.
fn remove_empty_dirs(mut dir: Option<&Path>, stop: &Path) {
    while let Some(d) = dir.filter(|d| d.starts_with(stop) && *d != stop) {
        let only_ds_store = fs::read_dir(d).is_ok_and(|mut e| e.all(|x| x.is_ok_and(|x| x.file_name() == ".DS_Store")));
        if only_ds_store {
            let _ = fs::remove_file(d.join(".DS_Store"));
        }
        if fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

/// Moves `from`'s contents into `to`: the whole folder when `to` isn't there, else entry by entry,
/// numbering a file whose name is taken ("a (2).pdf") rather than overwriting it.
fn merge_dir(from: &Path, to: &Path) -> Result<(), String> {
    if !to.exists() {
        return fs::rename(from, to).map_err(|e| e.to_string());
    }
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        let (src, name) = (entry.path(), entry.file_name().to_string_lossy().into_owned());
        let dest = to.join(&name);
        if src.is_dir() && dest.is_dir() {
            merge_dir(&src, &dest)?;
            continue;
        }
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        let mut dest = dest;
        let mut n = 2;
        while dest.exists() {
            dest = to.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        fs::rename(&src, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Deletes an attached file whose link left `page` (and folders that leaves empty), unless another
/// page links to it: then nothing changes and those pages' titles come back. `page` itself doesn't
/// count (its save may not have landed yet); pages in the Trash do, so restoring one still finds its
/// files. The file goes to the Trash for 30 days, where `restore_attachment` finds it.
pub fn delete_attachment(vault: &Path, rel: &str, page: &str) -> Result<Vec<String>, String> {
    if !in_assets(rel) {
        return Err("Only attached files can be deleted.".into());
    }
    let abs = resolve(vault, rel)?;
    let escaped = link_path(rel);
    let links = |text: &str| text.contains(&escaped) || text.contains(rel);
    let mut linked: Vec<String> = markdown_files(vault)
        .filter(|f| rel_string(vault, f) != page)
        .filter(|f| fs::read_to_string(f).is_ok_and(|t| links(&t)))
        .map(|f| title_of(&rel_string(vault, &f)))
        .collect();
    let trashed = WalkDir::new(vault.join(TRASH)).into_iter().filter_entry(|f| f.file_name() != RELEASED_FILES).filter_map(Result::ok);
    linked.extend(
        trashed
            .filter(|f| f.path().extension().is_some_and(|x| x == "md"))
            .filter(|f| fs::read_to_string(f.path()).is_ok_and(|t| links(&t)))
            .map(|f| format!("{} (in the Trash)", f.path().file_stem().unwrap_or_default().to_string_lossy())),
    );
    if !linked.is_empty() {
        return Ok(linked);
    }
    if abs.is_file() {
        let dest = vault.join(TRASH).join(RELEASED_FILES).join(now_millis().to_string()).join(rel);
        fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::rename(&abs, dest).map_err(|e| e.to_string())?;
    }
    remove_empty_asset_dirs(vault, abs.parent());
    Ok(vec![])
}

/// Brings back an attached file that went to the Trash when its last link went (the link is back:
/// undone, or pasted on another page). Returns whether it did.
pub fn restore_attachment(vault: &Path, rel: &str) -> bool {
    let Some(abs) = resolve(vault, rel).ok().filter(|a| in_assets(rel) && !a.exists()) else { return false };
    let released = vault.join(TRASH).join(RELEASED_FILES);
    let Ok(stamps) = fs::read_dir(&released) else { return false };
    // The latest copy: stamps are millisecond times of the same length, so they sort as text.
    let mut copies: Vec<PathBuf> = stamps.filter_map(Result::ok).map(|s| s.path().join(rel)).filter(|p| p.is_file()).collect();
    copies.sort();
    let Some(copy) = copies.pop() else { return false };
    if fs::create_dir_all(abs.parent().unwrap()).is_err() || fs::rename(&copy, &abs).is_err() {
        return false;
    }
    remove_empty_dirs(copy.parent(), &released);
    true
}

/// Links to files in `old_page`'s folder or its sub-pages' (`Old/_assets/x`, `Old/Step/_assets/y`),
/// in Markdown links and frontmatter (icons, covers), pointed at `new_page`'s.
fn rewrite_attachment_links(text: &str, old_page: &str, new_page: &str) -> String {
    let (old, new) = (children_dir(old_page), children_dir(new_page));
    let has_assets = |rest: &str| {
        let path = rest.split(|c: char| c.is_whitespace() || ")\"'|]".contains(c)).next().unwrap_or("");
        path.starts_with(&format!("{ASSETS}/")) || path.contains(&format!("/{ASSETS}/"))
    };
    // In a Markdown link, `](…)`, the path is escaped (`%20`); in frontmatter it's as it is.
    let linked = renamed_paths_if(text, &link_path(old), &link_path(new), |before, rest| before == Some('(') && has_assets(rest));
    renamed_paths_if(&linked, old, new, |before, rest| before != Some('(') && has_assets(rest))
}

/// A file's size in bytes, or `None` when it isn't there (deleted, or not pulled yet).
pub fn file_size(vault: &Path, rel: &str) -> Option<u64> {
    let meta = fs::metadata(resolve(vault, rel).ok()?).ok()?;
    meta.is_file().then(|| meta.len())
}

pub fn read_asset(vault: &Path, rel: &str) -> Result<Vec<u8>, String> {
    fs::read(resolve(vault, rel)?).map_err(|e| e.to_string())
}

/// Replaces an existing file in `_assets/` or a page's folder in it (a diagram edited in place, an
/// attachment edited in its tab); nothing else can be written this way.
pub fn write_asset(vault: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let abs = resolve(vault, rel)?;
    // No link anywhere on the way (`symlink_metadata` doesn't follow one): a link in `_assets/`
    // mustn't lead the write elsewhere. The file itself must already be there.
    let mut at = vault.to_path_buf();
    let unlinked = Path::new(rel).components().all(|c| {
        at.push(c);
        fs::symlink_metadata(&at).is_ok_and(|m| !m.file_type().is_symlink())
    });
    if !in_assets(rel) || !unlinked || !fs::metadata(&abs).is_ok_and(|m| m.is_file()) {
        return Err(format!("not an asset: {rel}"));
    }
    fs::write(abs, bytes).map_err(|e| e.to_string())
}

// ---------- The workspace's own folder ----------

/// The workspace's settings folder: AI policy, enabled plugins, plugin data, studio settings.
pub const DIR: &str = ".mynote";
/// Legacy name (before the rename to MyNote): workspaces created by Betelgeuse keep their settings here.
pub const LEGACY_DIR: &str = ".betelgeuse";

/// Renames `<vault>/.betelgeuse` (legacy name, before the rename to MyNote) to `<vault>/.mynote`
/// so a workspace made by Betelgeuse keeps its settings. Does nothing when `.mynote` already exists
/// or there is no legacy folder. Call it whenever a workspace opens, before anything reads `.mynote`.
pub fn migrate_legacy_dir(vault: &Path) -> std::io::Result<()> {
    let (old, new) = (vault.join(LEGACY_DIR), vault.join(DIR));
    if new.exists() || !old.is_dir() {
        return Ok(());
    }
    fs::rename(old, new)
}

/// The folder holding a workspace's attached files and uploaded images, at its root.
pub const ASSETS: &str = "_assets";
/// Its names before: hidden `.assets`, then `assets` (which a page named "assets" could clash with).
const LEGACY_ASSETS: [&str; 2] = [".assets", "assets"];

/// Whether `rel` is a path inside an attachments folder (a page's, or the workspace's).
pub fn in_assets(rel: &str) -> bool {
    let mut parts = rel.split('/');
    parts.next_back().is_some_and(|f| !f.is_empty()) && parts.any(|p| p == ASSETS)
}

/// Moves the attachments folder from its earlier names (`.assets/`, `assets/`) to `_assets/`, and
/// then each page's files from there into the page's own folder (`<page>/_assets/`), pointing every
/// link at the new place: in pages, their frontmatter (icons, covers) and the Trash. An `assets/`
/// folder is only taken when it's the attachments folder, not a top-level page's sub-pages
/// (`assets.md` next to it). Into an `_assets/` that's there already, what it lacks moves over; a
/// file both have stays in the old folder. Returns whether anything moved. Call it whenever a
/// workspace opens.
pub fn migrate_assets_dir(vault: &Path) -> Result<bool, String> {
    let new = vault.join(ASSETS);
    let mut moved = Vec::new();
    for old_name in LEGACY_ASSETS {
        let old = vault.join(old_name);
        let page_folder = !old_name.starts_with('.') && fs::read_dir(vault).is_ok_and(|d| d.filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&format!("{old_name}.md"))));
        if !old.is_dir() || page_folder {
            continue;
        }
        if new.exists() {
            move_missing(&old, &new).map_err(|e| e.to_string())?;
            remove_empty_tree(&old);
        } else {
            fs::rename(&old, &new).map_err(|e| e.to_string())?;
        }
        // Files released to the Trash are kept under their path: `.trash/.files/<millis>/.assets/…`.
        if let Ok(stamps) = fs::read_dir(vault.join(TRASH).join(RELEASED_FILES)) {
            for stamp in stamps.filter_map(Result::ok) {
                let (from, to) = (stamp.path().join(old_name), stamp.path().join(ASSETS));
                if from.is_dir() && !to.exists() {
                    let _ = fs::rename(from, to);
                }
            }
        }
        moved.push(old_name);
    }
    if !moved.is_empty() {
        for page in all_markdown(vault) {
            let Ok(text) = fs::read_to_string(&page) else { continue };
            let next = moved.iter().fold(text.clone(), |t, old| renamed_paths(&t, old, ASSETS));
            if next != text {
                fs::write(&page, next).map_err(|e| e.to_string())?;
            }
        }
    }
    // Then each page's files into its own folder.
    let split = split_root_assets(vault)?;
    Ok(!moved.is_empty() || split)
}

/// `text` with paths starting `old/` as `new/`: where a path starts (after a bracket, quote, space
/// or line start), not in the middle of another one (`docs/.assets/`) or a word (`my.assets/`).
fn renamed_paths(text: &str, old: &str, new: &str) -> String {
    renamed_paths_if(text, old, new, |_, _| true)
}

/// `renamed_paths`, for the paths `keep` accepts: it's given the character before the path and
/// the path's rest (after `old/`).
fn renamed_paths_if(text: &str, old: &str, new: &str, keep: impl Fn(Option<char>, &str) -> bool) -> String {
    let from = format!("{old}/");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(&from) {
        out.push_str(&rest[..at]);
        let before = out.chars().next_back();
        let in_path = before.is_some_and(|c| c.is_alphanumeric() || "_./\\-".contains(c));
        rest = &rest[at + from.len()..];
        if in_path || !keep(before, rest) {
            out.push_str(&from);
        } else {
            out.push_str(new);
            out.push('/');
        }
    }
    out.push_str(rest);
    out
}

/// `text` with the file path `from` as `to`, wherever it's a whole path: not part of a longer one.
fn renamed_file(text: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(from) {
        out.push_str(&rest[..at]);
        let after = rest[at + from.len()..].chars().next();
        let starts = !out.chars().next_back().is_some_and(|c| c.is_alphanumeric() || "_./\\-".contains(c));
        let ends = after.is_none_or(|c| c.is_whitespace() || ")\"'|]#?".contains(c));
        out.push_str(if starts && ends { to } else { from });
        rest = &rest[at + from.len()..];
    }
    out.push_str(rest);
    out
}

/// Files kept the earlier way, all in the workspace's `_assets/<page path>/`, move into each page's
/// own folder (`<page path>/_assets/`), links following (in pages, their frontmatter and the Trash).
/// Files of no page (import batches, a deleted page's) stay. Returns whether any moved.
fn split_root_assets(vault: &Path) -> Result<bool, String> {
    let root = vault.join(ASSETS);
    if !root.is_dir() {
        return Ok(false);
    }
    let files: Vec<PathBuf> = WalkDir::new(&root).min_depth(2).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect();
    let mut moved: Vec<(String, String)> = Vec::new();
    for file in files {
        let rel = rel_string(vault, &file);
        let Some((page_dir, name)) = rel[ASSETS.len() + 1..].rsplit_once('/') else { continue };
        if name == ".DS_Store" || !vault.join(format!("{page_dir}.md")).is_file() {
            continue;
        }
        let to_rel = format!("{page_dir}/{ASSETS}/{name}");
        let to = vault.join(&to_rel);
        if to.exists() {
            continue;
        }
        fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::rename(&file, &to).map_err(|e| e.to_string())?;
        moved.push((rel, to_rel));
    }
    if moved.is_empty() {
        return Ok(false);
    }
    remove_empty_tree(&root);
    for page in all_markdown(vault) {
        let Ok(text) = fs::read_to_string(&page) else { continue };
        let next = moved.iter().fold(text.clone(), |t, (from, to)| renamed_file(&renamed_file(&t, &link_path(from), &link_path(to)), from, to));
        if next != text {
            fs::write(&page, next).map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

/// Every Markdown file in the workspace, the Trash's included (not git's or `node_modules`).
fn all_markdown(vault: &Path) -> Vec<PathBuf> {
    WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !matches!(e.file_name().to_str(), Some(".git" | "node_modules")))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md"))
        .map(|e| e.into_path())
        .collect()
}

/// Moves what `from` has and `into` lacks into `into`, folder by folder; files both have stay.
fn move_missing(from: &Path, into: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(from)?.filter_map(Result::ok) {
        let target = into.join(entry.file_name());
        if !target.exists() {
            fs::rename(entry.path(), &target)?;
        } else if entry.path().is_dir() && target.is_dir() {
            move_missing(&entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Removes `dir` and the empty folders in it (bottom up); anything still holding files stays.
fn remove_empty_tree(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
            remove_empty_tree(&e.path());
        }
    }
    let _ = fs::remove_file(dir.join(".DS_Store"));
    let _ = fs::remove_dir(dir);
}

// ---------- AI visibility ----------
//
// Shared with the MCP server through `.mynote/config.json` (versioned with the workspace):
//   "all"    every page is visible to agents unless it or an ancestor has `ai: false`
//   "shared" only pages with `ai: true` on themselves or an ancestor (and none with `ai: false`)

const CONFIG: &str = ".mynote/config.json";

pub fn ai_policy(vault: &Path) -> String {
    fs::read_to_string(vault.join(CONFIG))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("ai")?.get("policy")?.as_str().map(str::to_string))
        .filter(|p| p == "shared")
        .unwrap_or_else(|| "all".into())
}

pub fn set_ai_policy(vault: &Path, policy: &str) -> Result<(), String> {
    let path = vault.join(CONFIG);
    let mut config: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    config["ai"] = serde_json::json!({ "policy": if policy == "shared" { "shared" } else { "all" } });
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, serde_json::to_string_pretty(&config).unwrap() + "\n").map_err(|e| e.to_string())
}

/// Whether agents may see `rel`, given its own and its ancestor pages' `ai` flags.
pub fn ai_visible(vault: &Path, rel: &str, policy: &str) -> bool {
    let mut shared = false;
    let mut current = Some(rel.to_string());
    while let Some(page) = current {
        let content = fs::read_to_string(vault.join(&page)).unwrap_or_default();
        match fm_bool(split_frontmatter(&content).0, "ai") {
            Some(false) => return false,
            Some(true) => shared = true,
            None => {}
        }
        current = page.rsplit_once('/').map(|(dir, _)| format!("{dir}.md"));
    }
    policy != "shared" || shared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter() {
        let (fm, body) = split_frontmatter("---\nicon: 🚀\ntags: [a, \"b\"]\n---\n# Hi\n");
        assert_eq!(fm_value(fm, "icon").as_deref(), Some("🚀"));
        assert_eq!(fm_list(fm, "tags"), vec!["a", "b"]);
        assert_eq!(body, "# Hi\n");
        let (fm, _) = split_frontmatter("---\ntags:\n  - x\n  - y\nicon: a\n---\n");
        assert_eq!(fm_list(fm, "tags"), vec!["x", "y"]);
    }

    #[test]
    fn migrates_legacy_dir() {
        let dir = std::env::temp_dir().join(format!("mynote-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // A legacy folder moves with its contents.
        fs::create_dir_all(dir.join(LEGACY_DIR).join("plugins/x")).unwrap();
        fs::write(dir.join(LEGACY_DIR).join("config.json"), "{\"ai\":{\"policy\":\"shared\"}}").unwrap();
        fs::write(dir.join(LEGACY_DIR).join("plugins/x/data.json"), "{}").unwrap();
        migrate_legacy_dir(&dir).unwrap();
        assert!(!dir.join(LEGACY_DIR).exists());
        assert_eq!(ai_policy(&dir), "shared");
        assert!(dir.join(DIR).join("plugins/x/data.json").is_file());
        // An existing `.mynote` is left alone, and so is the legacy folder next to it.
        fs::create_dir_all(dir.join(LEGACY_DIR)).unwrap();
        fs::write(dir.join(LEGACY_DIR).join("config.json"), "{}").unwrap();
        migrate_legacy_dir(&dir).unwrap();
        assert_eq!(ai_policy(&dir), "shared");
        assert!(dir.join(LEGACY_DIR).join("config.json").is_file());
        // Nothing to migrate is fine.
        let empty = dir.join("empty");
        fs::create_dir_all(&empty).unwrap();
        migrate_legacy_dir(&empty).unwrap();
        assert!(!empty.join(DIR).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_the_attachments_folder_and_its_links() {
        let dir = std::env::temp_dir().join(format!("mynote-migrate-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".assets/Plan")).unwrap();
        fs::write(dir.join(".assets/Plan/Q3 Report.pdf"), b"r").unwrap();
        fs::write(dir.join(".assets/logo-1.png"), b"p").unwrap();
        let page = "---\nicon: .assets/logo-1.png\ncover: \".assets/logo-1.png\"\n---\n[f](.assets/Plan/Q3%20Report.pdf) ![x](.assets/logo-1.png) and my.assets/x, docs/.assets/y\n";
        write_note(&dir, "Plan.md", page).unwrap();
        // In the Trash too: a deleted page's text, and a file released when its last link went.
        write_note(&dir, ".trash/123/Old.md", "[o](.assets/Old/o.txt)").unwrap();
        fs::create_dir_all(dir.join(".trash/123/.assets")).unwrap();
        fs::create_dir_all(dir.join(".trash/.files/99/.assets/Gone")).unwrap();
        fs::write(dir.join(".trash/.files/99/.assets/Gone/g.txt"), b"g").unwrap();

        assert!(migrate_assets_dir(&dir).unwrap());
        assert!(!dir.join(".assets").exists());
        // The page's file is in its own folder; the icon, which belongs to no page's folder, stays.
        assert_eq!(read_asset(&dir, "Plan/_assets/Q3 Report.pdf").unwrap(), b"r");
        assert!(!dir.join("_assets/Plan").exists());
        assert_eq!(read_asset(&dir, "_assets/logo-1.png").unwrap(), b"p");
        assert_eq!(
            read_note(&dir, "Plan.md").unwrap(),
            "---\nicon: _assets/logo-1.png\ncover: \"_assets/logo-1.png\"\n---\n[f](Plan/_assets/Q3%20Report.pdf) ![x](_assets/logo-1.png) and my.assets/x, docs/.assets/y\n"
        );
        // A page in the Trash has no folder to go to: its links get the new folder name only.
        assert_eq!(fs::read_to_string(dir.join(".trash/123/Old.md")).unwrap(), "[o](_assets/Old/o.txt)");
        assert!(dir.join(".trash/123/.assets").is_dir(), "a trashed page's own folder keeps its name");
        assert!(restore_attachment(&dir, "_assets/Gone/g.txt"), "files released to the Trash come back under the new name");
        // Attachment folders aren't page folders: their Markdown files aren't pages.
        fs::write(dir.join("_assets/readme.md"), "x").unwrap();
        fs::write(dir.join("Plan/_assets/notes.md"), "x").unwrap();
        assert_eq!(list_notes(&dir).iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), ["Plan.md"]);
        // Done once; running again changes nothing.
        assert!(!migrate_assets_dir(&dir).unwrap());

        // A file the page's folder already has (written meanwhile) wins; the old copy stays put.
        fs::create_dir_all(dir.join(".assets/Plan")).unwrap();
        fs::write(dir.join(".assets/Plan/Q3 Report.pdf"), b"old").unwrap();
        fs::write(dir.join(".assets/Plan/new.txt"), b"n").unwrap();
        assert!(migrate_assets_dir(&dir).unwrap());
        assert_eq!(read_asset(&dir, "Plan/_assets/Q3 Report.pdf").unwrap(), b"r");
        assert_eq!(read_asset(&dir, "Plan/_assets/new.txt").unwrap(), b"n");
        assert!(dir.join("_assets/Plan/Q3 Report.pdf").is_file());
        let _ = fs::remove_dir_all(&dir);

        // The visible `assets/` name it had for a while moves too, links with it…
        let ws = std::env::temp_dir().join(format!("mynote-migrate-assets2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("assets/Plan")).unwrap();
        fs::write(ws.join("assets/Plan/a.pdf"), b"a").unwrap();
        write_note(&ws, "Plan.md", "[a](assets/Plan/a.pdf) in docs/assets/x").unwrap();
        assert!(migrate_assets_dir(&ws).unwrap());
        assert!(!ws.join("assets").exists());
        assert_eq!(read_asset(&ws, "Plan/_assets/a.pdf").unwrap(), b"a");
        assert_eq!(read_note(&ws, "Plan.md").unwrap(), "[a](Plan/_assets/a.pdf) in docs/assets/x");
        // …but not when it's the sub-pages of a top-level page named "assets".
        write_note(&ws, "Assets.md", "").unwrap();
        write_note(&ws, "Assets/Logo ideas.md", "[l](assets/whatever)").unwrap();
        assert!(!migrate_assets_dir(&ws).unwrap());
        assert!(ws.join("Assets/Logo ideas.md").is_file());
        assert_eq!(read_note(&ws, "Assets/Logo ideas.md").unwrap(), "[l](assets/whatever)");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_page_is_never_named_like_the_attachments_folder() {
        let dir = std::env::temp_dir().join(format!("mynote-reserved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(create_note(&dir, None, "_assets").unwrap(), "_assets 2.md");
        assert_eq!(create_note(&dir, None, "Assets").unwrap(), "Assets.md", "an ordinary name now");
        // Nor below the top: its sub-pages would be in its parent's attachments.
        write_note(&dir, "Work.md", "").unwrap();
        assert_eq!(create_note(&dir, Some("Work.md"), "_assets").unwrap(), "Work/_assets 2.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_notes_exposes_order() {
        let dir = std::env::temp_dir().join(format!("mynote-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "A.md", "---\nicon: 🚀\norder: 2\n---\n").unwrap();
        write_note(&dir, "B.md", "---\norder: -0.5\n---\nbody").unwrap();
        write_note(&dir, "C.md", "no frontmatter").unwrap();
        write_note(&dir, "D.md", "---\norder: soon\n---\n").unwrap();
        write_note(&dir, "E.md", "---\norder: inf\n---\n").unwrap();
        let orders: Vec<_> = list_notes(&dir).into_iter().map(|n| (n.title, n.order)).collect();
        assert_eq!(
            orders,
            vec![("A".into(), Some(2.0)), ("B".into(), Some(-0.5)), ("C".into(), None), ("D".into(), None), ("E".into(), None)]
        );
        let json = serde_json::to_value(&list_notes(&dir)[0]).unwrap();
        assert_eq!(json["order"], serde_json::json!(2.0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachments_go_in_their_pages_folder_under_their_own_names() {
        let dir = std::env::temp_dir().join(format!("mynote-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let page = "Projects/Launch plan.md";
        assert_eq!(save_attachment(&dir, Some(page), "Q3 Report.pdf", b"1").unwrap(), "Projects/Launch plan/_assets/Q3 Report.pdf");
        // A second file of the same name is numbered, not overwritten.
        assert_eq!(save_attachment(&dir, Some(page), "Q3 Report.pdf", b"2").unwrap(), "Projects/Launch plan/_assets/Q3 Report (2).pdf");
        assert_eq!(read_asset(&dir, "Projects/Launch plan/_assets/Q3 Report.pdf").unwrap(), b"1");
        // Names can't climb out of the folder or hide.
        assert_eq!(save_attachment(&dir, Some(page), "../../evil.sh", b"x").unwrap(), "Projects/Launch plan/_assets/evil.sh");
        assert_eq!(save_attachment(&dir, Some(page), ".env", b"x").unwrap(), "Projects/Launch plan/_assets/env");
        assert_eq!(save_attachment(&dir, Some(page), "", b"x").unwrap(), "Projects/Launch plan/_assets/file");
        assert!(save_attachment(&dir, Some("../Outside.md"), "a.txt", b"x").is_err());
        // Without a page: the workspace's `_assets/`, no extension invented.
        let plain = save_attachment(&dir, None, "Makefile", b"all:").unwrap();
        assert!(plain.starts_with("_assets/Makefile-") && !plain.trim_start_matches("_assets/").contains('.'), "{plain}");
        // Uploaded images get a stamped name, and default to .png.
        assert!(save_asset(&dir, None, "clipboard", b"p").unwrap().ends_with(".png"));
        assert!(save_asset(&dir, Some(page), "clipboard", b"p").unwrap().starts_with("Projects/Launch plan/_assets/clipboard-"));
        // A Markdown file attached to a page isn't a page.
        write_note(&dir, page, "").unwrap();
        save_attachment(&dir, Some(page), "notes.md", b"# x").unwrap();
        assert_eq!(list_notes(&dir).iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), [page]);

        let outside = std::env::temp_dir().join(format!("mynote-attach-src-{}.numbers", std::process::id()));
        fs::write(&outside, b"%PDF-1.7 hello").unwrap();
        let copied = copy_attachment(&dir, Some(page), &outside).unwrap();
        assert_eq!(copied, format!("Projects/Launch plan/_assets/{}", outside.file_name().unwrap().to_string_lossy()));
        assert_eq!(file_size(&dir, &copied), Some(14));
        assert_eq!(file_size(&dir, "_assets/missing.pdf"), None);
        assert_eq!(file_size(&dir, "_assets"), None, "a folder isn't a file");
        assert!(copy_attachment(&dir, Some(page), &dir).is_err(), "folders can't be attached");
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_an_attachment_removes_the_file_and_its_emptied_folder_unless_still_linked() {
        let dir = std::env::temp_dir().join(format!("mynote-attach-del-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Work/Plan.md", "").unwrap();
        let a = save_attachment(&dir, Some("Work/Plan.md"), "a.pdf", b"a").unwrap();
        let b = save_attachment(&dir, Some("Work/Plan.md"), "b c.pdf", b"b").unwrap();
        let link = |rel: &str| format!("[f]({})", link_path(rel));
        write_note(&dir, "Work/Plan.md", &format!("{}\n{}", link(&a), link(&b))).unwrap();
        write_note(&dir, "Other.md", &link(&b)).unwrap();

        // Its own page still links it on disk (the save comes later): that doesn't count.
        assert_eq!(delete_attachment(&dir, &a, "Work/Plan.md").unwrap(), Vec::<String>::new());
        assert!(!dir.join(&a).exists());
        // Another page links it: kept, and that page is named.
        assert_eq!(delete_attachment(&dir, &b, "Work/Plan.md").unwrap(), vec!["Other".to_string()]);
        assert!(dir.join(&b).is_file());
        write_note(&dir, "Other.md", "").unwrap();
        assert!(delete_attachment(&dir, &b, "Work/Plan.md").unwrap().is_empty());
        // The emptied `_assets/` goes, and the page folder with it when nothing else is there.
        assert!(!dir.join("Work/Plan").exists());
        assert!(dir.join("Work/Plan.md").is_file());
        assert!(delete_attachment(&dir, "Work/Plan.md", "Other.md").is_err(), "only attached files");
        assert!(delete_attachment(&dir, "Work/Plan/_assets/../../Other.md", "Work/Plan.md").is_err());

        // Gone from the folder, but kept in the Trash: when its link comes back (undo, or pasted on
        // another page), the file does too, folders and all.
        assert!(restore_attachment(&dir, &a));
        assert_eq!(read_asset(&dir, &a).unwrap(), b"a");
        assert!(!restore_attachment(&dir, &a), "it's there already");
        assert!(restore_attachment(&dir, &b));
        assert!(!dir.join(".trash/.files").read_dir().unwrap().any(|_| true), "nothing left behind");
        assert!(!restore_attachment(&dir, "_assets/never-there.pdf"));
        // Finder's .DS_Store doesn't keep an emptied folder around.
        fs::write(dir.join("Work/Plan/_assets/.DS_Store"), b"").unwrap();
        fs::write(dir.join("Work/Plan/.DS_Store"), b"").unwrap();
        delete_attachment(&dir, &a, "Work/Plan.md").unwrap();
        delete_attachment(&dir, &b, "Work/Plan.md").unwrap();
        assert!(!dir.join("Work/Plan").exists());
        assert!(restore_attachment(&dir, &a) && restore_attachment(&dir, &b));
        // Released files expire with the Trash (30 days).
        delete_attachment(&dir, &a, "Work/Plan.md").unwrap();
        let old = dir.join(".trash/.files/1000000000000");
        fs::rename(dir.join(".trash/.files").read_dir().unwrap().next().unwrap().unwrap().path(), &old).unwrap();
        assert!(list_trash(&dir).is_empty(), "released files aren't trash items");
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deleted_pages_attachments_go_to_the_trash_and_come_back() {
        let dir = std::env::temp_dir().join(format!("mynote-attach-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Plan.md", "").unwrap();
        write_note(&dir, "Plan/Step.md", "").unwrap();
        let report = save_attachment(&dir, Some("Plan.md"), "Q3 Report.pdf", b"r").unwrap();
        save_attachment(&dir, Some("Plan/Step.md"), "data.csv", b"c").unwrap();
        write_note(&dir, "Plan.md", &format!("[f]({})", link_path(&report))).unwrap();

        let id = delete_note(&dir, "Plan.md").unwrap();
        assert!(!dir.join("Plan").exists(), "its folder, files and all, went with it");
        assert_eq!(list_trash(&dir)[0].pages, 2, "attached files aren't counted as pages");
        // A file only a trashed page links stays: restoring the page would need it.
        write_note(&dir, "Plan.md", "a new page took the name").unwrap();
        assert_eq!(delete_attachment(&dir, &report, "Plan.md").unwrap(), vec!["Plan (in the Trash)".to_string()]);

        // Restored as "Plan 2" (the name's taken): its files come back in its folder, links follow.
        assert_eq!(restore_trash(&dir, &id).unwrap(), "Plan 2.md");
        assert_eq!(read_asset(&dir, "Plan 2/_assets/Q3 Report.pdf").unwrap(), b"r");
        assert!(dir.join("Plan 2/Step/_assets/data.csv").is_file());
        // (Its frontmatter keeps its name, "Plan".)
        assert!(read_note(&dir, "Plan 2.md").unwrap().ends_with("\n[f](Plan%202/_assets/Q3%20Report.pdf)"));
        assert!(list_trash(&dir).is_empty());

        // Emptying the Trash deletes them for good.
        let id = delete_note(&dir, "Plan 2.md").unwrap();
        purge_trash(&dir, Some(&id)).unwrap();
        assert!(!dir.join("Plan 2").exists());

        // Trashed before files lived in page folders: they come back into the page's folder.
        let old = dir.join(".trash/1/.assets");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("a.pdf"), b"a").unwrap();
        fs::write(dir.join(".trash/1/Notes.md"), "[a](_assets/Notes/a.pdf)").unwrap();
        fs::write(dir.join(".trash/1/meta.json"), format!("{{\"original\":\"Notes.md\",\"deleted\":{}}}", now_millis())).unwrap();
        assert_eq!(restore_trash(&dir, "1").unwrap(), "Notes.md");
        assert_eq!(read_asset(&dir, "Notes/_assets/a.pdf").unwrap(), b"a");
        assert_eq!(read_note(&dir, "Notes.md").unwrap(), "[a](Notes/_assets/a.pdf)");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachment_folders_and_links_follow_renamed_and_moved_pages() {
        let dir = std::env::temp_dir().join(format!("mynote-attach-move-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Work.md", "").unwrap();
        write_note(&dir, "Work/Plan.md", "").unwrap();
        write_note(&dir, "Work/Plan/Step.md", "").unwrap();
        let report = save_attachment(&dir, Some("Work/Plan.md"), "Q3 Report.pdf", b"r").unwrap();
        let sheet = save_attachment(&dir, Some("Work/Plan/Step.md"), "data.csv", b"c").unwrap();
        let link = |rel: &str| format!("[f]({})", link_path(rel));
        assert_eq!(link(&report), "[f](Work/Plan/_assets/Q3%20Report.pdf)");
        write_note(&dir, "Work/Plan.md", &link(&report)).unwrap();
        write_note(&dir, "Work/Plan/Step.md", &link(&sheet)).unwrap();
        // Another page linking to the file (and using one as its icon), and one linking to a different page's folder.
        write_note(&dir, "Home.md", &format!("---\nicon: Work/Plan/_assets/i.png\n---\n{} and [x](Work/Planner/_assets/x.pdf)", link(&report))).unwrap();

        let renamed = rename_note(&dir, "Work/Plan.md", "Launch plan").unwrap();
        assert_eq!(renamed, "Work/Launch plan.md");
        assert!(dir.join("Work/Launch plan/_assets/Q3 Report.pdf").is_file());
        assert!(dir.join("Work/Launch plan/Step/_assets/data.csv").is_file(), "sub-pages' files move along");
        assert!(!dir.join("Work/Plan").exists());
        assert_eq!(read_note(&dir, "Work/Launch plan.md").unwrap(), "[f](Work/Launch%20plan/_assets/Q3%20Report.pdf)");
        assert_eq!(read_note(&dir, "Work/Launch plan/Step.md").unwrap(), "[f](Work/Launch%20plan/Step/_assets/data.csv)");
        assert_eq!(
            read_note(&dir, "Home.md").unwrap(),
            "---\nicon: Work/Launch plan/_assets/i.png\n---\n[f](Work/Launch%20plan/_assets/Q3%20Report.pdf) and [x](Work/Planner/_assets/x.pdf)"
        );

        let moved = move_note(&dir, "Work/Launch plan.md", "").unwrap();
        assert_eq!(moved, "Launch plan.md");
        assert!(dir.join("Launch plan/_assets/Q3 Report.pdf").is_file());
        assert!(!dir.join("Work").exists(), "the empty parent folder goes");
        assert_eq!(
            read_note(&dir, "Home.md").unwrap(),
            "---\nicon: Launch plan/_assets/i.png\n---\n[f](Launch%20plan/_assets/Q3%20Report.pdf) and [x](Work/Planner/_assets/x.pdf)"
        );
        assert_eq!(read_note(&dir, "Launch plan/Step.md").unwrap(), "[f](Launch%20plan/Step/_assets/data.csv)");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diagrams_keep_their_drawio_extension_and_only_assets_are_rewritten() {
        let dir = std::env::temp_dir().join(format!("mynote-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let diagram = save_asset(&dir, None, "Flow chart.drawio.svg", b"<svg/>").unwrap();
        assert!(diagram.starts_with("_assets/Flowchart-") && diagram.ends_with(".drawio.svg"), "{diagram}");
        let photo = save_asset(&dir, Some("Page.md"), "photo.png", b"png").unwrap();
        assert!(photo.starts_with("Page/_assets/photo-") && !photo.contains("drawio"), "{photo}");

        write_asset(&dir, &diagram, b"<svg>2</svg>").unwrap();
        assert_eq!(read_asset(&dir, &diagram).unwrap(), b"<svg>2</svg>");
        // Pages, files outside an `_assets/`, new files and escapes are all refused.
        write_note(&dir, "Page.md", "text").unwrap();
        for rel in ["Page.md", "_assets/new.svg", "_assets/../Page.md", "Page/_assets/../../Page.md", "../outside.svg", "_assets/sub/x.svg"] {
            assert!(write_asset(&dir, rel, b"x").is_err(), "{rel}");
        }
        assert_eq!(fs::read_to_string(dir.join("Page.md")).unwrap(), "text");
        // A file in a page's attachment folder is edited in its tab, but a linked folder can't lead out.
        let attached = save_attachment(&dir, Some("Page.md"), "notes.json", b"{}").unwrap();
        write_asset(&dir, &attached, b"{\"a\":1}").unwrap();
        assert_eq!(read_asset(&dir, &attached).unwrap(), b"{\"a\":1}");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("Page.md"), dir.join("_assets/link.svg")).unwrap();
            assert!(write_asset(&dir, "_assets/link.svg", b"x").is_err());
            std::os::unix::fs::symlink(&dir, dir.join("_assets/out")).unwrap();
            assert!(write_asset(&dir, "_assets/out/Page.md", b"x").is_err());
            assert_eq!(fs::read_to_string(dir.join("Page.md")).unwrap(), "text");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn moves_pages_with_their_sub_pages_and_links() {
        let dir = std::env::temp_dir().join(format!("mynote-move-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Work.md", "").unwrap();
        write_note(&dir, "Work/Plan.md", "").unwrap();
        write_note(&dir, "Work/Plan/Step.md", "").unwrap();
        write_note(&dir, "Home.md", "See [[Work/Plan]], [[Work/Plan/Step|the step]] and [[Plan]].").unwrap();
        write_note(&dir, "Ideas/Plan.md", "").unwrap();

        // Into another page: its sub-pages come along, path links follow.
        assert_eq!(move_note(&dir, "Work/Plan.md", "Home").unwrap(), "Home/Plan.md");
        assert!(dir.join("Home/Plan/Step.md").exists() && !dir.join("Work/Plan").exists());
        assert_eq!(read_note(&dir, "Home.md").unwrap(), "See [[Home/Plan]], [[Home/Plan/Step|the step]] and [[Plan]].");
        // A page can't go inside itself or its own sub-pages.
        assert!(move_note(&dir, "Home.md", "Home/Plan").is_err());
        // To the top level; the folder it leaves empty goes too.
        assert_eq!(move_note(&dir, "Ideas/Plan.md", "").unwrap(), "Plan.md");
        assert!(!dir.join("Ideas").exists());
        // Same folder: nothing to do.
        assert_eq!(move_note(&dir, "Plan.md", "").unwrap(), "Plan.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn database_rows_follow_their_order() {
        let dir = std::env::temp_dir().join(format!("mynote-row-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Db.md", "---\ntype: database\n---\n").unwrap();
        write_note(&dir, "Db/Apple.md", "---\norder: 3\n---\n").unwrap();
        write_note(&dir, "Db/Zebra.md", "---\norder: 1\n---\n").unwrap();
        write_note(&dir, "Db/New row.md", "").unwrap();
        write_note(&dir, "Db/Mango.md", "---\norder: 2\n---\n").unwrap();
        let titles: Vec<_> = database_rows(&dir, "Db.md").unwrap().into_iter().map(|r| r.title).collect();
        // Ordered rows first, by `order`; rows without one after them.
        assert_eq!(titles, ["Zebra", "Mango", "Apple", "New row"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_and_rewrites_links() {
        let t = "see [[Ideas]] and [[Ideas|my ideas]] and [[Other#h]]";
        assert_eq!(wikilinks(t).collect::<Vec<_>>(), vec!["Ideas", "Ideas", "Other"]);
        assert_eq!(rewrite_links(t, "Ideas", "Plans"), "see [[Plans]] and [[Plans|my ideas]] and [[Other#h]]");
        // Links match the way they resolve: case-insensitively. Lookalikes stay.
        assert_eq!(rewrite_links("[[ideas#a]] [[Ideas 2]] [[My Ideas]]", "Ideas", "Plans"), "[[Plans#a]] [[Ideas 2]] [[My Ideas]]");
        assert_eq!(
            rewrite_link_paths("[[areas/studio]] [[Areas/Studio/Notes|n]] [[Areas/Studios]] ![[Areas/Studio/DB]]", "Areas/Studio", "Areas/Lab"),
            "[[Areas/Lab]] [[Areas/Lab/Notes|n]] [[Areas/Studios]] ![[Areas/Lab/DB]]"
        );
        assert!(link_matches("ideas", "Ideas.md"));
        assert!(link_matches("Welcome/Ideas", "Welcome/Ideas.md"));
    }

    #[test]
    fn relations_in_frontmatter_are_backlinks_and_follow_renames() {
        let dir = std::env::temp_dir().join(format!("mynote-relations-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Areas/Projects")).unwrap();
        fs::create_dir_all(dir.join("Tasks")).unwrap();
        fs::write(dir.join("Areas/Projects.md"), "---\ntype: database\n---\n").unwrap();
        fs::write(dir.join("Areas/Projects/Khao.md"), "").unwrap();
        let schema = "---\ntype: database\n---\n```database\n{\"properties\":[{\"name\":\"Project\",\"type\":\"relation\",\"database\":\"[[Areas/Projects]]\"}]}\n```\n";
        fs::write(dir.join("Tasks.md"), schema).unwrap();
        fs::write(dir.join("Tasks/Design.md"), "---\nProject: [\"[[Khao]]\"]\n---\n").unwrap();

        assert_eq!(backlinks(&dir, "Areas/Projects/Khao.md").iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["Tasks/Design.md"]);
        rename_note(&dir, "Areas/Projects/Khao.md", "Khaoo").unwrap();
        assert_eq!(fs::read_to_string(dir.join("Tasks/Design.md")).unwrap(), "---\nProject: [\"[[Khaoo]]\"]\n---\n");
        rename_note(&dir, "Areas/Projects.md", "Products").unwrap();
        assert!(fs::read_to_string(dir.join("Tasks.md")).unwrap().contains("\"[[Areas/Products]]\""));
        move_note(&dir, "Areas/Products.md", "").unwrap();
        assert!(fs::read_to_string(dir.join("Tasks.md")).unwrap().contains("\"[[Products]]\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ai_visibility_inherits_from_parent_pages() {
        let dir = std::env::temp_dir().join(format!("mynote-ai-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Open.md", "hello").unwrap();
        write_note(&dir, "Secret.md", "---\nai: false\n---\nshh").unwrap();
        write_note(&dir, "Secret/Child.md", "inner").unwrap();
        write_note(&dir, "Shared.md", "---\nai: true\n---\n").unwrap();
        write_note(&dir, "Shared/Child.md", "").unwrap();
        assert!(ai_visible(&dir, "Open.md", "all"));
        assert!(!ai_visible(&dir, "Secret.md", "all"));
        assert!(!ai_visible(&dir, "Secret/Child.md", "all"));
        assert!(!ai_visible(&dir, "Open.md", "shared"));
        assert!(ai_visible(&dir, "Shared/Child.md", "shared"));
        set_ai_policy(&dir, "shared").unwrap();
        assert_eq!(ai_policy(&dir), "shared");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_round_trip() {
        let dir = std::env::temp_dir().join(format!("mynote-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Projects.md", "---\nicon: 🚀\n---\nhi").unwrap();
        write_note(&dir, "Projects/Plan.md", "plan").unwrap();
        let id = delete_note(&dir, "Projects.md").unwrap();
        assert!(!dir.join("Projects.md").exists() && !dir.join("Projects").exists());
        let items = list_trash(&dir);
        assert_eq!((items.len(), items[0].pages, items[0].icon.as_deref()), (1, 2, Some("🚀")));
        assert!(list_notes(&dir).is_empty(), "trash is not part of the page tree");
        // Restoring while the name is taken keeps both pages.
        write_note(&dir, "Projects.md", "new").unwrap();
        assert_eq!(restore_trash(&dir, &id).unwrap(), "Projects 2.md");
        assert_eq!(fs::read_to_string(dir.join("Projects 2/Plan.md")).unwrap(), "plan");
        assert!(list_trash(&dir).is_empty());
        let id = delete_note(&dir, "Projects 2.md").unwrap();
        purge_trash(&dir, Some(&id)).unwrap();
        assert!(list_trash(&dir).is_empty());
        assert!(trash_dir(&dir, "../x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pages_in_one_place_can_share_a_name() {
        let dir = std::env::temp_dir().join(format!("mynote-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_note(&dir, "Budget.md", "---\ntype: database\n---\n").unwrap();
        let names = |dir: &Path| database_rows(dir, "Budget.md").unwrap().into_iter().map(|r| (r.path, r.title)).collect::<Vec<_>>();

        // Three rows called "Salary": numbered files, one name.
        let a = create_note(&dir, Some("Budget.md"), "Salary").unwrap();
        let b = create_note(&dir, Some("Budget.md"), "Salary").unwrap();
        let c = create_note(&dir, Some("Budget.md"), "Salary").unwrap();
        assert_eq!((a.as_str(), b.as_str(), c.as_str()), ("Budget/Salary.md", "Budget/Salary 2.md", "Budget/Salary 3.md"));
        assert!(names(&dir).iter().all(|(_, t)| t == "Salary"));
        assert_eq!(read_note(&dir, &a).unwrap(), "", "a name that fits its file needs no frontmatter");
        assert_eq!(read_note(&dir, &b).unwrap(), "---\ntitle: \"Salary\"\n---\n");

        // Renamed to a name that's free, the file follows and the frontmatter goes.
        write_note(&dir, &b, "---\ntitle: \"Salary\"\nAmount: 10\n---\nBody\n").unwrap();
        let bonus = rename_note(&dir, &b, "Bonus").unwrap();
        assert_eq!(bonus, "Budget/Bonus.md");
        assert_eq!(read_note(&dir, &bonus).unwrap(), "---\nAmount: 10\n---\nBody\n");
        // Renamed to a name that's taken, it keeps the name anyway.
        let back = rename_note(&dir, &bonus, "Salary").unwrap();
        assert_eq!(back, "Budget/Salary 2.md");
        assert_eq!(page_title(&back, split_frontmatter(&read_note(&dir, &back).unwrap()).0), "Salary");
        assert_eq!(rename_note(&dir, &back, "Salary").unwrap(), back, "same name: nothing to do");
        // A name a file can't hold (a slash) is kept whole.
        let odd = rename_note(&dir, &c, "Rent: Jan/Feb \"paid\"").unwrap();
        assert_eq!(odd, "Budget/Rent Jan Feb paid.md");
        assert_eq!(list_notes(&dir).into_iter().find(|n| n.path == odd).unwrap().title, "Rent: Jan/Feb \"paid\"");

        // Duplicates, moves and restores keep names.
        let copy = duplicate_note(&dir, &back).unwrap();
        assert_eq!(page_title(&copy, split_frontmatter(&read_note(&dir, &copy).unwrap()).0), "Salary copy");
        write_note(&dir, "Plan.md", "").unwrap();
        write_note(&dir, "Work/Plan.md", "x").unwrap();
        let moved = move_note(&dir, "Work/Plan.md", "").unwrap();
        assert_eq!(moved, "Plan 2.md");
        assert_eq!(list_notes(&dir).into_iter().find(|n| n.path == moved).unwrap().title, "Plan");
        let id = delete_note(&dir, &a).unwrap();
        create_note(&dir, Some("Budget.md"), "Salary").unwrap(); // takes Salary.md meanwhile
        assert_eq!(list_trash(&dir)[0].title, "Salary");
        let restored = restore_trash(&dir, &id).unwrap();
        assert_ne!(restored, a);
        assert_eq!(list_notes(&dir).into_iter().find(|n| n.path == restored).unwrap().title, "Salary");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sets_and_removes_frontmatter_strings() {
        assert_eq!(set_fm_string("Body", "title", Some("A")), "---\ntitle: \"A\"\n---\nBody");
        assert_eq!(set_fm_string("---\ntitle: \"A\"\nicon: x\n---\nBody", "title", None), "---\nicon: x\n---\nBody");
        assert_eq!(set_fm_string("---\ntitle: A\n---\nBody", "title", None), "Body");
        // Nested keys of the same name stay.
        let nested = "---\nmeta:\n  title: inner\n---\n";
        assert_eq!(set_fm_string(nested, "title", None), nested);
        assert_eq!(fm_string("title: \"a \\\"b\\\" c\"", "title").as_deref(), Some("a \"b\" c"));
        assert_eq!(fm_string("title: plain", "title").as_deref(), Some("plain"));
    }

    #[test]
    fn rejects_escaping_paths() {
        let v = Path::new("/vault");
        assert!(resolve(v, "../etc/passwd").is_err());
        assert!(resolve(v, "/etc/passwd").is_err());
        assert!(resolve(v, "A/B.md").is_ok());
    }
}
