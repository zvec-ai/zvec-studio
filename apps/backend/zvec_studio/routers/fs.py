"""Filesystem browse endpoint.

Local-first tools (Zvec Studio runs the backend on the user's machine, even
when accessed through a browser) need a way to surface a real directory
picker in plain Web. The browser's ``showDirectoryPicker`` only exposes the
selected directory's leaf name (W3C File System Access spec, security
model), which is useless when the user wants to specify an absolute storage
path.

This router exposes a single read-only endpoint that lists *directory*
entries on the host filesystem. The frontend renders a custom modal picker
on top of it, navigating up/down the tree and returning a real absolute
path. The endpoint never reads file contents.
"""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

router = APIRouter(prefix="/fs", tags=["fs"])


class FsEntry(BaseModel):
    """A single subdirectory entry."""

    name: str = Field(..., description="Leaf name of the directory.")
    path: str = Field(..., description="Absolute path of the directory.")


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
        description="Sorted subdirectories (excludes hidden entries by default).",
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
) -> FsListing:
    """List subdirectories of ``path`` (or ``$HOME`` when omitted).

    Returns the resolved absolute path, parent path, and sorted entries.
    Files are intentionally excluded — the picker selects a directory only.
    """
    target = _resolve(path)
    entries: list[FsEntry] = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if not show_hidden and child.name.startswith("."):
                continue
            try:
                if not child.is_dir():
                    continue
            except OSError:
                # Broken symlinks / permission errors -> skip silently.
                continue
            entries.append(FsEntry(name=child.name, path=str(child)))
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
