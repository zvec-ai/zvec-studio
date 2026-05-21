"""Vector search endpoint."""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from zvec_studio.ai_service import AIService
from zvec_studio.deps import get_ai_service_dep
from zvec_studio.middleware.trace_id import get_trace_id
from zvec_studio.schemas import SearchRequest, SearchResponse, SearchResult
from zvec_studio.storage import SdkBackend

router = APIRouter(prefix="/collections/{name}/searches", tags=["searches"])


def _get_backend(request: Request) -> SdkBackend:
    backend: SdkBackend = request.app.state.backend
    return backend


@router.post("", response_model=SearchResponse)
def search(
    name: Annotated[str, Path(min_length=1)],
    body: SearchRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    ai_service: Annotated[AIService, Depends(get_ai_service_dep)],
    path: str | None = Query(default=None),
) -> SearchResponse:
    """ANN search.

    Metric is fixed at collection-create time on the per-vector ``indexParam``,
    so v0.2.0 no longer accepts a per-request override. ``filter`` is the raw
    Zvec SQL-WHERE expression (e.g. ``category = 'tech'``).

    The body supports:

    - ``queries`` — canonical multi-vector form with optional per-query
      ``id``, ``vector`` and index ``param`` (HNSW/IVF/HNSW_RABITQ/VAMANA).
    - ``vector`` (+ optional ``vectorField``) — legacy single-vector form,
      kept for backward compatibility.
    - ``rerankerName`` — references a reranker registered via
      ``POST /ai/rerankers``; the SDK applies it after ANN.
    """
    started = time.perf_counter()
    reranker = None
    if body.rerankerName is not None:
        reranker = ai_service.get_reranker_instance(
            body.rerankerName, topn=body.topK
        )
    resolved_name = backend.get(name, path=path).name
    hits = backend.search(
        resolved_name,
        queries=body.queries,
        legacy_vector=body.vector,
        legacy_vector_field=body.vectorField,
        top_k=body.topK,
        filter_expr=body.filter,
        output_fields=body.outputFields,
        include_vector=body.includeVector,
        reranker=reranker,
    )
    took_ms = (time.perf_counter() - started) * 1000.0
    results = [
        SearchResult(id=doc_id, score=score, fields=fields)
        for doc_id, score, fields in hits
    ]
    return SearchResponse(results=results, took_ms=took_ms, traceId=get_trace_id() or None)
