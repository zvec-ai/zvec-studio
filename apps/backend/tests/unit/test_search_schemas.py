"""Unit tests for :mod:`zvec_studio.schemas.search` (v0.2.0).

The legacy per-request ``metric`` override was removed: metric is fixed at
collection-create time on each vector's ``indexParam``. Document ids are
always strings.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from zvec_studio.schemas import SearchRequest, SearchResponse, SearchResult


class TestSearchRequest:
    def test_defaults(self) -> None:
        req = SearchRequest(vector=[0.1, 0.2, 0.3])
        assert req.topK == 10
        assert req.filter is None
        assert req.outputFields is None
        assert req.vectorField is None
        assert req.includeVector is False

    def test_full_body_round_trip(self) -> None:
        body = {
            "vector": [0.1, 0.2],
            "topK": 25,
            "filter": "score > 0",
            "outputFields": ["title", "score"],
            "vectorField": "embedding",
            "includeVector": True,
        }
        req = SearchRequest.model_validate(body)
        dumped = req.model_dump()
        assert dumped["topK"] == 25
        assert dumped["outputFields"] == ["title", "score"]
        assert dumped["vectorField"] == "embedding"
        assert dumped["includeVector"] is True

    def test_metric_no_longer_accepted(self) -> None:
        # v0.2.0 removed per-request metric override.
        with pytest.raises(ValidationError):
            SearchRequest.model_validate({"vector": [0.1], "metric": "L2"})

    def test_top_k_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest(vector=[0.1], topK=0)

    def test_top_k_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest(vector=[0.1], topK=1_001)

    def test_vector_cannot_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest(vector=[])

    def test_rejects_unknown_field(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate({"vector": [0.1], "unexpected": True})


class TestSearchResponse:
    def test_serializes_results(self) -> None:
        resp = SearchResponse(
            results=[SearchResult(id="01H...", score=0.25, fields={"label": "a"})],
            took_ms=1.5,
            traceId="01H...",
        )
        dumped = resp.model_dump()
        assert dumped["results"][0]["id"] == "01H..."
        assert dumped["took_ms"] == 1.5
        assert dumped["traceId"] == "01H..."

    def test_id_must_be_string(self) -> None:
        # Doc.id is always str in zvec 0.4.x.
        with pytest.raises(ValidationError):
            SearchResult(id=1, score=0.0, fields={})

    def test_trace_id_is_optional(self) -> None:
        resp = SearchResponse(results=[], took_ms=0.0)
        assert resp.traceId is None
