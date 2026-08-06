"""Unit tests for :mod:`zvec_studio.schemas.search` (Zvec 0.6.x).

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

    def test_accepts_sparse_legacy_vector_payload(self) -> None:
        req = SearchRequest.model_validate(
            {"vector": {"42": 1.0, "314": 0.5}, "vectorField": "sparse"}
        )

        assert req.vector == {"42": 1.0, "314": 0.5}
        assert req.vectorField == "sparse"

    def test_accepts_sparse_vector_query_payload(self) -> None:
        req = SearchRequest.model_validate(
            {"queries": [{"field": "sparse", "vector": {"42": 1.0}}]}
        )

        assert req.queries is not None
        assert req.queries[0].vector == {"42": 1.0}

    def test_accepts_fts_match_query_payload(self) -> None:
        req = SearchRequest.model_validate(
            {
                "queries": [
                    {
                        "field": "content",
                        "fts": {"matchString": "machine learning"},
                        "param": {"type": "FTS", "defaultOperator": "AND"},
                    }
                ]
            }
        )

        assert req.queries is not None
        assert req.queries[0].fts is not None
        assert req.queries[0].fts.matchString == "machine learning"

    def test_accepts_diskann_query_param_payload(self) -> None:
        req = SearchRequest.model_validate(
            {
                "queries": [
                    {
                        "field": "embedding",
                        "vector": [0.1, 0.2],
                        "param": {"type": "DISKANN", "listSize": 120},
                    }
                ]
            }
        )

        assert req.queries is not None
        assert req.queries[0].param is not None
        assert req.queries[0].param.type == "DISKANN"

    def test_fts_requires_exactly_one_text_source(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate(
                {
                    "queries": [
                        {
                            "field": "content",
                            "fts": {"matchString": "hello", "queryString": "hello"},
                        }
                    ]
                }
            )

    def test_query_requires_one_of_vector_id_or_fts(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate(
                {
                    "queries": [
                        {"field": "embedding", "vector": [0.1], "fts": {"matchString": "hello"}}
                    ]
                }
            )

    def test_fts_param_requires_fts_source(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate(
                {
                    "queries": [
                        {
                            "field": "embedding",
                            "vector": [0.1],
                            "param": {"type": "FTS", "defaultOperator": "OR"},
                        }
                    ]
                }
            )

    def test_fts_source_rejects_vector_query_param(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate(
                {
                    "queries": [
                        {
                            "field": "content",
                            "fts": {"queryString": "hello"},
                            "param": {"type": "HNSW", "ef": 10},
                        }
                    ]
                }
            )

    def test_sparse_vector_cannot_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate({"vector": {}})

    def test_rejects_unknown_field(self) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate({"vector": [0.1], "unexpected": True})

    def test_accepts_group_by_single_vector_query(self) -> None:
        req = SearchRequest.model_validate(
            {
                "queries": [{"field": "embedding", "vector": [0.1]}],
                "groupByField": "category",
                "groupCount": 5,
                "topKPerGroup": 2,
            }
        )

        assert req.groupByField == "category"
        assert req.groupCount == 5
        assert req.topKPerGroup == 2

    @pytest.mark.parametrize(
        "body",
        [
            {
                "queries": [
                    {"field": "embedding", "vector": [0.1]},
                    {"field": "other", "vector": [0.1]},
                ],
                "groupByField": "category",
            },
            {
                "queries": [{"field": "content", "fts": {"matchString": "hi"}}],
                "groupByField": "category",
            },
            {
                "queries": [{"field": "embedding", "vector": [0.1]}],
                "groupByField": "category",
                "rerankerName": "rrf",
            },
            {
                "queries": [
                    {
                        "field": "embedding",
                        "vector": [0.1],
                        "param": {"type": "HNSW", "isUsingRefiner": True},
                    }
                ],
                "groupByField": "category",
            },
        ],
    )
    def test_rejects_incompatible_group_by_modes(self, body: dict) -> None:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate(body)


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

    def test_serializes_group_by_value(self) -> None:
        result = SearchResult(
            id="doc-1",
            score=0.1,
            fields={"category": "news"},
            groupByValue="news",
        )

        assert result.model_dump()["groupByValue"] == "news"
