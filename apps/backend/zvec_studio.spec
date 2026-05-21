# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Zvec Studio sidecar binary (Task 13).

Produces a single-file executable named ``zvec-studio-sidecar`` (or
``zvec-studio-sidecar.exe`` on Windows) that the Tauri desktop bundle
embeds via ``bundle.externalBin`` and launches as a child process.

Build it via ``scripts/build_sidecar.py`` (which handles the Tauri host
triple suffix); ``pyinstaller`` is invoked with this spec under the hood.
"""
from __future__ import annotations

from PyInstaller.utils.hooks import collect_submodules


# Force-include uvicorn's optional protocols/loops; PyInstaller's static
# analyzer doesn't pick them up because they're imported as strings.
# Same trick is needed for the ``zvec_studio`` package itself: cli.py calls
# ``uvicorn.run("zvec_studio.main:app", ...)`` with a string import path.
hidden_imports: list[str] = []
for pkg in (
    "zvec_studio",
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "anyio",
    "anyio._backends",
    "anyio._backends._asyncio",
):
    hidden_imports.extend(collect_submodules(pkg))

# Drop duplicates while preserving order.
seen: set[str] = set()
hidden_imports = [m for m in hidden_imports if not (m in seen or seen.add(m))]


a = Analysis(
    ["zvec_studio/__main__.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim obvious dead weight from the bundled sidecar binary.
        "tkinter",
        "matplotlib",
        "numpy.tests",
        "PIL",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="zvec-studio-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
