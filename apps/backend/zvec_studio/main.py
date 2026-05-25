"""FastAPI application entry point.

Wires the T1 baseline: settings, CORS, traceId + JSON Lines access log
middlewares, RFC 7807 error handlers, registry, health-check routes, and a
diagnostic router used by tests to exercise the error pipeline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import zvec as _zvec
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from zvec_studio.__about__ import __version__
from zvec_studio.ai_service import AIService
from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.config_store import ConfigStore
from zvec_studio.exceptions import (
    CollectionNotFoundError,
    InvalidSchemaError,
    ZvecStudioError,
)
from zvec_studio.middleware import (
    JsonLinesAccessLogMiddleware,
    TraceIdMiddleware,
    register_error_handlers,
)
from zvec_studio.middleware.logging import configure_json_logging
from zvec_studio.registry import CollectionRegistry
from zvec_studio.routers import (
    ai_router,
    collections_router,
    documents_router,
    fs_router,
    searches_router,
)
from zvec_studio.schemas import (
    BM25Config,
    DefaultLocalDenseConfig,
    DefaultLocalSparseConfig,
    EmbeddingFunctionRecord,
    RerankerFunctionRecord,
    RrfRerankerConfig,
    WeightedRerankerConfig,
)
from zvec_studio.settings import Settings, get_settings
from zvec_studio.storage import SdkBackend


def _meta_router(version: str, zvec_version: str) -> APIRouter:
    router = APIRouter(tags=["meta"])

    @router.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Liveness probe."""
        return {"status": "ok", "version": version, "zvecVersion": zvec_version}

    @router.get("/readyz")
    async def readyz() -> dict[str, str]:
        """Readiness probe."""
        return {"status": "ready", "version": version}

    return router


def _diagnostics_router() -> APIRouter:
    """Internal routes used to exercise the error pipeline in tests.

    Kept under ``/__diag__/`` so it cannot collide with real API paths. The
    paths are deliberately not documented in public API surfaces (tags only).
    """
    router = APIRouter(prefix="/__diag__", tags=["diagnostics"], include_in_schema=False)

    @router.get("/boom/collection-not-found")
    async def _collection_not_found() -> None:
        raise CollectionNotFoundError(
            "Collection 'demo' is not open.",
            extra={"name": "demo"},
            sdk_exception="CollectionNotFoundError",
        )

    @router.get("/boom/schema")
    async def _invalid_schema() -> None:
        raise InvalidSchemaError("Vector dimension must be >= 1.")

    @router.get("/boom/generic")
    async def _zvec_generic() -> None:
        raise ZvecStudioError("Generic studio failure.", code="GENERIC_FAILURE")

    @router.get("/boom/internal")
    async def _internal() -> None:
        raise RuntimeError("unexpected failure")

    return router


_BUILTIN_EMBEDDINGS: list[EmbeddingFunctionRecord] = [
    EmbeddingFunctionRecord(
        name="local-dense",
        description="Local dense embedding (ONNX, no API key needed)",
        config=DefaultLocalDenseConfig(),
    ),
    EmbeddingFunctionRecord(
        name="local-sparse",
        description="Local sparse embedding (ONNX, no API key needed)",
        config=DefaultLocalSparseConfig(),
    ),
    EmbeddingFunctionRecord(
        name="bm25",
        description="BM25 sparse lexical embedding",
        config=BM25Config(),
    ),
]

_BUILTIN_RERANKERS: list[RerankerFunctionRecord] = [
    RerankerFunctionRecord(
        name="rrf",
        description="Reciprocal Rank Fusion — merges multiple ranked lists",
        config=RrfRerankerConfig(),
    ),
    RerankerFunctionRecord(
        name="weighted",
        description="Weighted score fusion with configurable metric",
        config=WeightedRerankerConfig(),
    ),
]


def _seed_builtins(registry: AIFunctionRegistry) -> None:
    """Register or update built-in AI functions that don't require API keys."""
    snap = registry.load()
    existing_emb = {r.name: r for r in snap.embeddings}
    existing_rr = {r.name: r for r in snap.rerankers}
    for rec in _BUILTIN_EMBEDDINGS:
        if rec.name not in existing_emb:
            registry.create_embedding(rec)
        elif existing_emb[rec.name].config != rec.config:
            registry.update_embedding(rec.name, rec)
    for rr_rec in _BUILTIN_RERANKERS:
        if rr_rec.name not in existing_rr:
            registry.create_reranker(rr_rec)
        elif existing_rr[rr_rec.name].config != rr_rec.config:
            registry.update_reranker(rr_rec.name, rr_rec)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory used by uvicorn and tests alike."""
    effective = settings or get_settings()
    configure_json_logging(effective.log_level)

    app = FastAPI(
        title="Zvec Studio API",
        version=__version__,
        description="REST API for the Zvec Studio visual management tool.",
        default_response_class=ORJSONResponse,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url=f"{effective.api_prefix}/openapi.json",
    )

    # App-scoped state (consumed by dependencies/tests).
    app.state.settings = effective
    app.state.registry = CollectionRegistry()
    app.state.backend = SdkBackend()
    app.state.config_store = ConfigStore(effective.data_dir)
    app.state.ai_registry = AIFunctionRegistry(effective.data_dir)
    _seed_builtins(app.state.ai_registry)
    app.state.ai_service = AIService(app.state.ai_registry)

    # Middleware order matters: CORS is outermost, then logging, then traceId
    # (so logging can read the generated traceId via ContextVar).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=effective.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Trace-Id"],
    )
    app.add_middleware(JsonLinesAccessLogMiddleware)
    app.add_middleware(TraceIdMiddleware)

    register_error_handlers(app)

    app.include_router(_meta_router(__version__, getattr(_zvec, "__version__", "unknown")), prefix=effective.api_prefix)
    app.include_router(collections_router, prefix=effective.api_prefix)
    app.include_router(documents_router, prefix=effective.api_prefix)
    app.include_router(fs_router, prefix=effective.api_prefix)
    app.include_router(searches_router, prefix=effective.api_prefix)
    app.include_router(ai_router, prefix=effective.api_prefix)
    app.include_router(_diagnostics_router(), prefix=effective.api_prefix)

    # Serve bundled frontend static files (populated by `make build.pip`).
    # In dev mode the directory is empty and this is a no-op.
    _static_dir = Path(__file__).parent / "static"
    _index = _static_dir / "index.html"
    if _index.exists():
        app.mount("/assets", StaticFiles(directory=_static_dir / "assets"), name="static-assets")

        # Strip leading/trailing slashes so we can compare against FastAPI's
        # path-variable form (which never carries a leading ``/``).
        _api_prefix_segment = effective.api_prefix.strip("/")

        @app.get("/{path:path}", include_in_schema=False)
        async def _spa_fallback(path: str) -> FileResponse:
            """Serve index.html for all non-API routes (SPA client-side routing).

            Requests targeting the API prefix must NOT be swallowed by the SPA
            fallback, otherwise unknown endpoints would respond with 200 +
            ``index.html`` instead of the RFC 7807 problem document. Re-raising
            ``HTTPException(404)`` lets the registered error handlers produce
            the canonical ``application/problem+json`` payload.
            """
            if _api_prefix_segment and (
                path == _api_prefix_segment
                or path.startswith(f"{_api_prefix_segment}/")
            ):
                raise HTTPException(status_code=404)
            file = _static_dir / path
            if file.is_file():
                return FileResponse(file)
            return FileResponse(_index)

    return app


def main() -> Any:  # pragma: no cover - thin CLI shim, covered via cli.main
    from zvec_studio.cli import main as _cli_main

    return _cli_main()


app: FastAPI = create_app()
