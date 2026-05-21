"""FastAPI dependency-injection helpers.

The dependencies read shared state off ``request.app.state`` so tests can
easily stub individual collaborators by overriding ``app.dependency_overrides``.
"""

from __future__ import annotations

from fastapi import Request

from zvec_studio.ai_service import AIService
from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.registry import CollectionRegistry
from zvec_studio.settings import Settings


def get_settings_dep(request: Request) -> Settings:
    """Return the Settings instance attached to the app."""
    settings: Settings = request.app.state.settings
    return settings


def get_registry_dep(request: Request) -> CollectionRegistry:
    """Return the process-local CollectionRegistry."""
    registry: CollectionRegistry = request.app.state.registry
    return registry


def get_ai_registry_dep(request: Request) -> AIFunctionRegistry:
    """Return the process-local AI function registry (CRUD store)."""
    registry: AIFunctionRegistry = request.app.state.ai_registry
    return registry


def get_ai_service_dep(request: Request) -> AIService:
    """Return the process-local AIService (embed / rerank facade)."""
    service: AIService = request.app.state.ai_service
    return service
