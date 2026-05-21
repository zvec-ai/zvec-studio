# Zvec Studio — Desktop Shell (Tauri v2)

The desktop shell is a thin Rust + Tauri v2 wrapper around the same React SPA
shipped on the Web, with a Python FastAPI **sidecar** spawned automatically on
launch. It targets macOS, Linux and Windows from a single codebase.

```
┌──────────────────── Tauri Window ────────────────────┐
│                                                      │
│   WebView (apps/frontend, devUrl or frontendDist)    │
│         │  fetch('/api/v1/...')                      │
│         ▼                                            │
│   Vite proxy / direct → 127.0.0.1:7860               │
│                                                      │
└─────────────┬────────────────────────────────────────┘
              │ Rust shell spawns + waits for ready
              ▼
   python -m zvec_studio.cli --host 127.0.0.1 --port 7860
        (= apps/backend FastAPI app, same as Web)
```

## Prerequisites

- **Rust ≥ 1.77** (`rustup toolchain install stable`)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** WebKit2GTK + libsoup3 + appindicator (`apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libappindicator3-dev`)
- **Windows:** WebView2 runtime (preinstalled on Win11)
- **pnpm ≥ 9**, **Node ≥ 20**, **Python ≥ 3.10**
- The backend installed in editable mode: `pip install -e apps/backend[dev]`

## Run

```sh
# from repo root
pnpm install
pnpm --filter desktop tauri:dev   # or: make desktop.dev
```

What this does, in order:

1. Vite dev server starts on `127.0.0.1:5173` (configured via `beforeDevCommand`).
2. The Rust shell starts the Python sidecar (`python3 -m zvec_studio.cli`) on
   `127.0.0.1:7860`, polling the TCP port until uvicorn binds.
3. The Tauri window opens and loads the SPA.
4. Closing the window kills the sidecar — no orphan Python processes.

### Attach to an externally managed backend

Useful when the backend is already running (e.g. `make dev.backend`) or under
a debugger:

```sh
ZVEC_SIDECAR_DISABLED=1 pnpm --filter desktop tauri:dev
```

### Configuration via environment

| Var                     | Default              | Purpose                                        |
| ----------------------- | -------------------- | ---------------------------------------------- |
| `ZVEC_PYTHON`           | `python3`            | Python interpreter used to launch the sidecar  |
| `ZVEC_HOST`             | `127.0.0.1`          | Host the sidecar binds to                      |
| `ZVEC_PORT`             | `7860`               | Port the sidecar binds to                      |
| `ZVEC_BACKEND_DIR`      | `apps/backend` (rel.)| Working directory for the spawned process      |
| `ZVEC_READY_TIMEOUT_SECS` | `20`               | How long to wait for the TCP port to open      |
| `ZVEC_SIDECAR_DISABLED` | `0`                  | If `1`/`true`, skip spawning and only wait     |
| `ZVEC_SIDECAR_BINARY`   | _(auto)_             | Absolute path to a frozen sidecar binary; takes precedence over `python -m`. Auto-detected from a sibling file next to the main exe in production bundles. |

These are deliberately **read at startup** from the OS environment so that the
Task 13 packaging scripts can inject paths to the bundled PyInstaller binary
without recompiling Rust.

## Test

```sh
make desktop.test   # cargo test --no-fail-fast
make desktop.check  # cargo fmt --check + clippy -D warnings
```

Rust unit tests cover the sidecar lifecycle (config defaults, ready-port
probe, timeout, invalid address). Frontend coverage of the Tauri runtime
helpers lives in `apps/frontend/src/lib/runtime.test.ts` and runs as part of
`make verify`.

## Build (production)

For a quick unsigned dev `.app` (no PyInstaller, expects Python on PATH at
runtime — useful only for shell smoke tests):

```sh
pnpm --filter desktop tauri:build   # or: make desktop.build
```

For a real distributable bundle (frozen sidecar + multi-target installers,
as used by `.github/workflows/release.yml`):

```sh
# Once: install PyInstaller into your backend env.
pip install -e "apps/backend[packaging]"

# 1. Freeze the FastAPI sidecar into a single-file binary and copy it to
#    apps/desktop/src-tauri/binaries/zvec-studio-sidecar-<host-triple>(.exe).
make package.sidecar

# 2. Build the Tauri bundle with the packaging-only override config
#    (which adds externalBin + extra targets without breaking dev builds).
make package.desktop

# Or both in one shot:
make package
```

Outputs land under `apps/desktop/src-tauri/target/release/bundle/`
(`*.dmg` / `*.app.tar.gz` on macOS, `*.deb` / `*.AppImage` on Linux,
`*.msi` / `*.exe` on Windows). See [`docs/PACKAGING.md`](../../docs/PACKAGING.md)
for the full architecture, the dev-vs-bundle config split, the CI matrix
(`.github/workflows/release.yml`) and the post-MVP signing plan.

## Layout

```
apps/desktop/
├── package.json           # @tauri-apps/cli + npm scripts
├── README.md              # this file
├── .gitignore             # ignores src-tauri/target & generated icons
└── src-tauri/
    ├── Cargo.toml         # tauri = "2", env_logger, thiserror, ...
    ├── build.rs           # tauri_build::build()
    ├── tauri.conf.json    # window, bundle, devUrl, frontendDist
    ├── capabilities/
    │   └── default.json   # core:default permissions only
    ├── icons/
    │   ├── README.md
    │   └── icon.png       # 512×512 placeholder (replace before T14)
    └── src/
        ├── main.rs        # exe entrypoint
        ├── lib.rs         # `run()` — Tauri builder + window-event hook
        ├── commands.rs    # `sidecar_status`, `sidecar_url`
        └── sidecar.rs     # spawn / wait_until_ready / shutdown + tests
```

## Notes / open questions

- `withGlobalTauri: true` is enabled so `apps/frontend/src/lib/runtime.ts`
  can detect the desktop runtime via `window.__TAURI_INTERNALS__` without
  pulling `@tauri-apps/api` into the Web bundle.
- The sidecar runs in dual mode: it auto-detects a frozen
  `zvec-studio-sidecar` next to the main exe (production bundles created by
  T13's `package.sidecar` + `package.desktop`); otherwise it falls back to
  `python -m zvec_studio.cli` (dev). `ZVEC_SIDECAR_BINARY` overrides both.
- The packaging-time `bundle.externalBin` setting lives in a separate
  `tauri.bundle.conf.json` so that `cargo check` / `tauri dev` don't error
  out when no host-triple binary has been built yet.
- All Rust dependencies are intentionally lean (`tauri`, `serde`, `log`,
  `env_logger`, `thiserror`) so a fresh `cargo build` stays as fast as
  possible.
