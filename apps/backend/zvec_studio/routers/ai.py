"""AI extension routers.

Exposes the persistent embedding / reranker registry and the
``:embed`` / ``:rerank`` custom verbs (AIP-136 style).

Routes
------
Embedding functions (``/ai/embeddings``):

- ``GET    /ai/embeddings``                — list all
- ``POST   /ai/embeddings``                — create
- ``GET    /ai/embeddings/{name}``         — get one
- ``PUT    /ai/embeddings/{name}``         — replace recipe (rename allowed)
- ``DELETE /ai/embeddings/{name}``         — delete
- ``POST   /ai/embeddings/{name}:embed``   — invoke

Reranker functions (``/ai/rerankers``):

- ``GET    /ai/rerankers``                 — list all
- ``POST   /ai/rerankers``                 — create
- ``GET    /ai/rerankers/{name}``          — get one
- ``PUT    /ai/rerankers/{name}``          — replace recipe (rename allowed)
- ``DELETE /ai/rerankers/{name}``          — delete
- ``POST   /ai/rerankers/{name}:rerank``   — invoke (cross-encoder only)
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, status

from zvec_studio.ai_service import AIService
from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.deps import get_ai_registry_dep, get_ai_service_dep
from zvec_studio.schemas import (
    EmbeddingFunctionListResponse,
    EmbeddingFunctionRecord,
    EmbedRequest,
    EmbedResponse,
    RerankerFunctionListResponse,
    RerankerFunctionRecord,
    RerankHit,
    RerankRequest,
    RerankResponse,
)

router = APIRouter(prefix="/ai", tags=["ai"])


# ---------------------------------------------------------------- Embeddings


@router.get("/embeddings", response_model=EmbeddingFunctionListResponse)
def list_embeddings(
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> EmbeddingFunctionListResponse:
    return EmbeddingFunctionListResponse(items=registry.list_embeddings())


@router.post(
    "/embeddings",
    response_model=EmbeddingFunctionRecord,
    status_code=status.HTTP_201_CREATED,
)
def create_embedding(
    body: EmbeddingFunctionRecord,
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> EmbeddingFunctionRecord:
    return registry.create_embedding(body)


@router.get("/embeddings/{name}", response_model=EmbeddingFunctionRecord)
def get_embedding(
    name: Annotated[str, Path(min_length=1)],
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> EmbeddingFunctionRecord:
    return registry.get_embedding(name)


@router.put("/embeddings/{name}", response_model=EmbeddingFunctionRecord)
def update_embedding(
    name: Annotated[str, Path(min_length=1)],
    body: EmbeddingFunctionRecord,
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> EmbeddingFunctionRecord:
    return registry.update_embedding(name, body)


@router.delete("/embeddings/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_embedding(
    name: Annotated[str, Path(min_length=1)],
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> None:
    registry.delete_embedding(name)


@router.post("/embeddings/{name}:embed", response_model=EmbedResponse)
def embed(
    name: Annotated[str, Path(min_length=1)],
    body: EmbedRequest,
    service: Annotated[AIService, Depends(get_ai_service_dep)],
) -> EmbedResponse:
    return service.embed(name, body)


# ----------------------------------------------------------------- Rerankers


@router.get("/rerankers", response_model=RerankerFunctionListResponse)
def list_rerankers(
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> RerankerFunctionListResponse:
    return RerankerFunctionListResponse(items=registry.list_rerankers())


@router.post(
    "/rerankers",
    response_model=RerankerFunctionRecord,
    status_code=status.HTTP_201_CREATED,
)
def create_reranker(
    body: RerankerFunctionRecord,
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> RerankerFunctionRecord:
    return registry.create_reranker(body)


@router.get("/rerankers/{name}", response_model=RerankerFunctionRecord)
def get_reranker(
    name: Annotated[str, Path(min_length=1)],
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> RerankerFunctionRecord:
    return registry.get_reranker(name)


@router.put("/rerankers/{name}", response_model=RerankerFunctionRecord)
def update_reranker(
    name: Annotated[str, Path(min_length=1)],
    body: RerankerFunctionRecord,
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> RerankerFunctionRecord:
    return registry.update_reranker(name, body)


@router.delete("/rerankers/{name}", status_code=status.HTTP_204_NO_CONTENT)
def delete_reranker(
    name: Annotated[str, Path(min_length=1)],
    registry: Annotated[AIFunctionRegistry, Depends(get_ai_registry_dep)],
) -> None:
    registry.delete_reranker(name)


@router.post("/rerankers/{name}:rerank", response_model=RerankResponse)
def rerank(
    name: Annotated[str, Path(min_length=1)],
    body: RerankRequest,
    service: Annotated[AIService, Depends(get_ai_service_dep)],
) -> RerankResponse:
    ranked = service.rerank(name, body.query, body.candidates, body.topN)
    return RerankResponse(
        results=[RerankHit(id=i, score=s, text=t) for i, s, t in ranked]
    )
