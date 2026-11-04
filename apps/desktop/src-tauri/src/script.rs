//! Runs a shell code block from a page (Ctrl-E or its Run button): bash (zsh for `zsh` blocks) in
//! the workspace folder, with the PATH of the user's login shell, its output streamed back.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};

/// Scripts still running: the page's run id → the process id (its process group on Unix).
#[derive(Default)]
pub struct Running(Mutex<HashMap<u32, u32>>);

/// The interpreter for a code block's language; `None` for blocks that aren't shell scripts.
fn shell_for(language: &str) -> Option<&'static str> {
    match language {
        "bash" | "sh" | "shell" => Some("bash"),
        "zsh" => Some("zsh"),
        _ => None,
    }
}

/// Apps opened from Finder don't inherit the shell's PATH (Homebrew, nvm, …), so ask a login shell once.
static LOGIN_PATH: LazyLock<Option<String>> = LazyLock::new(|| {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).stdin(Stdio::null()).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
});

/// Runs `script` and sends its output (stdout and stderr, as they come) to `out`. Returns the exit
/// code, or `None` when it was stopped by a signal.
pub fn run(running: &Running, id: u32, cwd: &Path, language: &str, script: &str, out: impl Fn(String) + Send + Sync + 'static) -> Result<Option<i32>, String> {
    let shell = shell_for(language).ok_or_else(|| format!("{language} code blocks can't be run."))?;
    let mut cmd = Command::new(shell);
    cmd.arg("-c").arg(script).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = LOGIN_PATH.as_deref() {
        cmd.env("PATH", path);
    }
    // Its own process group, so Stop also ends whatever the script started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {shell}: {e}"))?;
    running.0.lock().unwrap().insert(id, child.id());

    let out = Arc::new(out);
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let out = out.clone();
            std::thread::spawn(move || stream(pipe, &*out))
        })
        .collect();
    let status = child.wait();
    for r in readers {
        let _ = r.join();
    }
    running.0.lock().unwrap().remove(&id);
    status.map(|s| s.code()).map_err(|e| e.to_string())
}

/// Forwards a pipe as text, never splitting a UTF-8 character across two chunks.
fn stream(mut pipe: impl Read, out: &dyn Fn(String)) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        // Keep an incomplete character at the end for the next read.
        let keep = match std::str::from_utf8(&pending) {
            Err(e) if e.error_len().is_none() => pending.len() - e.valid_up_to(),
            _ => 0,
        };
        let tail = pending.split_off(pending.len() - keep);
        out(String::from_utf8_lossy(&pending).into_owned());
        pending = tail;
    }
    if !pending.is_empty() {
        out(String::from_utf8_lossy(&pending).into_owned());
    }
}

/// Stops a running script and everything it started.
pub fn stop(running: &Running, id: u32) {
    let Some(pid) = running.0.lock().unwrap().get(&id).copied() else { return };
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn collect(running: &Running, id: u32, language: &str, script: &str) -> (Result<Option<i32>, String>, String) {
        let text = Arc::new(Mutex::new(String::new()));
        let sink = text.clone();
        let result = run(running, id, &std::env::temp_dir(), language, script, move |s| sink.lock().unwrap().push_str(&s));
        let text = text.lock().unwrap().clone();
        (result, text)
    }

    #[test]
    fn runs_bash_and_reports_output_and_exit_code() {
        let (code, text) = collect(&Running::default(), 1, "sh", "echo out; echo err >&2; echo é; exit 3");
        assert_eq!(code, Ok(Some(3)));
        for line in ["out\n", "err\n", "é\n"] {
            assert!(text.contains(line), "{text:?} lacks {line:?}");
        }
    }

    #[test]
    fn refuses_other_languages() {
        assert!(collect(&Running::default(), 1, "python", "print(1)").0.is_err());
    }

    #[test]
    fn stop_ends_the_script_and_its_children() {
        let running = Arc::new(Running::default());
        let r = running.clone();
        let started = Instant::now();
        let worker = std::thread::spawn(move || collect(&r, 7, "bash", "sleep 30 & sleep 30; echo never").0);
        while !running.0.lock().unwrap().contains_key(&7) {
            std::thread::sleep(Duration::from_millis(10));
        }
        stop(&running, 7);
        assert_eq!(worker.join().unwrap(), Ok(None));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
