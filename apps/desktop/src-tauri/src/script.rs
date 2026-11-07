//! Runs a shell or Python code block from a page (Ctrl-E or its Run button): bash (zsh for `zsh`
//! blocks, python3 for `python`) in the workspace folder, set up like a new terminal (the user's
//! shell with its login and rc files), its output streamed back.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Scripts still running: the page's run id → the process id (its process group on Unix).
#[derive(Default)]
pub struct Running(Mutex<HashMap<u32, u32>>);

/// Whose startup files run before a block's script.
#[derive(Clone, Copy)]
enum Startup {
    /// None: the interpreter alone, with the app's own environment.
    Plain,
    /// The interpreter's own login files, as a terminal running it would (`~/.bash_profile` or
    /// `~/.profile` for bash, `~/.zprofile` and `~/.zshrc` for zsh), aliases included.
    Own,
    /// The user's shell's login files (`$SHELL`): their PATH and exports reach the interpreter.
    UserShell,
}

/// Python: `python3` as the user's shell finds it (Homebrew, pyenv, a virtualenv's), `python` on Windows.
const PYTHON: &str = if cfg!(windows) { "python" } else { "python3" };

/// How a code block's language runs: its interpreter and startup; `None` for blocks that can't run.
fn setup_for(language: &str) -> Option<(&'static str, Startup)> {
    match language {
        "bash" | "sh" => Some(("bash", Startup::Plain)),
        "bash-profile" => Some(("bash", Startup::Own)),
        "shell" => Some(("bash", Startup::UserShell)),
        "zsh" => Some(("zsh", Startup::Own)),
        // Through the user's shell's login and rc files, so it's the Python they'd get in a terminal.
        "python" | "py" => Some((PYTHON, Startup::UserShell)),
        _ => None,
    }
}

/// The user's own shell, as a new terminal would start it.
pub(crate) fn user_shell() -> String {
    let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" };
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.into())
}

/// Printed (between two U+001E) on stdout and stderr once the startup files have run.
const STARTED_TAG: &str = "mynote-started";

/// The command that runs `script` as a `language` block (`None` if that language can't run), and
/// whether its output begins with startup output to drop (up to the `STARTED_TAG` marker). With
/// startup files, it goes through the shell they belong to (`user_shell` for `Startup::UserShell`)
/// started as a login, interactive shell, so the script sees what a terminal would: that shell's
/// login and rc files, their PATH and exports, and, when the block is in that same shell, its
/// aliases and functions too. What those files print is dropped: without a terminal, many of them
/// complain (zle, prompts).
fn command(language: &str, user_shell: &str, script: &str) -> Option<(Command, bool)> {
    let (interpreter, startup) = setup_for(language)?;
    let startup_shell = match startup {
        _ if cfg!(windows) => None,
        Startup::Plain => None,
        Startup::Own => Some(interpreter),
        Startup::UserShell => Some(user_shell),
    };
    let mut cmd = match startup_shell {
        None => {
            let mut cmd = Command::new(interpreter);
            cmd.arg("-c").arg(script);
            cmd
        }
        Some(startup_shell) => {
            // After the rc files: run the script in this shell (where the aliases are; in a subshell,
            // so an `exit` doesn't make a login shell say "logout"), or hand it to the block's
            // interpreter, which inherits the environment.
            let same = Path::new(startup_shell).file_name().is_some_and(|n| n == interpreter);
            let then = if same { r#"(eval "$1")"# } else { r#"exec "$0" -c "$1""# };
            let mut cmd = Command::new(startup_shell);
            cmd.args(["-l", "-i", "-c"])
                .arg(format!(r"printf '\036{STARTED_TAG}\036'; printf '\036{STARTED_TAG}\036' >&2; {then}"))
                .args([interpreter, script]);
            cmd
        }
    };
    if interpreter == PYTHON {
        // Output as it's printed, not all at the end (Python buffers when it isn't on a terminal),
        // and in UTF-8 whatever the locale.
        cmd.env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
    }
    Some((cmd, startup_shell.is_some()))
}

/// Runs `script` and sends its output (stdout and stderr, as they come) to `out`. Returns the exit
/// code, or `None` when it was stopped by a signal.
pub fn run(running: &Running, id: u32, cwd: &Path, language: &str, script: &str, out: impl Fn(String) + Send + Sync + 'static) -> Result<Option<i32>, String> {
    let (mut cmd, startup) = command(language, &user_shell(), script).ok_or_else(|| format!("{language} code blocks can't be run."))?;
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Its own process group, so Stop also ends whatever the script started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", cmd.get_program().to_string_lossy()))?;
    running.0.lock().unwrap().insert(id, child.id());

    let out = Arc::new(out);
    let pipes: [Box<dyn Read + Send>; 2] = [Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let out = out.clone();
            std::thread::spawn(move || stream(pipe, startup, &*out))
        })
        .collect();
    let status = child.wait();
    // Stopped: signal the group again now its shell is gone. A process the shell was starting at the
    // moment of Stop (`cmd &`) can miss the first signal and would hold the output open until it ends.
    #[cfg(unix)]
    if status.as_ref().is_ok_and(|s| s.code().is_none()) {
        unsafe {
            libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
        }
    }
    for r in readers {
        let _ = r.join();
    }
    running.0.lock().unwrap().remove(&id);
    status.map(|s| s.code()).map_err(|e| e.to_string())
}

/// Forwards a pipe as text, never splitting a UTF-8 character across two chunks. With `startup`, what
/// comes before the `STARTED_TAG` marker is the shell's startup files talking and is dropped; a
/// stream that ends without the marker never got to the script, so it's all shown (it's an error).
fn stream(mut pipe: impl Read, startup: bool, out: &dyn Fn(String)) {
    let marker = format!("\u{1e}{STARTED_TAG}\u{1e}");
    let marker = marker.as_bytes();
    let mut held: Option<Vec<u8>> = startup.then(Vec::new);
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        match held.as_mut() {
            Some(startup) => {
                startup.extend_from_slice(&buf[..n]);
                let Some(at) = startup.windows(marker.len()).position(|w| w == marker) else { continue };
                pending.extend_from_slice(&startup[at + marker.len()..]);
                held = None;
            }
            None => pending.extend_from_slice(&buf[..n]),
        }
        // Keep an incomplete character at the end for the next read.
        let keep = match std::str::from_utf8(&pending) {
            Err(e) if e.error_len().is_none() => pending.len() - e.valid_up_to(),
            _ => 0,
        };
        let tail = pending.split_off(pending.len() - keep);
        if !pending.is_empty() {
            out(String::from_utf8_lossy(&pending).into_owned());
        }
        pending = tail;
    }
    pending.extend(held.unwrap_or_default());
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
        assert!(collect(&Running::default(), 1, "ruby", "puts 1").0.is_err());
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

    /// Runs `script` the way `run` does, with HOME set to a folder holding the given startup files.
    fn in_terminal_setup(language: &str, user_shell: &str, files: &[(&str, &str)], script: &str) -> (Option<i32>, String) {
        static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let run = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!("mynote-rc-{}-{run}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        for (name, text) in files {
            std::fs::write(home.join(name), text).unwrap();
        }
        let (mut cmd, startup) = command(language, user_shell, script).unwrap();
        let mut child = cmd.env("HOME", &home).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let text = Arc::new(Mutex::new(String::new()));
        for pipe in [Box::new(child.stdout.take().unwrap()) as Box<dyn Read>, Box::new(child.stderr.take().unwrap())] {
            let sink = text.clone();
            stream(pipe, startup, &move |s| sink.lock().unwrap().push_str(&s));
        }
        let code = child.wait().unwrap().code();
        let _ = std::fs::remove_dir_all(&home);
        let text = text.lock().unwrap().clone();
        (code, text)
    }

    #[test]
    fn bash_runs_plain_and_skips_every_startup_file() {
        let files = [(".bash_profile", "export MYNOTE_RC=yes\n"), (".profile", "export MYNOTE_RC=yes\n")];
        assert_eq!(in_terminal_setup("bash", "/bin/bash", &files, "echo \"[$MYNOTE_RC]\""), (Some(0), "[]\n".into()));
    }

    #[test]
    fn bash_with_profile_reads_bash_profile_with_its_aliases_and_not_its_chatter() {
        let rc = "export MYNOTE_RC=yes\nalias greet='echo hi'\necho chatter\necho chatter >&2\n";
        assert_eq!(in_terminal_setup("bash-profile", "/bin/zsh", &[(".bash_profile", rc)], "echo \"$MYNOTE_RC\"; greet; exit 4"), (Some(4), "yes\nhi\n".into()));
    }

    #[test]
    fn bash_with_profile_falls_back_to_dot_profile() {
        assert_eq!(in_terminal_setup("bash-profile", "/bin/zsh", &[(".profile", "export MYNOTE_RC=yes\n")], "echo \"$MYNOTE_RC\""), (Some(0), "yes\n".into()));
    }

    #[test]
    fn a_shell_block_inherits_the_users_shell_environment() {
        let (code, text) = in_terminal_setup("shell", "/bin/sh", &[(".profile", "export MYNOTE_RC=yes\necho chatter\n")], "echo \"$MYNOTE_RC ${BASH_VERSION:+in bash}\"");
        assert_eq!((code, text.as_str()), (Some(0), "yes in bash\n"));
    }

    #[test]
    fn a_python_block_runs_python3_with_the_users_shell_environment() {
        let script = "import os, sys\nprint(os.environ.get('MYNOTE_RC'), 'é')\nprint('err', file=sys.stderr)\nsys.exit(3)";
        let (code, text) = in_terminal_setup("python", "/bin/sh", &[(".profile", "export MYNOTE_RC=yes\necho chatter\n")], script);
        assert_eq!(code, Some(3));
        assert!(text.contains("yes é\n") && text.contains("err\n") && !text.contains("chatter"), "{text:?}");
    }

    #[test]
    fn startup_files_that_fail_before_the_script_are_shown_not_hidden() {
        let (code, text) = in_terminal_setup("shell", "/bin/sh", &[(".profile", "echo broken profile >&2\nexit 5\n")], "echo never");
        assert_eq!(code, Some(5));
        assert!(text.contains("broken profile\n") && !text.contains("never"), "{text:?}");
    }
}
