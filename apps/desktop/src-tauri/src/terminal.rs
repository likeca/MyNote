//! Terminal tabs: the user's shell (`$SHELL`, as a login shell) in a pseudo-terminal, so
//! interactive programs (vim, top, ssh, prompts) work, started in the workspace folder. What it
//! prints goes to the tab's xterm.js as raw bytes; keystrokes and the tab's size come back.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// The open terminal tabs' shells, by id.
#[derive(Default)]
pub struct Terminals {
    next: Mutex<u32>,
    sessions: Mutex<HashMap<u32, Session>>,
}

/// The user's shell as a new terminal window starts it: a login shell, in `cwd`.
pub fn shell_command(cwd: &Path) -> CommandBuilder {
    let mut cmd = if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        let mut c = CommandBuilder::new(crate::script::user_shell());
        c.arg("-l");
        c
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "MyNote");
    // Started from Finder, the app has no locale, and shells then mangle anything beyond ASCII.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

impl Terminals {
    /// Starts `cmd` in a new pseudo-terminal of `cols` × `rows`. `on_output` gets what it prints, in
    /// order; `on_exit` runs once it has ended (and its output is all sent). Returns the session's id.
    pub fn open(
        &self,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<u32, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start the shell: {e}"))?;
        // The terminal side is the child's now; keeping it open here would hide the shell's exit.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(buf[..n].to_vec()),
                }
            }
            on_exit();
        });
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        self.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, child });
        Ok(id)
    }

    /// Sends keystrokes (or pasted text) to the shell.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("This terminal has closed.")?;
        session.writer.write_all(data).and_then(|_| session.writer.flush()).map_err(|e| e.to_string())
    }

    /// Tells the shell (and what runs in it) the tab's new size.
    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(session) = self.sessions.lock().unwrap().get(&id) {
            let _ = session.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 });
        }
    }

    /// Ends the shell (the tab closed) and everything it started in the terminal.
    pub fn close(&self, id: u32) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(&id) {
            let _ = session.child.kill();
            // Dropping the pseudo-terminal hangs up on what's still attached to it.
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn runs_interactively_and_reports_the_end() {
        let terminals = Terminals::default();
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let done = tx.clone();
        let mut cmd = CommandBuilder::new("/bin/sh");
        // Reads a line from the terminal (as a prompt would), then says how wide the terminal is.
        cmd.args(["-c", "printf 'name? '; read x; printf 'hi %s, ' \"$x\"; stty size"]);
        let id = terminals.open(cmd, 100, 30, move |b| drop(tx.send(Some(b))), move || drop(done.send(None))).unwrap();
        let mut out = Vec::new();
        let mut ended = false;
        let mut typed = false;
        while !ended {
            match rx.recv_timeout(Duration::from_secs(10)).expect("the shell answers") {
                Some(bytes) => out.extend(bytes),
                None => ended = true,
            }
            if !typed && String::from_utf8_lossy(&out).contains("name? ") {
                terminals.resize(id, 120, 40);
                terminals.write(id, b"Ada\r").unwrap();
                typed = true;
            }
        }
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("hi Ada, 40 120"), "{text}");
        terminals.close(id);
        assert!(terminals.write(id, b"x").is_err(), "a closed terminal takes no input");
    }

    #[test]
    fn the_shell_starts_in_the_workspace() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let cmd = shell_command(&dir);
        assert_eq!(cmd.get_cwd().map(|c| Path::new(c).to_path_buf()), Some(dir));
        assert_eq!(cmd.get_env("TERM").and_then(|v| v.to_str()), Some("xterm-256color"));
    }
}
