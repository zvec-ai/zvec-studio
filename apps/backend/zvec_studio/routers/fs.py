"""Filesystem browse endpoint.

Local-first tools (Zvec Studio runs the backend on the user's machine, even
when accessed through a browser) need a way to surface a real directory
picker in plain Web. The browser's ``showDirectoryPicker`` only exposes the
selected directory's leaf name (W3C File System Access spec, security
model), which is useless when the user wants to specify an absolute storage
path.

This router exposes a read-only listing endpoint that walks the host
filesystem for the picker UIs, navigating up/down the tree and returning
real absolute paths, plus a reveal helper. By default only directories are
listed (the collection-open picker); with ``includeFiles=true`` files appear
as well (the import file picker), optionally filtered by extension. The
endpoints never read file contents.
"""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

router = APIRouter(prefix="/fs", tags=["fs"])


class FsEntry(BaseModel):
    """A single directory (or file) entry."""

    name: str = Field(..., description="Leaf name of the entry.")
    path: str = Field(..., description="Absolute path of the entry.")
    kind: Literal["dir", "file"] = Field(
        default="dir",
        description="Entry kind. 'file' entries only appear when includeFiles is set.",
    )
    size: int | None = Field(
        default=None,
        description="Size in bytes for files; null for directories.",
    )


class FsListing(BaseModel):
    """Directory listing returned to the picker UI."""

    path: str = Field(..., description="Absolute path of the listed directory.")
    parent: str | None = Field(
        None,
        description="Absolute path of the parent directory, or null at filesystem root.",
    )
    home: str = Field(..., description="The current user's home directory (absolute).")
    entries: list[FsEntry] = Field(
        default_factory=list,
        description=(
            "Entries sorted by name (case-insensitive). Files only appear "
            "when includeFiles=true."
        ),
    )


def _resolve(raw: str | None) -> Path:
    """Resolve the requested path, defaulting to ``$HOME``.

    ``~`` is expanded; symlinks are followed. The path must exist and be a
    directory; anything else maps to a 404.
    """
    candidate = (raw or "").strip()
    target = Path(candidate).expanduser() if candidate else Path.home()
    try:
        resolved = target.resolve()
    except OSError as exc:  # e.g. permission errors crawling symlinks
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cannot resolve path: {exc}",
        ) from exc
    if not resolved.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Path does not exist: {resolved}",
        )
    if not resolved.is_dir():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a directory: {resolved}",
        )
    return resolved


class RevealRequest(BaseModel):
    """Request body for the reveal-in-file-manager endpoint."""

    path: str = Field(..., description="Absolute path to reveal in the system file manager.")


@router.post("/reveal", status_code=status.HTTP_204_NO_CONTENT)
def reveal_in_file_manager(body: RevealRequest) -> None:
    """Open the given path in the platform's file manager (Finder / Explorer / xdg-open)."""
    target = Path(body.path).expanduser().resolve()
    if not target.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Path does not exist: {target}",
        )

    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.Popen(["open", str(target)])
        elif system == "Windows":
            subprocess.Popen(["explorer", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"File manager command not found: {exc}",
        ) from exc


def _parse_extensions(raw: str | None) -> tuple[str, ...] | None:
    """Normalise a comma-separated extension filter (``.jsonl,.tar.gz``).

    Returns lowered suffixes (including multi-part ones like ``.tar.gz``),
    or None when no filter was requested.
    """
    if not raw:
        return None
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    if not parts:
        return None
    return tuple(p if p.startswith(".") else f".{p}" for p in parts)


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        # Unstatable entries still show up, just without a size.
        return None


@router.get("/list", response_model=FsListing)
def list_directory(
    path: Annotated[
        str | None,
        Query(description="Absolute path to list. Defaults to the user's home."),
    ] = None,
    show_hidden: Annotated[
        bool,
        Query(description="Include dotfile-prefixed entries when true."),
    ] = False,
    include_files: Annotated[
        bool,
        Query(
            alias="includeFiles",
            description=(
                "Also list files (not only directories). Needed by the "
                "import file picker; default keeps the legacy directory-only "
                "behaviour."
            ),
        ),
    ] = False,
    extensions: Annotated[
        str | None,
        Query(
            description=(
                "Comma-separated file-extension filter applied when "
                "includeFiles is set, e.g. '.jsonl,.tar.gz'. Directories "
                "are never filtered out (they are needed for navigation). "
                "Case-insensitive."
            ),
        ),
    ] = None,
) -> FsListing:
    """List entries of ``path`` (or ``$HOME`` when omitted).

    By default only subdirectories are returned (the original directory
    picker contract). With ``includeFiles=true`` files are listed as well,
    optionally narrowed by ``extensions``; each entry carries ``kind`` and,
    for files, ``size``.
    """
    target = _resolve(path)
    ext_filter = _parse_extensions(extensions) if include_files else None
    entries: list[FsEntry] = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if not show_hidden and child.name.startswith("."):
                continue
            try:
                is_dir = child.is_dir()
            except OSError:
                # Broken symlinks / permission errors -> skip silently.
                continue
            if is_dir:
                entries.append(FsEntry(name=child.name, path=str(child), kind="dir"))
                continue
            if not include_files:
                continue
            if ext_filter is not None and not any(
                child.name.lower().endswith(ext) for ext in ext_filter
            ):
                continue
            entries.append(
                FsEntry(
                    name=child.name,
                    path=str(child),
                    kind="file",
                    size=_file_size(child),
                )
            )
    except PermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permission denied: {exc}",
        ) from exc

    parent: str | None
    parent_candidate = target.parent
    parent = str(parent_candidate) if parent_candidate != target else None

    return FsListing(
        path=str(target),
        parent=parent,
        home=str(Path.home()),
        entries=entries,
    )
