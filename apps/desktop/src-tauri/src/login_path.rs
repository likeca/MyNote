//! Opened from the Dock or Finder, a macOS app gets launchd's bare PATH (`/usr/bin:/bin:/usr/sbin:
//! /sbin`), not the one the person's shell sets up. Git then misses what it calls by name: `gpg` to
//! sign commits (Homebrew's), credential helpers like `gh`, a newer `ssh`. So at startup MyNote takes
//! PATH from the user's login shell, as a new Terminal window would have it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Printed (between two U+001E) around PATH, so what the shell's startup files print is skipped.
const MARK: char = '\u{1e}';
/// A slow or stuck shell setup mustn't hold up the app: past this, it keeps the PATH it has.
const WAIT: Duration = Duration::from_secs(3);

/// Puts the login shell's PATH first, keeping the app's own entries after it. Call before any
/// thread starts (setting the environment isn't thread-safe).
pub fn adopt() {
    if cfg!(windows) {
        return;
    }
    let mut cmd = Command::new(crate::script::user_shell());
    cmd.args(["-l", "-i", "-c", &format!(r#"printf '{MARK}%s{MARK}' "$PATH""#)]);
    if let Some(login) = read(cmd) {
        let current = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", merge(&login, &current));
    }
}

/// Runs `cmd` (a shell printing its PATH between marks) and returns that PATH, or `None` if it
/// fails, prints none, or takes longer than `WAIT`.
fn read(mut cmd: Command) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < WAIT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let path = out.split(MARK).nth(1)?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// `login`'s entries, then those of `current` it lacks, each once.
fn merge(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login.split(':').chain(current.split(':')).filter(|p| !p.is_empty() && seen.insert(*p)).collect::<Vec<_>>().join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn login_path_comes_first_without_repeats() {
        assert_eq!(merge("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin::/usr/sbin"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin");
    }

    #[test]
    fn reads_the_path_a_login_shell_sets_up_and_skips_its_chatter() {
        let home = std::env::temp_dir().join(format!("mynote-login-path-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".profile"), "echo welcome\nexport PATH=\"/opt/homebrew/bin:$PATH\"\n").unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.env("HOME", &home).env("PATH", "/usr/bin:/bin").args(["-l", "-c", &format!(r#"printf '{MARK}%s{MARK}' "$PATH""#)]);
        // The profile's entry first (macOS's /etc/profile adds the system's after it), no "welcome".
        let path = read(cmd).unwrap();
        assert!(path.starts_with("/opt/homebrew/bin:") && path.contains("/usr/bin") && !path.contains("welcome"), "{path}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_shell_that_hangs_is_given_up_on() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert_eq!(read(cmd), None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
