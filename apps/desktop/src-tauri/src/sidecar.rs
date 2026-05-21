//! Python sidecar lifecycle.
//!
//! The sidecar is launched as a child process that runs the FastAPI app
//! exposed by the `zvec_studio` package. We wait for the TCP port to start
//! accepting connections before reporting readiness, and we kill the child on
//! shutdown so we never leave an orphan Python process.
//!
//! The implementation deliberately uses only `std` so no extra crates need to
//! compile (this keeps `cargo build` fast on a fresh checkout).
use std::env;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("failed to spawn sidecar process: {0}")]
    Spawn(#[source] io::Error),
    #[error("sidecar did not become ready within {0:?}")]
    Timeout(Duration),
    #[error("invalid sidecar address `{0}`")]
    InvalidAddress(String),
}

/// Configuration knobs for the Python sidecar.
///
/// All fields can be overridden via environment variables so packaging
/// scripts (Task 13) can wire the bundled binary without recompiling.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub python: String,
    pub host: String,
    pub port: u16,
    pub backend_dir: PathBuf,
    pub ready_timeout: Duration,
    pub disabled: bool,
    /// Absolute path to a frozen single-file sidecar binary (PyInstaller).
    /// When set, the shell launches this directly instead of spawning the
    /// `python -m zvec_studio.cli` development form. Populated either via
    /// the `ZVEC_SIDECAR_BINARY` env var or by `lib::resolve_bundled_sidecar`
    /// at startup when running inside a packaged Tauri bundle.
    pub bundled_binary: Option<PathBuf>,
}

impl SidecarConfig {
    /// Build a configuration from environment variables, falling back to
    /// development-friendly defaults that target the in-repo Python package.
    pub fn from_env() -> Self {
        let backend_dir = env::var("ZVEC_BACKEND_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(default_backend_dir);
        Self {
            python: env::var("ZVEC_PYTHON").unwrap_or_else(|_| "python3".into()),
            host: env::var("ZVEC_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env::var("ZVEC_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(7861),
            backend_dir,
            ready_timeout: Duration::from_secs(
                env::var("ZVEC_READY_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(20),
            ),
            disabled: env::var("ZVEC_SIDECAR_DISABLED")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            bundled_binary: env::var("ZVEC_SIDECAR_BINARY").ok().map(PathBuf::from),
        }
    }

    /// HTTP base URL the SPA should hit (`http://host:port`).
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Human-readable summary of how the sidecar will be launched. Useful
    /// for logs and the `sidecar_status` invoke command.
    pub fn launch_summary(&self) -> String {
        match &self.bundled_binary {
            Some(binary) => format!("bundled binary {binary:?}"),
            None => format!("{} -m zvec_studio.cli (dev)", self.python),
        }
    }
}

fn default_backend_dir() -> PathBuf {
    // Resolve `apps/backend` relative to the desktop crate so `cargo run`
    // works straight out of a fresh clone.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest_dir)
        .join("..")
        .join("..")
        .join("backend")
}

/// Owned handle to the running Python child process.
pub struct SidecarHandle {
    pub child: Child,
}

/// Spawn the sidecar process and wait for it to start accepting TCP
/// connections. When `disabled` is set, no process is spawned and we simply
/// wait for an externally managed backend to come up.
pub fn spawn(config: &SidecarConfig) -> Result<SidecarHandle, SidecarError> {
    if config.disabled {
        log::warn!(
            "ZVEC_SIDECAR_DISABLED=1; expecting externally managed backend on {}:{}",
            config.host,
            config.port
        );
        wait_until_ready(&config.host, config.port, config.ready_timeout)?;
        // We still want a `Child` to keep the lifetime symmetric. A no-op
        // shell process is enough -- it exits immediately and `kill()` is a
        // no-op on already-dead children.
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("true").spawn().map_err(SidecarError::Spawn)?;
        #[cfg(target_os = "windows")]
        let child = Command::new("cmd").args(["/C", "echo."]).spawn().map_err(SidecarError::Spawn)?;
        return Ok(SidecarHandle { child });
    }

    // If the port is already occupied (stale sidecar from a previous session
    // that wasn't cleaned up), attempt to kill it before spawning a fresh one.
    if is_port_open(&config.host, config.port) {
        log::warn!(
            "Port {}:{} is already occupied — killing stale process",
            config.host,
            config.port
        );
        kill_process_on_port(config.port);
        std::thread::sleep(Duration::from_millis(500));
    }

    log::info!(
        "Launching sidecar: {} on {}:{}",
        config.launch_summary(),
        config.host,
        config.port
    );

    let mut command = match &config.bundled_binary {
        Some(binary) => {
            let mut cmd = Command::new(binary);
            cmd.args(["--host", &config.host, "--port"])
                .arg(config.port.to_string());
            cmd
        }
        None => {
            let mut cmd = Command::new(&config.python);
            cmd.args(["-m", "zvec_studio.cli", "--host", &config.host, "--port"])
                .arg(config.port.to_string())
                .current_dir(&config.backend_dir);
            cmd
        }
    };
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    // Ensure CORS allows the Tauri webview origin regardless of what's baked
    // into the sidecar binary. The server is localhost-only so "*" is safe.
    command.env(
        "ZVEC_STUDIO_CORS_ORIGINS",
        r#"["*"]"#,
    );

    let child = command.spawn().map_err(SidecarError::Spawn)?;

    if let Err(err) = wait_until_ready(&config.host, config.port, config.ready_timeout) {
        // Make sure we don't leak the child if startup never finishes.
        let mut leaked = child;
        let _ = leaked.kill();
        let _ = leaked.wait();
        return Err(err);
    }

    Ok(SidecarHandle { child })
}

/// Quick non-blocking check whether a port is already accepting connections.
fn is_port_open(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    addr.parse::<SocketAddr>()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(300)).ok())
        .is_some()
}

/// Best-effort: find and kill whatever process is listening on ``port``.
#[cfg(not(target_os = "windows"))]
fn kill_process_on_port(port: u16) {
    let output = Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    if let Ok(out) = output {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid_str in pids.split_whitespace() {
            let _ = Command::new("kill")
                .args(["-9", pid_str])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_process_on_port(port: u16) {
    let output = Command::new("netstat")
        .args(["-ano"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains(&format!(":{port}")) && line.contains("LISTENING") {
                if let Some(pid) = line.split_whitespace().last() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

/// Poll the TCP port until something is accepting connections or we hit the
/// timeout. We intentionally don't speak HTTP here -- a successful TCP
/// handshake is enough proof that uvicorn has finished binding.
pub fn wait_until_ready(host: &str, port: u16, timeout: Duration) -> Result<(), SidecarError> {
    let address: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|_| SidecarError::InvalidAddress(format!("{host}:{port}")))?;
    let deadline = Instant::now() + timeout;
    loop {
        match TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            Ok(_) => return Ok(()),
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err(SidecarError::Timeout(timeout));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// Kill the sidecar child and reap it. Best-effort -- we never panic on
/// shutdown so the user always gets a clean window-close.
pub fn shutdown(mut handle: SidecarHandle) {
    if let Err(err) = handle.child.kill() {
        log::warn!("failed to kill sidecar child: {err}");
    }
    let _ = handle.child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn default_backend_dir_resolves_to_apps_backend() {
        let path = default_backend_dir();
        assert!(
            path.ends_with("backend"),
            "expected default backend dir to end with `backend`, got {path:?}"
        );
    }

    #[test]
    fn config_base_url_concatenates_host_and_port() {
        let cfg = SidecarConfig {
            python: "python3".into(),
            host: "127.0.0.1".into(),
            port: 7860,
            backend_dir: default_backend_dir(),
            ready_timeout: Duration::from_secs(1),
            disabled: false,
            bundled_binary: None,
        };
        assert_eq!(cfg.base_url(), "http://127.0.0.1:7860");
    }

    #[test]
    fn launch_summary_distinguishes_dev_and_bundled() {
        let mut cfg = SidecarConfig {
            python: "python3".into(),
            host: "127.0.0.1".into(),
            port: 7860,
            backend_dir: default_backend_dir(),
            ready_timeout: Duration::from_secs(1),
            disabled: false,
            bundled_binary: None,
        };
        assert!(cfg.launch_summary().contains("-m zvec_studio.cli"));
        cfg.bundled_binary = Some(PathBuf::from("/opt/zvec/zvec-studio-sidecar"));
        assert!(cfg.launch_summary().contains("bundled binary"));
        assert!(cfg.launch_summary().contains("zvec-studio-sidecar"));
    }

    #[test]
    fn wait_until_ready_times_out_when_port_is_silent() {
        // Port 1 is privileged on Unix and never listening in CI.
        let err = wait_until_ready("127.0.0.1", 1, Duration::from_millis(150)).unwrap_err();
        assert!(matches!(err, SidecarError::Timeout(_)), "got {err:?}");
    }

    #[test]
    fn wait_until_ready_succeeds_when_port_is_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        let result = wait_until_ready("127.0.0.1", port, Duration::from_millis(500));
        assert!(result.is_ok(), "expected ready, got {result:?}");
    }

    #[test]
    fn invalid_address_is_reported() {
        let err = wait_until_ready("not a host", 99, Duration::from_millis(50)).unwrap_err();
        assert!(
            matches!(err, SidecarError::InvalidAddress(_)),
            "got {err:?}"
        );
    }
}
