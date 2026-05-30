#!/usr/bin/env python3
"""Install or unpack a built Zvec Studio desktop artifact for smoke tests."""

from __future__ import annotations

import argparse
import os
import plistlib
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BUNDLE_DIR = REPO_ROOT / "apps" / "desktop" / "src-tauri" / "target" / "release" / "bundle"
DEFAULT_ARTIFACTS_DIR = REPO_ROOT / "artifacts" / "desktop-smoke"


def _run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    print(f"+ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=True, text=True, **kwargs)


def _is_windows() -> bool:
    return platform.system().lower().startswith("win")


def _is_macos() -> bool:
    return platform.system().lower() == "darwin"


def _is_linux() -> bool:
    return platform.system().lower() == "linux"


def _find_artifacts(bundle_dir: Path) -> list[Path]:
    patterns = ["*.deb", "*.AppImage", "*.dmg", "*.app.tar.gz", "*.msi", "*.exe"]
    found: list[Path] = []
    for pattern in patterns:
        found.extend(bundle_dir.rglob(pattern))
    return sorted(found)


def _choose_artifact(bundle_dir: Path, explicit: Path | None) -> Path:
    if explicit is not None:
        if not explicit.exists():
            raise SystemExit(f"Artifact does not exist: {explicit}")
        return explicit

    artifacts = _find_artifacts(bundle_dir)
    if not artifacts:
        raise SystemExit(f"No desktop artifacts found under {bundle_dir}")

    if _is_linux():
        priority = [".deb", ".AppImage"]
    elif _is_macos():
        priority = [".dmg", ".app.tar.gz"]
    elif _is_windows():
        priority = [".msi", ".exe"]
    else:
        raise SystemExit(f"Unsupported platform: {platform.system()}")

    for suffix in priority:
        for artifact in artifacts:
            if artifact.name.endswith(suffix):
                return artifact
    return artifacts[0]


def _append_github_output(app_path: Path) -> None:
    github_output = os.environ.get("GITHUB_OUTPUT")
    if not github_output:
        return
    with Path(github_output).open("a", encoding="utf-8") as fh:
        fh.write(f"app_path={app_path}\n")


def _copy_appimage(artifact: Path, install_dir: Path) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    target = install_dir / artifact.name
    shutil.copy2(artifact, target)
    target.chmod(0o755)
    return target


def _linux_bin_from_deb(artifact: Path) -> str | None:
    proc = subprocess.run(
        ["dpkg", "-c", str(artifact)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) < 6:
            continue
        archive_path = parts[-1].lstrip("./")
        if archive_path.startswith("usr/bin/") and not archive_path.endswith("/"):
            return Path(archive_path).name
    return None


def _install_linux(artifact: Path, install_dir: Path) -> Path:
    if artifact.suffix == ".AppImage":
        return _copy_appimage(artifact, install_dir)

    if artifact.suffix != ".deb":
        raise SystemExit(f"Unsupported Linux artifact: {artifact}")

    bin_name = _linux_bin_from_deb(artifact)
    sudo = shutil.which("sudo")
    cmd = ([sudo] if sudo else []) + ["apt-get", "install", "-y", str(artifact)]
    _run(cmd)

    candidates: list[Path] = []
    if bin_name:
        candidates.append(Path("/usr/bin") / bin_name)
    candidates.extend(Path("/usr/bin").glob("*zvec*"))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit(f"Installed .deb but could not find executable; bin={bin_name!r}")


def _app_executable(app_dir: Path) -> Path:
    info_plist = app_dir / "Contents" / "Info.plist"
    if info_plist.is_file():
        with info_plist.open("rb") as fh:
            info = plistlib.load(fh)
        executable = info.get("CFBundleExecutable")
        if executable:
            candidate = app_dir / "Contents" / "MacOS" / str(executable)
            if candidate.is_file():
                return candidate

    macos_dir = app_dir / "Contents" / "MacOS"
    for candidate in macos_dir.iterdir():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit(f"Could not locate executable inside {app_dir}")


def _copy_app_bundle(source: Path, install_dir: Path) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    target = install_dir / source.name
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, symlinks=True)
    return _app_executable(target)


def _install_macos(artifact: Path, install_dir: Path) -> Path:
    if artifact.name.endswith(".app.tar.gz"):
        install_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(artifact) as archive:
            archive.extractall(install_dir)
        apps = sorted(install_dir.rglob("*.app"))
        if not apps:
            raise SystemExit(f"No .app found after extracting {artifact}")
        return _app_executable(apps[0])

    if artifact.suffix != ".dmg":
        raise SystemExit(f"Unsupported macOS artifact: {artifact}")

    install_dir.mkdir(parents=True, exist_ok=True)
    mount_dir = Path(tempfile.mkdtemp(prefix="zvec-dmg-"))
    try:
        _run(["hdiutil", "attach", str(artifact), "-nobrowse", "-readonly", "-mountpoint", str(mount_dir)])
        apps = sorted(mount_dir.glob("*.app"))
        if not apps:
            raise SystemExit(f"No .app bundle found in {artifact}")
        return _copy_app_bundle(apps[0], install_dir)
    finally:
        subprocess.run(["hdiutil", "detach", str(mount_dir)], check=False)
        shutil.rmtree(mount_dir, ignore_errors=True)


def _install_windows(artifact: Path, install_dir: Path) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    if artifact.suffix.lower() == ".msi":
        _run(
            [
                "msiexec",
                "/i",
                str(artifact),
                "/qn",
                "/norestart",
                f"TARGETDIR={install_dir}",
                f"INSTALLDIR={install_dir}",
            ]
        )
    elif artifact.suffix.lower() == ".exe":
        _run([str(artifact), "/S", f"/D={install_dir}"])
    else:
        raise SystemExit(f"Unsupported Windows artifact: {artifact}")

    search_roots = [install_dir]
    for key, suffix in [
        ("LOCALAPPDATA", "Programs"),
        ("ProgramFiles", ""),
        ("ProgramFiles(x86)", ""),
    ]:
        raw = os.environ.get(key)
        if raw:
            root = Path(raw)
            search_roots.append(root / suffix if suffix else root)
    candidates: list[Path] = []
    for root in search_roots:
        if root and root.exists():
            candidates.extend(root.rglob("*Zvec*.exe"))
            candidates.extend(root.rglob("*zvec*.exe"))
    for candidate in sorted(set(candidates)):
        if candidate.is_file() and "unins" not in candidate.name.lower():
            return candidate
    raise SystemExit(f"Installed Windows artifact but could not find app exe under {search_roots}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=None, help="Installer artifact to use.")
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=DEFAULT_BUNDLE_DIR,
        help="Directory containing Tauri bundle outputs.",
    )
    parser.add_argument(
        "--install-dir",
        type=Path,
        default=DEFAULT_ARTIFACTS_DIR / "installed",
        help="Directory used for extracted/copied app bundles.",
    )
    parser.add_argument(
        "--output-file",
        type=Path,
        default=DEFAULT_ARTIFACTS_DIR / "app-path.txt",
        help="File that receives the installed app executable path.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    artifact = _choose_artifact(args.bundle_dir, args.artifact)
    print(f"==> Desktop artifact: {artifact}", flush=True)

    if _is_linux():
        app_path = _install_linux(artifact, args.install_dir)
    elif _is_macos():
        app_path = _install_macos(artifact, args.install_dir)
    elif _is_windows():
        app_path = _install_windows(artifact, args.install_dir)
    else:
        raise SystemExit(f"Unsupported platform: {platform.system()}")

    args.output_file.parent.mkdir(parents=True, exist_ok=True)
    args.output_file.write_text(f"{app_path}\n", encoding="utf-8")
    _append_github_output(app_path)
    print(f"APP_PATH={app_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
