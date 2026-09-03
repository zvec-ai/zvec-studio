"""Document wire representation: ``zvec.Doc`` <-> flat row dict.

Every place that turns a document into JSON (HTTP responses, JSONL export)
or reads one back (HTTP writes, JSONL import) goes through here, so the two
directions can never drift apart.

Primary-key representation
--------------------------
A Zvec document has a primary key (``Doc.id``) that lives *beside* its
columns, and Zvec accepts a column named ``id`` (field or vector) which a
naive flat mapping would let shadow the key. When such a column exists the
primary key travels under the reserved key ``$id`` instead.

``$id`` cannot collide with a user column: the Zvec engine rejects ``$`` in
column names at create time (verified for fields and vectors alike), and
Studio enforces the same regex. See the design doc for the full argument.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol

from zvec_studio.exceptions import InvalidSchemaError

#: Row key carrying the primary key for an ordinary schema.
PK_KEY = "id"
#: Reserved key carrying the primary key when a column occupies ``id``.
RESERVED_PK_KEY = "$id"


class _NamedColumn(Protocol):
    name: str


class _SchemaLike(Protocol):
    """The slice of ``CollectionSchema`` this module needs.

    Declared read-only (properties rather than attributes) so structural
    matching stays covariant: the concrete SDK/Studio types carry narrower
    value types than the protocol needs to know about.
    """

    @property
    def fields(self) -> Sequence[Any]: ...

    @property
    def vectors(self) -> Sequence[Any]: ...


class _DocLike(Protocol):
    """The slice of ``zvec.Doc`` this module needs (read-only, see above)."""

    @property
    def id(self) -> str: ...

    @property
    def fields(self) -> Any: ...

    @property
    def vectors(self) -> Any: ...


def declares_id_column(schema: _SchemaLike) -> bool:
    """Return True when *schema* has a column (field or vector) named ``id``."""
    return any(c.name == PK_KEY for c in (*schema.fields, *schema.vectors))


def pk_key(schema: _SchemaLike) -> str:
    """Return the row key that carries the primary key for *schema*."""
    return RESERVED_PK_KEY if declares_id_column(schema) else PK_KEY


def doc_to_row(
    doc: _DocLike, *, schema: _SchemaLike, include_vector: bool
) -> dict[str, Any]:
    """Flatten a document into a row dict.

    The primary key is written first under :func:`pk_key`; because that key
    is never occupied by a user column, nothing can shadow it.
    """
    out: dict[str, Any] = {pk_key(schema): doc.id}
    if doc.fields:
        out.update(doc.fields)
    if include_vector and doc.vectors:
        out.update(doc.vectors)
    return out


def split_pk(
    row: dict[str, Any], *, schema: _SchemaLike
) -> tuple[str | None, dict[str, Any]]:
    """Split *row* into ``(primary key or None, remaining columns)``.

    ``None`` means the row carries no primary key and the caller should mint
    one (the SDK requires a str id; callers generate a ULID). An explicit
    ``null`` value behaves exactly like an omitted key (the historical write
    contract), so ``{"id": null}`` still auto-generates instead of failing.

    Reserved keys take precedence over a bare ``id`` and are accepted even
    when the schema does not need them, so exports stay importable across
    schema shapes.

    Raises:
        InvalidSchemaError: if the primary key is not a string, or if the row
            is ambiguous: the schema declares an ``id`` field *and* the row
            carries only ``id``, which could mean either the primary key or
            that field. Guessing either way risks silently misplacing the key.
    """
    rest = dict(row)

    if RESERVED_PK_KEY in rest:
        raw = rest.pop(RESERVED_PK_KEY)
        if raw is None:
            return None, rest
        return _coerce_pk(raw, key=RESERVED_PK_KEY), rest

    if PK_KEY in rest:
        if declares_id_column(schema):
            raise InvalidSchemaError(
                "Ambiguous 'id': this collection declares its own 'id' column, so "
                "the primary key must be given as '$id'.",
                extra={"column": PK_KEY, "primaryKeyKey": RESERVED_PK_KEY},
            )
        raw = rest.pop(PK_KEY)
        if raw is None:
            return None, rest
        return _coerce_pk(raw, key=PK_KEY), rest

    return None, rest


def _coerce_pk(raw: Any, *, key: str) -> str:
    if not isinstance(raw, str):
        raise InvalidSchemaError(
            f"Document '{key}' must be a string (Zvec requires str ids).",
            extra={key: raw},
        )
    return raw
