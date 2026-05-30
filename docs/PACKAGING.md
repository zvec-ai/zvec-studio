# Packaging & Distribution

Zvec Studio ships a desktop bundle that embeds the Python FastAPI sidecar
as a frozen single-file executable. End users only install the desktop
package — no system Python required.

## Architecture

```
[ Tauri WebView ]  --HTTP-->  [ zvec-studio-sidecar (PyInstaller binary) ]
        ^                                    ^
        |                                    |
   apps/frontend (React)            apps/backend (FastAPI)
```

At runtime the Rust shell looks for a sibling binary named
`zvec-studio-sidecar(.exe)` next to the main executable
(see [`resolve_bundled_sidecar`](../apps/desktop/src-tauri/src/lib.rs)).
If found, it spawns it as `zvec-studio-sidecar --host 127.0.0.1 --port <p>`.
Otherwise (dev mode) it falls back to `python -m zvec_studio.cli`.
The env var `ZVEC_SIDECAR_BINARY=/abs/path` overrides both.

## Local build (single host)

```bash
# 1. Install packaging extras (PyInstaller).
make install.packaging

# 2. Freeze the sidecar.
make package.sidecar
# -> apps/backend/dist/zvec-studio-sidecar
# -> apps/desktop/src-tauri/binaries/zvec-studio-sidecar-<triple>(.exe)

# 3. Build the Tauri bundle (uses tauri.bundle.conf.json overrides).
make package.desktop
# or directly:
cd apps/desktop && pnpm tauri build --config src-tauri/tauri.bundle.conf.json
```

Outputs land under `apps/desktop/src-tauri/target/release/bundle/`:

| Platform | Outputs |
|----------|---------|
| macOS    | `*.app`, `*.dmg`, `*.app.tar.gz` |
| Linux    | `*.deb`, `*.AppImage`           |
| Windows  | `*.msi`, `*.exe` (NSIS)         |

`make package` runs the sidecar build + Tauri bundle in one shot.

### macOS post-build signing

After `tauri build`, run the post-build signing script to ad-hoc sign the
bundle and recreate the DMG with an Applications symlink:

```bash
cd apps/desktop && bash scripts/post-build-sign.sh
```

This script:
1. Signs the embedded `zvec-studio-sidecar` binary inside the `.app`
2. Signs the `.app` bundle itself
3. Recreates the DMG with an Applications symlink for drag-to-install UX

The script auto-detects the architecture and finds the existing DMG produced
by Tauri, so it works on both aarch64 and x86_64 Macs.

### Windows notes

- The `.ico` icon (`icons/icon.ico`) is committed to the repo. Tauri uses it
  for the `.msi` and NSIS installer.
- Stale sidecar detection uses `netstat -ano` + `taskkill /F` on Windows
  (vs `lsof` + `kill -9` on Unix).
- No code signing is applied in the MVP. Windows SmartScreen may warn users
  on first launch — see "Signing & Notarisation" below.

### Linux notes

- System dependencies: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `patchelf`.
- Both `x86_64` and `aarch64` are built in CI (native runners).
- The `.AppImage` is self-contained; the `.deb` package integrates with
  the system package manager.

## CI matrix (`.github/workflows/release.yml`)

Triggered by `v*` tags or manual `workflow_dispatch`. Runs across:

| Job key            | Runner              | Notes                          |
|--------------------|---------------------|--------------------------------|
| `macos-aarch64`    | `macos-14`          | Apple Silicon native           |
| `macos-x86_64`     | `macos-13`          | Intel macOS                    |
| `linux-x86_64`     | `ubuntu-latest`     | needs WebKitGTK 4.1 (apt)     |
| `linux-aarch64`    | `ubuntu-24.04-arm`  | ARM64 native runner            |
| `windows-x86_64`   | `windows-latest`    | MSI + NSIS                     |

Each job uploads its installers as a job artifact (`zvec-studio-<platform>`).

On `v*` tag pushes, a final `release` job downloads all artifacts and creates
a GitHub Release with auto-generated release notes and all installer files
attached for download.

macOS runners additionally run `scripts/post-build-sign.sh` to ad-hoc sign
the `.app` and recreate the DMG.

## Tauri config split

Two configs live under `apps/desktop/src-tauri/`:

* **`tauri.conf.json`** — dev-friendly. `targets: ["app", "dmg"]`, **no**
  `externalBin`. `cargo check` / `cargo test` / `tauri dev` all run
  without the sidecar binary having to exist.
* **`tauri.bundle.conf.json`** — packaging override. Adds the full
  multi-platform `targets` list and
  `externalBin: ["binaries/zvec-studio-sidecar"]`. Tauri picks it up
  with `tauri build --config src-tauri/tauri.bundle.conf.json` and
  resolves the host-triple suffix automatically.

This split avoids the build-time error
`resource path 'binaries/zvec-studio-sidecar-<triple>' doesn't exist`
that would otherwise block dev iteration before the binary is built.

## Signing & Notarisation (post-MVP)

The MVP ships with ad-hoc signing on macOS and unsigned binaries elsewhere.
Production signing is planned:

* **macOS**: Apple Developer ID + `notarytool`. Add `signingIdentity`
  and provide `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets.
* **Windows**: code-signing certificate (EV recommended). Configure
  `tauri.bundle.conf.json` `bundle.windows.{certificateThumbprint,
  digestAlgorithm, timestampUrl}` and inject the cert via the runner's
  certificate store.
* **Linux**: detached `.sig` files alongside `.deb` / `.AppImage`,
  signed with the project GPG key.

Until those land, distribute via the GitHub Releases tab with a clear
"unsigned, may trigger Gatekeeper / SmartScreen warnings" note.

## Smoke-testing a built binary

```bash
./apps/backend/dist/zvec-studio-sidecar --host 127.0.0.1 --port 17860 &
sleep 3
curl -fsS http://127.0.0.1:17860/api/v1/healthz
kill %1
```

Expect `{"status":"ok"}`. The Rust shell itself just waits for the TCP
port to open (see [`wait_until_ready`](../apps/desktop/src-tauri/src/sidecar.rs)),
but `/api/v1/healthz` is the canonical application-level probe.

## Troubleshooting

* **`resource path 'binaries/...' doesn't exist`** — you ran `tauri build`
  without `--config tauri.bundle.conf.json`, or you forgot to run
  `python scripts/build_sidecar.py` first.
* **macOS Gatekeeper blocks the `.app`** — expected for unsigned builds.
  `xattr -dr com.apple.quarantine /Applications/Zvec\ Studio.app` to
  bypass locally.
* **Linux `libwebkit2gtk-4.1` missing** — install WebKitGTK 4.1 dev
  headers (CI does this automatically).
* **Windows SmartScreen warning** — expected for unsigned MSI/EXE.
  Click "More info" → "Run anyway".
* **Sidecar starts but `/healthz` 404s** — make sure the binary was
  rebuilt against the current backend; the spec file pulls
  `zvec_studio` via `__main__.py`.
* **Orphan sidecar process after crash** — the Rust shell kills stale
  processes on port at startup. If needed, manually kill:
  `lsof -ti :7861 | xargs kill -9` (Unix) or
  `netstat -ano | findstr :7861` + `taskkill /F /PID <pid>` (Windows).
