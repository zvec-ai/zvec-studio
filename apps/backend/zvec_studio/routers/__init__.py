"""HTTP routers package."""

from __future__ import annotations

from zvec_studio.routers.ai import router as ai_router
from zvec_studio.routers.collections import router as collections_router
from zvec_studio.routers.documents import router as documents_router
from zvec_studio.routers.fs import router as fs_router
from zvec_studio.routers.searches import router as searches_router

__all__ = [
    "ai_router",
    "collections_router",
    "documents_router",
    "fs_router",
    "searches_router",
]
