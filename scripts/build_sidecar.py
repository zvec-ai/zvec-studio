#!/usr/bin/env python3
"""Freeze the FastAPI sidecar into a single-file binary for Tauri (Task 13).

Pipeline
--------
1. Run PyInstaller against ``apps/backend/zvec_studio.spec`` to produce
   ``apps/backend/dist/zvec-studio-sidecar(.exe)``.
2. Detect the host's Tauri/rustc triple (e.g. ``aarch64-apple-darwin``).
3. Copy the binary into ``apps/desktop/src-tauri/binaries/`` and rename it
   to ``zvec-studio-sidecar-<triple>(.exe)`` so that
   ``bundle.externalBin: ["binaries/zvec-studio-sidecar"]`` (in
   ``tauri.bundle.conf.json``) resolves it during ``tauri build``.

Usage
-----
    python scripts/build_sidecar.py            # build for the current host
    python scripts/build_sidecar.py --skip-pyinstaller  # only re-copy
    python scripts/build_sidecar.py --triple x86_64-apple-darwin

Prereqs
-------
    pip install -e "apps/backend[packaging]"
    rustc --version           # required for triple auto-detect

This script is intentionally self-contained: only stdlib + an installed
``pyinstaller`` and ``rustc`` are required.
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "apps" / "backend"
SPEC_PATH = BACKEND_DIR / "zvec_studio.spec"
DIST_DIR = BACKEND_DIR / "dist"
BUILD_DIR = BACKEND_DIR / "build"
TARGET_DIR = REPO_ROOT / "apps" / "desktop" / "src-tauri" / "binaries"
BINARY_BASE = "zvec-studio-sidecar"


def _is_windows() -> bool:
    return platform.system().lower().startswith("win")


def detect_host_triple() -> str:
    """Return the rustc/Tauri host triple (e.g. ``aarch64-apple-darwin``)."""
    try:
        out = subprocess.check_output(
            ["rustc", "-vV"], text=True, stderr=subprocess.STDOUT
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(
            "Unable to run `rustc -vV`. Install Rust (https://rustup.rs) or "
            "pass --triple explicitly."
        ) from exc
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise SystemExit("Could not parse `host:` line from `rustc -vV` output.")


def run_pyinstaller() -> None:
    if not SPEC_PATH.exists():
        raise SystemExit(f"PyInstaller spec not found: {SPEC_PATH}")
    print(f"==> Running PyInstaller against {SPEC_PATH.relative_to(REPO_ROOT)}")
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        str(SPEC_PATH),
    ]
    subprocess.check_call(cmd, cwd=BACKEND_DIR)


def locate_built_binary() -> Path:
    candidates = [DIST_DIR / BINARY_BASE]
    if _is_windows():
        candidates.append(DIST_DIR / f"{BINARY_BASE}.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit(
        f"Built binary not found under {DIST_DIR}. Did PyInstaller succeed?"
    )


def copy_for_tauri(source: Path, triple: str) -> Path:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if source.suffix == ".exe" or _is_windows() else ""
    target = TARGET_DIR / f"{BINARY_BASE}-{triple}{suffix}"
    if target.exists():
        target.unlink()
    shutil.copy2(source, target)
    if not _is_windows():
        os.chmod(target, 0o755)
    print(f"==> Copied binary to {target.relative_to(REPO_ROOT)}")
    return target


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--triple",
        default=None,
        help="Override the rustc host triple (default: auto-detected via rustc -vV).",
    )
    parser.add_argument(
        "--skip-pyinstaller",
        action="store_true",
        help="Skip PyInstaller; just re-copy an existing dist/ binary.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    triple = args.triple or detect_host_triple()
    print(f"==> Host triple: {triple}")
    if not args.skip_pyinstaller:
        run_pyinstaller()
    binary = locate_built_binary()
    copy_for_tauri(binary, triple)
    print("==> build_sidecar.py: DONE")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
