"""Unit tests for the document wire representation (``storage/doc_repr.py``).

These cover the primary-key representation rules from
``design/import-export-design.md`` §6.2, including the regression that
motivated them: a collection whose schema declares its own scalar field
named ``id`` used to lose the real primary key.
"""

from __future__ import annotations

import pytest

from zvec_studio.exceptions import InvalidSchemaError
from zvec_studio.schemas import (
    CollectionSchema,
    FieldSchema,
    ScalarDataType,
    VectorDataType,
    VectorSchema,
)
from zvec_studio.storage.doc_repr import (
    PK_KEY,
    RESERVED_PK_KEY,
    doc_to_row,
    pk_key,
    split_pk,
)


class _FakeDoc:
    """Stand-in for ``zvec.Doc`` (id / fields / vectors triple)."""

    def __init__(
        self,
        doc_id: str,
        fields: dict[str, object] | None = None,
        vectors: dict[str, object] | None = None,
    ) -> None:
        self.id = doc_id
        self.fields = fields
        self.vectors = vectors


def _schema(*, with_id_field: bool) -> CollectionSchema:
    """Build a schema, optionally declaring a scalar field named ``id``.

    ``FieldSchema`` currently rejects the name ``id`` at validation time, but
    Zvec itself allows it — so collections created through the SDK can and do
    have such a field. ``model_construct`` bypasses validation to model that
    reality, keeping these tests independent of whatever policy the create
    path adopts.
    """
    fields = [FieldSchema(name="title", dataType=ScalarDataType.STRING)]
    if with_id_field:
        fields.insert(
            0, FieldSchema.model_construct(name="id", dataType=ScalarDataType.STRING)
        )
    return CollectionSchema.model_construct(
        name="demo",
        vectors=[
            VectorSchema(name="embedding", dataType=VectorDataType.VECTOR_FP32, dimension=2)
        ],
        fields=fields,
    )


def _schema_with_id_vector() -> CollectionSchema:
    """Schema whose *vector* is named ``id`` (Zvec allows this too).

    Zvec rejects a schema where a scalar field and a vector share a name, so
    ``id`` is either a scalar field or a vector, never both.
    """
    return CollectionSchema.model_construct(
        name="demo",
        vectors=[
            VectorSchema.model_construct(
                name="id", dataType=VectorDataType.VECTOR_FP32, dimension=2
            )
        ],
        fields=[FieldSchema(name="title", dataType=ScalarDataType.STRING)],
    )


class TestPkKey:
    def test_plain_schema_uses_id(self) -> None:
        assert pk_key(_schema(with_id_field=False)) == PK_KEY == "id"

    def test_schema_with_id_field_uses_reserved_key(self) -> None:
        assert pk_key(_schema(with_id_field=True)) == RESERVED_PK_KEY == "$id"

    def test_schema_with_id_vector_uses_reserved_key(self) -> None:
        """A vector named ``id`` shadows the primary key just as a field does."""
        assert pk_key(_schema_with_id_vector()) == RESERVED_PK_KEY


class TestDocToRow:
    def test_plain_schema_flattens_under_id(self) -> None:
        doc = _FakeDoc("doc-1", fields={"title": "hello"}, vectors={"embedding": [0.1, 0.2]})
        row = doc_to_row(doc, schema=_schema(with_id_field=False), include_vector=True)
        assert row == {"id": "doc-1", "title": "hello", "embedding": [0.1, 0.2]}

    def test_include_vector_false_omits_vectors(self) -> None:
        doc = _FakeDoc("doc-1", fields={"title": "hello"}, vectors={"embedding": [0.1, 0.2]})
        row = doc_to_row(doc, schema=_schema(with_id_field=False), include_vector=False)
        assert row == {"id": "doc-1", "title": "hello"}

    def test_id_field_does_not_shadow_primary_key(self) -> None:
        """Regression: the primary key used to be overwritten by the field."""
        doc = _FakeDoc("PK-001", fields={"id": "USER-999", "title": "t"})
        row = doc_to_row(doc, schema=_schema(with_id_field=True), include_vector=False)
        assert row == {"$id": "PK-001", "id": "USER-999", "title": "t"}

    def test_doc_without_fields_or_vectors(self) -> None:
        row = doc_to_row(_FakeDoc("doc-1"), schema=_schema(with_id_field=False), include_vector=True)
        assert row == {"id": "doc-1"}

    def test_id_vector_does_not_shadow_primary_key(self) -> None:
        doc = _FakeDoc("PK-001", fields={"title": "t"}, vectors={"id": [0.1, 0.2]})
        row = doc_to_row(doc, schema=_schema_with_id_vector(), include_vector=True)
        assert row == {"$id": "PK-001", "title": "t", "id": [0.1, 0.2]}


class TestSplitPk:
    def test_reserved_key_wins(self) -> None:
        row = {"$id": "PK-001", "id": "USER-999", "title": "t"}
        found, rest = split_pk(row, schema=_schema(with_id_field=True))
        assert found == "PK-001"
        assert rest == {"id": "USER-999", "title": "t"}

    def test_reserved_key_accepted_even_without_id_field(self) -> None:
        """Keeps exports portable across schemas that do/don't declare ``id``."""
        found, rest = split_pk({"$id": "PK-1", "title": "t"}, schema=_schema(with_id_field=False))
        assert found == "PK-1"
        assert rest == {"title": "t"}

    def test_plain_id_is_the_primary_key(self) -> None:
        found, rest = split_pk({"id": "doc-1", "title": "t"}, schema=_schema(with_id_field=False))
        assert found == "doc-1"
        assert rest == {"title": "t"}

    def test_ambiguous_id_is_rejected(self) -> None:
        """schema has an ``id`` field and the row carries only ``id``."""
        with pytest.raises(InvalidSchemaError) as exc:
            split_pk({"id": "???", "title": "t"}, schema=_schema(with_id_field=True))
        assert "$id" in str(exc.value)

    def test_ambiguous_id_vector_is_rejected(self) -> None:
        with pytest.raises(InvalidSchemaError):
            split_pk({"id": [0.1, 0.2], "title": "t"}, schema=_schema_with_id_vector())

    def test_missing_primary_key_returns_none(self) -> None:
        found, rest = split_pk({"title": "t"}, schema=_schema(with_id_field=False))
        assert found is None
        assert rest == {"title": "t"}

    def test_non_string_primary_key_is_rejected(self) -> None:
        with pytest.raises(InvalidSchemaError):
            split_pk({"id": 123, "title": "t"}, schema=_schema(with_id_field=False))

    def test_non_string_reserved_primary_key_is_rejected(self) -> None:
        with pytest.raises(InvalidSchemaError):
            split_pk({"$id": 123}, schema=_schema(with_id_field=True))

    def test_input_row_is_not_mutated(self) -> None:
        row = {"id": "doc-1", "title": "t"}
        split_pk(row, schema=_schema(with_id_field=False))
        assert row == {"id": "doc-1", "title": "t"}

    def test_explicit_null_id_means_generate(self) -> None:
        """Legacy contract: an explicit ``"id": null`` behaves like omitting
        the key — the caller mints a fresh ULID (not a 422)."""
        found, rest = split_pk({"id": None, "title": "t"}, schema=_schema(with_id_field=False))
        assert found is None
        assert rest == {"title": "t"}

    def test_explicit_null_reserved_id_means_generate(self) -> None:
        found, rest = split_pk({"$id": None, "id": "U", "title": "t"}, schema=_schema(with_id_field=True))
        assert found is None
        assert rest == {"id": "U", "title": "t"}

    def test_explicit_null_id_is_still_ambiguous_with_id_column(self) -> None:
        """A bare ``id`` — even null — stays ambiguous when the schema
        declares its own ``id`` column (could be the nullable field)."""
        with pytest.raises(InvalidSchemaError):
            split_pk({"id": None, "title": "t"}, schema=_schema(with_id_field=True))


def _schema_with_dollar_id_vector(*, with_id_field: bool = False) -> CollectionSchema:
    """A schema whose *vector* is named ``$id``.

    The Zvec engine rejects such names at create time today, but a
    hand-crafted manifest (or a future engine) could carry one — the chain
    must stay total either way. ``model_construct`` bypasses Studio's own
    validation to exercise exactly that.
    """
    fields = [FieldSchema(name="title", dataType=ScalarDataType.STRING)]
    if with_id_field:
        fields.insert(
            0, FieldSchema.model_construct(name="id", dataType=ScalarDataType.STRING)
        )
    return CollectionSchema.model_construct(
        name="demo",
        vectors=[
            VectorSchema.model_construct(
                name="$id", dataType=VectorDataType.VECTOR_FP32, dimension=2
            )
        ],
        fields=fields,
    )


class TestReservedChain:
    """The reserved key chain ``id`` -> ``$id`` -> ``$$id`` -> ..."""

    def test_dollar_id_vector_alone_does_not_take_the_plain_key(self) -> None:
        """A vector named ``$id`` occupies ``$id`` only; ``id`` stays free."""
        assert pk_key(_schema_with_dollar_id_vector()) == "id"

    def test_id_field_plus_dollar_id_vector_pushes_pk_two_levels_down(self) -> None:
        schema = _schema_with_dollar_id_vector(with_id_field=True)
        assert pk_key(schema) == "$$id"

    def test_doc_to_row_keeps_pk_and_dollar_id_vector_apart(self) -> None:
        schema = _schema_with_dollar_id_vector(with_id_field=True)
        doc = _FakeDoc(
            "PK-001", fields={"id": "USER-9", "title": "t"}, vectors={"$id": [0.1, 0.2]}
        )
        row = doc_to_row(doc, schema=schema, include_vector=True)
        assert row == {"$$id": "PK-001", "id": "USER-9", "title": "t", "$id": [0.1, 0.2]}

    def test_split_pk_separates_chain_pk_from_dollar_id_vector(self) -> None:
        schema = _schema_with_dollar_id_vector(with_id_field=True)
        row = {"$$id": "PK-001", "id": "USER-9", "$id": [0.1, 0.2], "title": "t"}
        found, rest = split_pk(row, schema=schema)
        assert found == "PK-001"
        assert rest == {"id": "USER-9", "$id": [0.1, 0.2], "title": "t"}

    def test_bare_id_still_ambiguous_when_id_column_exists(self) -> None:
        """Even with a ``$id`` vector around, a bare ``id`` cannot be
        resolved when the schema declares an ``id`` field."""
        schema = _schema_with_dollar_id_vector(with_id_field=True)
        with pytest.raises(InvalidSchemaError) as exc:
            split_pk({"id": "USER-9", "$id": [0.1, 0.2], "title": "t"}, schema=schema)
        assert exc.value.extra["primaryKeyKey"] == "$$id"

    def test_clashing_export_stays_importable_into_plain_schema(self) -> None:
        """A row carrying ``$id`` from an id-column export still resolves
        into a plain collection."""
        found, rest = split_pk(
            {"$id": "PK-009", "title": "t"}, schema=_schema(with_id_field=False)
        )
        assert found == "PK-009"
        assert rest == {"title": "t"}


class TestRoundTrip:
    @pytest.mark.parametrize("with_id_field", [False, True])
    def test_doc_to_row_then_split_pk(self, with_id_field: bool) -> None:
        fields: dict[str, object] = {"title": "t"}
        if with_id_field:
            fields["id"] = "USER-9"
        doc = _FakeDoc("PK-1", fields=fields, vectors={"embedding": [0.1, 0.2]})
        schema = _schema(with_id_field=with_id_field)

        row = doc_to_row(doc, schema=schema, include_vector=True)
        found, rest = split_pk(row, schema=schema)

        assert found == "PK-1"
        assert rest == {**fields, "embedding": [0.1, 0.2]}
