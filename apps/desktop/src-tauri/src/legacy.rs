//! Carrying an install over from before the rename to MyNote. The bundle identifier changed from
//! `dev.devianlabs.betelgeuse` to `dev.likeca.mynote`, and Tauri names the app's folders after it, so
//! without this the saved workspace, installed plugins, plugin data and display settings would be
//! left behind under the old name.

use std::io;
use std::path::{Path, PathBuf};

/// The bundle identifier in tauri.conf.json.
const IDENTIFIER: &str = "dev.likeca.mynote";
/// Legacy name (before the rename to MyNote): the identifier the app's folders used to be named after.
const LEGACY_IDENTIFIER: &str = "dev.devianlabs.betelgeuse";

/// Moves the legacy per-app folders to the new names. Call first thing on startup, before Tauri
/// (or anything else) reads or creates them. Best effort: failures are logged and skipped.
pub fn migrate_app_dirs() {
    // The folders Tauri derives from the identifier: app config/data/local data/cache (and logs on macOS).
    let mut bases = vec![dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()];
    #[cfg(target_os = "macos")]
    bases.push(dirs::home_dir().map(|h| h.join("Library/Logs")));
    let mut seen = Vec::new();
    for new in bases.into_iter().flatten().map(|b| b.join(IDENTIFIER)) {
        if seen.contains(&new) {
            continue;
        }
        if let Err(e) = migrate(&new, false) {
            eprintln!("mynote: couldn't move the legacy app folder to {}: {e}", new.display());
        }
        seen.push(new);
    }
    // WKWebView keeps localStorage (display settings) here. Copied, not moved: WebKit may hold
    // references to its own folder, and a stale copy left behind is harmless.
    #[cfg(target_os = "macos")]
    if let Some(new) = dirs::home_dir().map(|h| h.join("Library/WebKit").join(IDENTIFIER)) {
        if let Err(e) = migrate(&new, true) {
            eprintln!("mynote: couldn't copy the legacy web data to {}: {e}", new.display());
        }
    }
}

/// The legacy counterpart of a folder named after the identifier.
fn legacy_of(new: &Path) -> Option<PathBuf> {
    (new.file_name()? == IDENTIFIER).then(|| new.with_file_name(LEGACY_IDENTIFIER))
}

/// Moves (or copies) the legacy folder to `new` when `new` doesn't exist yet. Returns whether it did.
fn migrate(new: &Path, copy: bool) -> io::Result<bool> {
    let Some(old) = legacy_of(new) else { return Ok(false) };
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    if copy {
        // Into a temporary name first, so a failed copy isn't mistaken for a finished one next launch.
        let tmp = new.with_file_name(format!(".{IDENTIFIER}-migrating"));
        let _ = std::fs::remove_dir_all(&tmp);
        copy_dir(&old, &tmp)?;
        std::fs::rename(&tmp, new)?;
    } else {
        std::fs::rename(&old, new)?;
    }
    Ok(true)
}

fn copy_dir(src: &Path, dest: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let to = dest.join(e.file_name());
        let kind = e.file_type()?;
        if kind.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else if kind.is_file() {
            std::fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_and_copies_legacy_folders() {
        let base = std::env::temp_dir().join(format!("mynote-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old, new) = (base.join(LEGACY_IDENTIFIER), base.join(IDENTIFIER));
        assert_eq!(legacy_of(&new).as_deref(), Some(old.as_path()));
        assert_eq!(legacy_of(&base.join("other")), None);

        // Nothing to migrate.
        assert!(!migrate(&new, false).unwrap());

        // Moved with its contents.
        std::fs::create_dir_all(old.join("plugins/x")).unwrap();
        std::fs::write(old.join("plugins/x/main.js"), "x").unwrap();
        assert!(migrate(&new, false).unwrap());
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(new.join("plugins/x/main.js")).unwrap(), "x");

        // An existing new folder is left alone.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "old").unwrap();
        assert!(!migrate(&new, false).unwrap());
        assert!(!new.join("settings.json").exists() && old.join("settings.json").exists());

        // Copying keeps the legacy folder.
        std::fs::remove_dir_all(&new).unwrap();
        assert!(migrate(&new, true).unwrap());
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "old");
        assert!(old.join("settings.json").exists());

        let _ = std::fs::remove_dir_all(&base);
    }
}
