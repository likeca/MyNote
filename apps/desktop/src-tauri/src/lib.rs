mod importer;
mod legacy;
mod library;
mod login_path;
mod script;
mod seed;
mod terminal;

// The workspace engine lives in the shared core crate; these keep `crate::vault` / `crate::git` paths working.
pub(crate) use mynote_core::{git, plugin_store, plugins, vault};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Changes are committed once the vault has been quiet for this long.
const AUTOCOMMIT_IDLE: Duration = Duration::from_secs(8);
/// Syncs with the remote this often by default (Settings → Git & sync changes it).
const AUTOSYNC_EVERY: Duration = Duration::from_secs(5 * 60);
/// An automatic sync waits until pages have been left alone this long: never mid-typing.
const SYNC_QUIET: Duration = Duration::from_secs(30);

struct Shared {
    vault: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    /// Time of the last file change that has not been committed yet.
    pending: Mutex<Option<Instant>>,
    /// Idle time before auto-committing; `None` turns auto-commit off.
    autocommit: Mutex<Option<Duration>>,
    /// How often to sync with the remote unattended; `None` turns it off.
    autosync: Mutex<Option<Duration>>,
    /// The last time pages changed on disk (by anyone), and whether they did since the last sync.
    last_change: Mutex<Option<Instant>>,
    changed_since_sync: AtomicBool,
    /// When the last sync ran (`None`: as soon as things are quiet, e.g. at start or on focus).
    last_sync: Mutex<Option<Instant>>,
    /// Held while a sync runs, so manual and automatic ones never overlap.
    sync_lock: Mutex<()>,
    syncing: AtomicBool,
    /// The media library service (plugins use it through `ctx.library`).
    library: library::Shared,
    /// Shell code blocks being run from pages.
    scripts: script::Running,
    /// The shells of open terminal tabs.
    terminals: terminal::Terminals,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            vault: Mutex::default(),
            watcher: Mutex::default(),
            pending: Mutex::default(),
            autocommit: Mutex::new(Some(AUTOCOMMIT_IDLE)),
            autosync: Mutex::new(Some(AUTOSYNC_EVERY)),
            last_change: Mutex::default(),
            changed_since_sync: AtomicBool::new(false),
            last_sync: Mutex::default(),
            sync_lock: Mutex::default(),
            syncing: AtomicBool::new(false),
            library: Arc::default(),
            scripts: script::Running::default(),
            terminals: terminal::Terminals::default(),
        }
    }
}

type AppState = Arc<Shared>;

#[derive(Serialize)]
struct VaultInfo {
    path: String,
    name: String,
}

#[derive(Serialize)]
struct McpInfo {
    server_path: String,
    built: bool,
    vault: String,
    /// Absolute path to Node.js, if installed.
    node_path: Option<String>,
}

fn vault(state: &AppState) -> Result<PathBuf, String> {
    state.vault.lock().unwrap().clone().ok_or_else(|| "no workspace open".into())
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn saved_vault(app: &AppHandle) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_file(app)?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("vault")?.as_str().map(PathBuf::from).filter(|p| p.is_dir())
}

/// How many workspaces the history in the sidebar's workspace menu keeps.
const RECENT_WORKSPACES: usize = 10;

fn read_config(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    config_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: serde_json::Map<String, serde_json::Value>) {
    if let Some(file) = config_file(app) {
        let _ = std::fs::create_dir_all(file.parent().unwrap());
        let _ = std::fs::write(file, serde_json::Value::Object(config).to_string());
    }
}

/// The workspace history, newest first.
fn recent_paths(config: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let list = config.get("recent").and_then(|v| v.as_array());
    list.map(|l| l.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// `path` moved (or added) to the front of the history, which keeps at most `max` entries.
fn push_recent(mut list: Vec<String>, path: &str, max: usize) -> Vec<String> {
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(max);
    list
}

/// Opens `path` next time MyNote starts, and puts it first in the workspace history.
fn remember_vault(app: &AppHandle, path: &Path) {
    let mut config = read_config(app);
    let path = path.to_string_lossy().into_owned();
    let recent = push_recent(recent_paths(&config), &path, RECENT_WORKSPACES);
    config.insert("vault".into(), path.into());
    config.insert("recent".into(), recent.into());
    write_config(app, config);
}

/// Small bits of per-machine UI state (e.g. Recents) that must survive a quit or a crash. They live in
/// the app's config folder, not the workspace, so they never show up in the workspace's git history.
fn ui_state_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("ui-state.json"))
}

fn read_ui_state(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    ui_state_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

#[tauri::command]
fn ui_state_get(app: AppHandle, key: String) -> Option<String> {
    read_ui_state(&app).get(&key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Writes through a temporary file and a rename, so a crash mid-write can't leave it half written.
#[tauri::command]
fn ui_state_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let file = ui_state_file(&app).ok_or("no config folder")?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut state = read_ui_state(&app);
    state.insert(key, serde_json::Value::String(value));
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::Value::Object(state).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

fn info(path: &Path) -> VaultInfo {
    VaultInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map_or("Vault".into(), |n| n.to_string_lossy().into_owned()),
    }
}

/// Opens (creating and seeding if needed) a vault and starts watching it.
fn activate(app: &AppHandle, state: &AppState, path: PathBuf, remember: bool) -> Result<VaultInfo, String> {
    let fresh = !path.exists() || std::fs::read_dir(&path).map_err(|e| e.to_string())?.next().is_none();
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if fresh {
        seed::seed(&path)?;
    }
    vault::migrate_legacy_dir(&path).map_err(|e| format!("couldn't rename the workspace's {} folder: {e}", vault::LEGACY_DIR))?;
    vault::migrate_assets_dir(&path).map_err(|e| format!("couldn't move the workspace's attached files into their pages' _assets folders: {e}"))?;
    git::ensure_repo(&path)?;

    let handle = app.clone();
    let shared = state.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.kind.is_access() {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| !p.components().any(|c| c.as_os_str() == ".git"))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if paths.is_empty() {
            return;
        }
        *shared.pending.lock().unwrap() = Some(Instant::now());
        *shared.last_change.lock().unwrap() = Some(Instant::now());
        // What a sync itself brings in isn't a change to send back.
        if !shared.syncing.load(Ordering::SeqCst) {
            shared.changed_since_sync.store(true, Ordering::SeqCst);
        }
        let _ = handle.emit("vault-changed", paths);
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&path, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    *state.watcher.lock().unwrap() = Some(watcher);
    *state.vault.lock().unwrap() = Some(path.clone());
    if remember {
        remember_vault(app, &path);
    }
    library::load(app, &state.library, &path);
    Ok(info(&path))
}

/// Commits what changed, then pulls and pushes (see `git::sync_merging`): one sync at a time.
fn run_sync(app: &AppHandle, state: &AppState, path: &Path) -> Result<mynote_core::git_lib::Integrated, String> {
    let _one = state.sync_lock.lock().unwrap_or_else(|e| e.into_inner());
    state.syncing.store(true, Ordering::SeqCst);
    state.changed_since_sync.store(false, Ordering::SeqCst);
    *state.last_sync.lock().unwrap() = Some(Instant::now());
    let result = (|| {
        if let Some(m) = git::auto_message(path) {
            git::commit_all(path, &m)?;
        }
        *state.pending.lock().unwrap() = None;
        git::sync_merging(path)
    })();
    state.syncing.store(false, Ordering::SeqCst);
    match &result {
        Ok(done) => {
            let _ = app.emit("git-synced", done);
        }
        Err(e) => {
            let _ = app.emit("git-sync-failed", e);
        }
    }
    result
}

/// Keeps every device in step without anyone pressing Sync: when the workspace has a remote and
/// its pages have been left alone a while, syncs every so often, and soon after local changes.
fn spawn_autosync(app: AppHandle, state: AppState) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let Some(every) = *state.autosync.lock().unwrap() else { continue };
        let quiet = state.last_change.lock().unwrap().is_none_or(|t| t.elapsed() >= SYNC_QUIET);
        let since = *state.last_sync.lock().unwrap();
        let due = since.is_none_or(|t| t.elapsed() >= every) || state.changed_since_sync.load(Ordering::SeqCst);
        if !quiet || !due {
            continue;
        }
        let Some(path) = state.vault.lock().unwrap().clone() else { continue };
        if !git::has_remote(&path) {
            // Nothing to sync with; look again next round.
            *state.last_sync.lock().unwrap() = Some(Instant::now());
            state.changed_since_sync.store(false, Ordering::SeqCst);
            continue;
        }
        let _ = run_sync(&app, &state, &path);
    });
}

fn spawn_autocommit(app: AppHandle, state: AppState) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let Some(idle) = *state.autocommit.lock().unwrap() else { continue };
        let due = matches!(*state.pending.lock().unwrap(), Some(t) if t.elapsed() >= idle);
        if !due {
            continue;
        }
        *state.pending.lock().unwrap() = None;
        let Some(path) = state.vault.lock().unwrap().clone() else { continue };
        if let Some(message) = git::auto_message(&path) {
            if let Ok(Some(hash)) = git::commit_all(&path, &message) {
                let _ = app.emit("git-committed", hash);
            }
        }
    });
}

#[tauri::command]
fn current_vault(app: AppHandle, state: State<AppState>) -> Result<VaultInfo, String> {
    if let Ok(path) = vault(&state) {
        return Ok(info(&path));
    }
    // MYNOTE_WORKSPACE (also read by the MCP server) overrides the saved workspace for this run only.
    // Legacy names (before the rename to MyNote): BETELGEUSE_WORKSPACE, BETELGEUSE_VAULT.
    let env = ["MYNOTE_WORKSPACE", "MYNOTE_VAULT", "BETELGEUSE_WORKSPACE", "BETELGEUSE_VAULT"];
    if let Some(path) = env.iter().find_map(|k| std::env::var_os(k).filter(|v| !v.is_empty())) {
        return activate(&app, &state, PathBuf::from(path), false);
    }
    let path = saved_vault(&app)
        .or_else(|| dirs::home_dir().map(|h| h.join("MyNote")))
        .ok_or("could not determine a workspace location")?;
    activate(&app, &state, path, true)
}

#[tauri::command]
fn open_vault(app: AppHandle, state: State<AppState>, path: String) -> Result<VaultInfo, String> {
    activate(&app, &state, PathBuf::from(path), true)
}

#[derive(Serialize)]
struct RecentWorkspace {
    path: String,
    name: String,
    /// The path with the home folder shortened to `~`, for display.
    display: String,
    /// The folder still exists (it may have been moved, deleted, or be on a disconnected drive).
    exists: bool,
}

/// The workspace history, newest first (the open workspace included).
#[tauri::command]
fn recent_workspaces(app: AppHandle) -> Vec<RecentWorkspace> {
    let home = dirs::home_dir();
    recent_paths(&read_config(&app))
        .into_iter()
        .map(|path| {
            let p = Path::new(&path);
            let display = match home.as_deref().and_then(|h| p.strip_prefix(h).ok()) {
                Some(rest) => format!("~/{}", rest.to_string_lossy()),
                None => path.clone(),
            };
            RecentWorkspace { name: info(p).name, exists: p.is_dir(), display, path }
        })
        .collect()
}

/// Removes a folder from the workspace history (the folder itself isn't touched).
#[tauri::command]
fn forget_workspace(app: AppHandle, path: String) {
    let mut config = read_config(&app);
    let recent: Vec<String> = recent_paths(&config).into_iter().filter(|p| *p != path).collect();
    config.insert("recent".into(), recent.into());
    write_config(&app, config);
}

#[tauri::command]
fn list_notes(state: State<AppState>) -> Result<Vec<vault::NoteMeta>, String> {
    Ok(vault::list_notes(&vault(&state)?))
}

#[tauri::command]
fn read_note(state: State<AppState>, path: String) -> Result<String, String> {
    vault::read_note(&vault(&state)?, &path)
}

#[tauri::command]
fn write_note(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    vault::write_note(&vault(&state)?, &path, &content)
}

#[tauri::command]
fn create_note(state: State<AppState>, parent: Option<String>, title: String) -> Result<String, String> {
    vault::create_note(&vault(&state)?, parent.as_deref(), &title)
}

#[tauri::command]
fn database_rows(state: State<AppState>, path: String) -> Result<Vec<vault::Row>, String> {
    vault::database_rows(&vault(&state)?, &path)
}

#[tauri::command]
fn duplicate_note(state: State<AppState>, path: String) -> Result<String, String> {
    vault::duplicate_note(&vault(&state)?, &path)
}

/// Saves an uploaded image (icon, pasted picture, diagram) in `page`'s attachment folder, or the
/// workspace's `_assets/` without one.
#[tauri::command]
fn save_asset(state: State<AppState>, name: String, bytes: Vec<u8>, page: Option<String>) -> Result<String, String> {
    vault::save_asset(&vault(&state)?, page.as_deref().filter(|p| !p.is_empty()), &name, &bytes)
}

/// Returns raw bytes (an ArrayBuffer in JS) rather than a JSON number array.
#[tauri::command]
fn read_asset(state: State<AppState>, path: String) -> Result<tauri::ipc::Response, String> {
    vault::read_asset(&vault(&state)?, &path).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn write_asset(state: State<AppState>, path: String, bytes: Vec<u8>) -> Result<(), String> {
    vault::write_asset(&vault(&state)?, &path, &bytes)
}

/// Saves an attached text file edited in its tab (`write_asset` for text, without a list of numbers).
#[tauri::command]
fn write_asset_text(state: State<AppState>, path: String, text: String) -> Result<(), String> {
    vault::write_asset(&vault(&state)?, &path, text.as_bytes())
}

/// Copies a file picked on disk into `page`'s attachment folder; returns its vault path.
#[tauri::command]
fn attach_file(state: State<AppState>, path: String, page: Option<String>) -> Result<String, String> {
    vault::copy_attachment(&vault(&state)?, page.as_deref(), Path::new(&path))
}

/// Saves a dropped or pasted file in its page's attachment folder. Its bytes are the raw request body
/// (a JSON list of numbers would be slow for big files); its name and page come percent-encoded in
/// the `x-file-name` and `x-page` headers.
#[tauri::command]
fn attach_bytes(state: State<AppState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(percent_decode);
    let page = header("x-page").filter(|p| !p.is_empty());
    vault::save_attachment(&vault(&state)?, page.as_deref(), &header("x-file-name").unwrap_or_default(), bytes)
}

/// Decodes `%XX` escapes (what JS's `encodeURIComponent` makes); anything else is kept as is.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A workspace file's size in bytes, or nothing when it isn't there. An attached file whose link
/// came back (undone, or pasted on another page) is brought back from the Trash first.
#[tauri::command]
fn file_size(state: State<AppState>, path: String) -> Option<u64> {
    let vault = vault(&state).ok()?;
    vault::restore_attachment(&vault, &path);
    vault::file_size(&vault, &path)
}

/// Opens an attached file (in an `_assets/` folder) in its default app, or with `reveal`, shows it in Finder.
#[tauri::command]
fn open_attachment(app: AppHandle, state: State<AppState>, path: String, reveal: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !vault::in_assets(&path) {
        return Err("Only attached files can be opened.".into());
    }
    let vault = vault(&state)?;
    vault::restore_attachment(&vault, &path);
    let abs = vault::resolve(&vault, &path)?;
    if !abs.is_file() {
        return Err("This file isn't in the workspace any more.".into());
    }
    let opened = if reveal { app.opener().reveal_item_in_dir(abs) } else { app.opener().open_path(abs.to_string_lossy(), None::<String>) };
    opened.map_err(|e| e.to_string())
}

/// Moves an attached file whose link left `page` to the Trash (and removes folders that leaves
/// empty), unless other pages still link to it: then it's kept and their titles come back.
#[tauri::command]
fn delete_attachment(state: State<AppState>, path: String, page: String) -> Result<Vec<String>, String> {
    vault::delete_attachment(&vault(&state)?, &path, &page)
}

#[tauri::command]
fn rename_note(state: State<AppState>, path: String, title: String) -> Result<String, String> {
    vault::rename_note(&vault(&state)?, &path, &title)
}

/// Moves a page (and its sub-pages) under another page, or to the top level (`dest` "").
#[tauri::command]
fn move_note(state: State<AppState>, path: String, dest: String) -> Result<String, String> {
    vault::move_note(&vault(&state)?, &path, &dest)
}

/// Moves a page to the trash; returns the trash id (for Undo).
#[tauri::command]
fn delete_note(state: State<AppState>, path: String) -> Result<String, String> {
    vault::delete_note(&vault(&state)?, &path)
}

#[tauri::command]
fn list_trash(state: State<AppState>) -> Result<Vec<vault::TrashItem>, String> {
    Ok(vault::list_trash(&vault(&state)?))
}

#[tauri::command]
fn restore_trash(state: State<AppState>, id: String) -> Result<String, String> {
    vault::restore_trash(&vault(&state)?, &id)
}

#[tauri::command]
fn purge_trash(state: State<AppState>, id: Option<String>) -> Result<(), String> {
    vault::purge_trash(&vault(&state)?, id.as_deref())
}

#[tauri::command]
fn search_notes(state: State<AppState>, query: String) -> Result<Vec<vault::SearchHit>, String> {
    Ok(vault::search(&vault(&state)?, &query))
}

#[tauri::command]
fn backlinks(state: State<AppState>, path: String) -> Result<Vec<vault::NoteMeta>, String> {
    Ok(vault::backlinks(&vault(&state)?, &path))
}

#[tauri::command]
fn git_status(state: State<AppState>) -> Result<git::RepoStatus, String> {
    git::status(&vault(&state)?)
}

#[tauri::command]
fn git_commit(state: State<AppState>, message: Option<String>) -> Result<Option<String>, String> {
    let path = vault(&state)?;
    let message = message.filter(|m| !m.trim().is_empty()).or_else(|| git::auto_message(&path));
    *state.pending.lock().unwrap() = None;
    match message {
        Some(m) => git::commit_all(&path, &m),
        None => Ok(None),
    }
}

#[tauri::command]
fn git_log(state: State<AppState>, path: Option<String>, limit: Option<usize>) -> Result<Vec<git::Commit>, String> {
    git::log(&vault(&state)?, path.as_deref(), limit.unwrap_or(50))
}

#[tauri::command]
fn git_show(state: State<AppState>, rev: String, path: String) -> Result<String, String> {
    git::show(&vault(&state)?, &rev, &path)
}

#[tauri::command]
async fn git_sync(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let path = vault(&state)?;
    let state = state.inner().clone();
    let done = tauri::async_runtime::spawn_blocking(move || run_sync(&app, &state, &path)).await.map_err(|e| e.to_string())??;
    Ok(match done.conflicts.len() {
        0 => "Synced".into(),
        n => format!("Synced · {n} page{} changed here and elsewhere: both versions kept", if n == 1 { "" } else { "s" }),
    })
}

/// How often to sync unattended, in seconds (0 turns it off).
#[tauri::command]
fn set_autosync(state: State<AppState>, seconds: u64) {
    *state.autosync.lock().unwrap() = (seconds > 0).then(|| Duration::from_secs(seconds));
}

/// Syncs as soon as pages are quiet (the window came back to the front, say).
#[tauri::command]
fn git_sync_soon(state: State<AppState>) {
    let mut last = state.last_sync.lock().unwrap();
    // Not on every switch between windows: only when the last sync is a minute old.
    if last.is_some_and(|t| t.elapsed() >= Duration::from_secs(60)) {
        *last = None;
    }
}

#[tauri::command]
fn git_settings(state: State<AppState>) -> Result<git::GitSettings, String> {
    git::settings(&vault(&state)?)
}

#[tauri::command]
fn git_set_remote(state: State<AppState>, url: String) -> Result<(), String> {
    git::set_remote(&vault(&state)?, &url)
}

#[tauri::command]
fn git_set_identity(state: State<AppState>, name: String, email: String) -> Result<(), String> {
    git::set_identity(&vault(&state)?, &name, &email)
}

#[tauri::command]
fn git_test_remote(state: State<AppState>) -> Result<String, String> {
    git::test_remote(&vault(&state)?)
}

#[tauri::command]
fn git_publish(state: State<AppState>) -> Result<String, String> {
    let path = vault(&state)?;
    if let Some(m) = git::auto_message(&path) {
        git::commit_all(&path, &m)?;
    }
    git::publish(&path)
}

/// Seconds of quiet before auto-committing; 0 disables auto-commit.
#[tauri::command]
fn set_autocommit(state: State<AppState>, seconds: u64) {
    *state.autocommit.lock().unwrap() = (seconds > 0).then(|| Duration::from_secs(seconds));
}

#[tauri::command]
fn get_ai_policy(state: State<AppState>) -> Result<String, String> {
    Ok(vault::ai_policy(&vault(&state)?))
}

#[tauri::command]
fn set_ai_policy(state: State<AppState>, policy: String) -> Result<(), String> {
    vault::set_ai_policy(&vault(&state)?, &policy)
}

/// Imports a Notion export (.zip or folder) or an Obsidian vault, then commits it as one change.
#[tauri::command]
async fn import_pages(state: State<'_, AppState>, source: String, path: String) -> Result<importer::ImportReport, String> {
    let ws = vault(&state)?;
    let src = PathBuf::from(path);
    let report = tauri::async_runtime::spawn_blocking({
        let ws = ws.clone();
        move || match source.as_str() {
            "notion" => importer::import_notion(&ws, &src),
            "obsidian" => importer::import_obsidian(&ws, &src),
            other => Err(format!("unknown import source: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let label = vault::title_of(&report.root);
    git::commit_all(&ws, &format!("Import {label} ({} pages, {} databases)", report.pages, report.databases))?;
    *state.pending.lock().unwrap() = None;
    Ok(report)
}

#[tauri::command]
fn mcp_info(app: AppHandle, state: State<AppState>) -> Result<McpInfo, String> {
    // Installed apps ship the server as a bundled resource; source checkouts can also use packages/mcp/dist.
    let bundled = app.path().resolve("mcp/mynote-mcp.mjs", tauri::path::BaseDirectory::Resource).ok();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/mcp/dist/mynote-mcp.mjs");
    let server = bundled.filter(|p| p.exists()).unwrap_or(source);
    let server = server.canonicalize().unwrap_or(server);
    Ok(McpInfo {
        built: server.exists(),
        server_path: server.to_string_lossy().into_owned(),
        vault: vault(&state)?.to_string_lossy().into_owned(),
        node_path: find_node(),
    })
}

/// Apps opened from Finder don't inherit the shell's PATH (Homebrew, nvm, …), so ask a login
/// shell where `node` is. The absolute path also works in clients like Claude Desktop.
fn find_node() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell).args(["-lc", "command -v node"]).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_string();
    (out.status.success() && Path::new(&path).is_absolute()).then_some(path)
}

// The media library service.

#[tauri::command]
fn library_status(app: AppHandle, state: State<AppState>) -> library::Status {
    library::status(&app, &state.library)
}

#[tauri::command]
fn library_set_settings(app: AppHandle, state: State<AppState>, settings: library::StudioSettings) -> Result<(), String> {
    library::update_settings(&app, &state.library, settings)
}

#[tauri::command]
fn library_add_folder(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    library::add_root(&app, &state.library, &path)
}

#[tauri::command]
fn library_remove_folder(app: AppHandle, state: State<AppState>, name: String) -> Result<(), String> {
    library::remove_root(&app, &state.library, &name)
}

/// Plugins that use the library turn it on while they run.
#[tauri::command]
fn library_set_active(app: AppHandle, state: State<AppState>, on: bool) {
    library::set_active(&app, &state.library, on)
}

#[tauri::command]
fn library_rescan(app: AppHandle, state: State<AppState>) {
    library::rescan(&app, &state.library)
}

#[tauri::command]
fn library_clear_cache(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    library::clear_cache(&app, &state.library)
}

#[tauri::command]
fn library_search(state: State<AppState>, query: library::Query) -> library::SearchResult {
    library::search(&state.library, &query)
}

#[tauri::command]
fn library_folders(state: State<AppState>) -> Vec<(String, usize)> {
    library::folders(&state.library)
}

#[tauri::command]
fn library_tags(state: State<AppState>) -> Vec<(String, usize)> {
    library::tags(&state.library)
}

#[tauri::command]
fn library_set_meta(state: State<AppState>, ids: Vec<String>, patch: library::MetaPatch) -> Result<(), String> {
    library::set_meta(&state.library, &ids, &patch)
}

/// The asset's thumbnail (PNG/JPEG bytes), or an empty response when there isn't one.
#[tauri::command]
async fn library_thumbnail(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<tauri::ipc::Response, String> {
    let lib = state.library.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || library::thumbnail(&app, &lib, &id))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
}

/// Opens the file in its default app (or `with`, an app name).
#[tauri::command]
fn library_open(app: AppHandle, state: State<AppState>, id: String, with: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = library::path_of(&state.library, &id)?;
    app.opener().open_path(path.to_string_lossy(), with).map_err(|e| e.to_string())
}

#[tauri::command]
fn library_subfolders(state: State<AppState>, id: String) -> Result<Vec<String>, String> {
    library::subfolders(&state.library, &id)
}

#[tauri::command]
fn library_folder_exists(state: State<AppState>, id: String) -> bool {
    library::folder_exists(&state.library, &id)
}

/// Creates a production's project folder with the template's sub-folders; returns its id.
#[tauri::command]
fn library_create_folder(app: AppHandle, state: State<AppState>, parent: String, name: String, template: Vec<String>) -> Result<String, String> {
    library::create_folder(&app, &state.library, &parent, &name, &template)
}

#[tauri::command]
fn library_reveal(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = library::path_of(&state.library, &id)?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

// Plugins.

/// Where this app keeps plugins: its data, cache and config folders.
fn plugin_dirs(app: &AppHandle) -> plugins::Dirs {
    let path = app.path();
    let or_temp = |r: tauri::Result<PathBuf>| r.unwrap_or_else(|_| std::env::temp_dir().join("mynote"));
    plugins::Dirs { data: or_temp(path.app_data_dir()), cache: or_temp(path.app_cache_dir()), config: or_temp(path.app_config_dir()) }
}

#[tauri::command]
fn plugins_list(app: AppHandle) -> Vec<plugins::PluginInfo> {
    plugins::list(&plugin_dirs(&app))
}

/// A file from a plugin's folder (its code or styles).
#[tauri::command]
fn plugin_file(app: AppHandle, id: String, file: String) -> Result<String, String> {
    plugins::read_file(&plugin_dirs(&app), &id, &file)
}

#[tauri::command]
fn plugin_install_folder(app: AppHandle, path: String) -> Result<String, String> {
    plugins::install_folder(&plugin_dirs(&app), Path::new(&path))
}

#[tauri::command]
fn plugin_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    plugins::uninstall(&plugin_dirs(&app), &id)
}

#[tauri::command]
fn plugins_enabled(state: State<AppState>) -> Result<Vec<String>, String> {
    Ok(plugins::enabled(&vault(&state)?))
}

#[tauri::command]
fn plugins_set_enabled(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    plugins::set_enabled(&vault(&state)?, ids)
}

#[tauri::command]
fn plugin_data_get(app: AppHandle, state: State<AppState>, id: String, scope: String) -> Result<serde_json::Value, String> {
    plugins::data_get(&plugin_dirs(&app), &vault(&state)?, &id, &scope)
}

#[tauri::command]
fn plugin_data_set(app: AppHandle, state: State<AppState>, id: String, scope: String, value: serde_json::Value) -> Result<(), String> {
    plugins::data_set(&plugin_dirs(&app), &vault(&state)?, &id, &scope, value)
}

/// The plugin store's list of plugins (cached; `refresh` fetches it again).
#[tauri::command]
async fn plugin_store_index(app: AppHandle, refresh: bool) -> Result<plugin_store::Index, String> {
    tauri::async_runtime::spawn_blocking(move || plugin_store::index(&plugin_dirs(&app), refresh)).await.map_err(|e| e.to_string())?
}

/// Downloads, verifies and installs a plugin from the store; returns its id.
#[tauri::command]
async fn plugin_store_install(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || plugin_store::install(&plugin_dirs(&app), &id)).await.map_err(|e| e.to_string())?
}

/// Runs a page's shell code block in the workspace folder, streaming its output to `on_output`.
/// Returns the exit code, or `None` when it was stopped.
#[tauri::command]
async fn run_script(state: State<'_, AppState>, id: u32, language: String, script: String, on_output: tauri::ipc::Channel<String>) -> Result<Option<i32>, String> {
    let state = state.inner().clone();
    let cwd = vault(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        script::run(&state.scripts, id, &cwd, &language, &script, move |chunk| {
            let _ = on_output.send(chunk);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_script(state: State<AppState>, id: u32) {
    script::stop(&state.scripts, id)
}

/// Starts the user's shell for a terminal tab, in the workspace folder; what it prints streams to
/// `on_output` (raw bytes), and `on_exit` gets a message once it has ended. Returns the session id.
#[tauri::command]
fn terminal_open(
    state: State<AppState>,
    cols: u16,
    rows: u16,
    on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    on_exit: tauri::ipc::Channel<()>,
) -> Result<u32, String> {
    let cwd = vault(&state)?;
    state.terminals.open(
        terminal::shell_command(&cwd),
        cols,
        rows,
        move |bytes| drop(on_output.send(tauri::ipc::InvokeResponseBody::Raw(bytes))),
        move || drop(on_exit.send(())),
    )
}

#[tauri::command]
fn terminal_write(state: State<AppState>, id: u32, data: String) -> Result<(), String> {
    state.terminals.write(id, data.as_bytes())
}

#[tauri::command]
fn terminal_resize(state: State<AppState>, id: u32, cols: u16, rows: u16) {
    state.terminals.resize(id, cols, rows)
}

#[tauri::command]
fn terminal_close(state: State<AppState>, id: u32) {
    state.terminals.close(id)
}

/// The Dock icon while MyNote runs: the dark one (icons/dock-dark.png, from brand/block-icon-dark.svg)
/// for dark themes, else the app's own. Finder, Launchpad and a Dock not running MyNote show the app's
/// own icon: a per-appearance one needs an asset catalog, which only Xcode's actool can build.
#[tauri::command]
fn set_dock_icon(app: AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || {
        use objc2::{AllocAnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        let Some(mtm) = MainThreadMarker::new() else { return };
        let image = dark.then(|| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(include_bytes!("../icons/dock-dark.png")))).flatten();
        // None puts the app's own icon back.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(image.as_deref()) };
    })
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, dark);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, while nothing else runs: the login shell's PATH, so git finds gpg, ssh and helpers.
    login_path::adopt();
    // The app's folders are named after the bundle identifier, which changed in the rename.
    legacy::migrate_app_dirs();
    let state: AppState = Arc::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state.clone())
        .setup(move |app| {
            spawn_autocommit(app.handle().clone(), state.clone());
            spawn_autosync(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_vault,
            open_vault,
            recent_workspaces,
            forget_workspace,
            list_notes,
            read_note,
            write_note,
            create_note,
            database_rows,
            duplicate_note,
            save_asset,
            read_asset,
            write_asset,
            write_asset_text,
            attach_file,
            attach_bytes,
            file_size,
            open_attachment,
            delete_attachment,
            rename_note,
            move_note,
            delete_note,
            list_trash,
            restore_trash,
            purge_trash,
            search_notes,
            backlinks,
            git_status,
            git_commit,
            git_log,
            git_show,
            git_sync,
            git_settings,
            git_set_remote,
            git_set_identity,
            git_test_remote,
            git_publish,
            set_autocommit,
            set_autosync,
            git_sync_soon,
            get_ai_policy,
            ui_state_get,
            ui_state_set,
            import_pages,
            set_ai_policy,
            mcp_info,
            library_status,
            library_set_settings,
            library_add_folder,
            library_remove_folder,
            library_set_active,
            library_rescan,
            library_clear_cache,
            library_search,
            library_folders,
            library_tags,
            library_set_meta,
            library_thumbnail,
            library_open,
            library_reveal,
            library_subfolders,
            library_folder_exists,
            library_create_folder,
            plugins_list,
            plugin_file,
            plugin_install_folder,
            plugin_uninstall,
            plugins_enabled,
            plugins_set_enabled,
            plugin_data_get,
            plugin_data_set,
            plugin_store_index,
            plugin_store_install,
            run_script,
            stop_script,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            set_dock_icon
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyNote");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_history_is_newest_first_without_duplicates_and_capped() {
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Reopening one moves it to the front instead of listing it twice.
        assert_eq!(push_recent(list(&["/a", "/b", "/c"]), "/c", 10), list(&["/c", "/a", "/b"]));
        assert_eq!(push_recent(list(&[]), "/a", 10), list(&["/a"]));
        // The oldest drop off past the cap.
        assert_eq!(push_recent(list(&["/a", "/b", "/c"]), "/d", 3), list(&["/d", "/a", "/b"]));
        // A config from before the history (just "vault") has none; junk entries are skipped.
        let config = serde_json::json!({ "vault": "/a", "recent": ["/b", 3, "/c"] });
        assert_eq!(recent_paths(config.as_object().unwrap()), list(&["/b", "/c"]));
        assert!(recent_paths(serde_json::json!({ "vault": "/a" }).as_object().unwrap()).is_empty());
    }

    #[test]
    fn file_names_survive_the_header() {
        // What `encodeURIComponent` sends for names with spaces, accents and symbols.
        assert_eq!(percent_decode("Q3%20Report%20(final).pdf"), "Q3 Report (final).pdf");
        assert_eq!(percent_decode("caf%C3%A9%20menu.pdf"), "café menu.pdf");
        // Stray or broken escapes are kept as typed.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }
}
