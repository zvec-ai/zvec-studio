"""Document wire representation: ``zvec.Doc`` <-> flat row dict.

Every place that turns a document into JSON (HTTP responses, JSONL export)
or reads one back (HTTP writes, JSONL import) goes through here, so the two
directions can never drift apart.

Primary-key representation
--------------------------
A Zvec document has a primary key (``Doc.id``) that lives *beside* its
columns, and Zvec accepts a column named ``id`` (field or vector — they are
independent of the primary key), which a naive flat mapping would let shadow
the key. The row key carrying the primary key is therefore chosen from a
reserved chain:

* no column named ``id``          -> primary key sits under ``id``
* a column named ``id``           -> primary key sits under ``$id``
* a column named ``$id``          -> primary key under ``$$id``
* …and so on, prepending one more ``$`` per clash

Today the chain stops at ``$id`` in practice: the Zvec engine rejects ``$``
in column names at create time (fields via its schema regex, vectors
empirically too), and Studio enforces the same regex — so ``$id`` can never
be a user column. The deeper links are defense in depth: they keep the
mapping total for hand-crafted manifests and for any future loosening of the
engine's naming rules, so the two directions can never corrupt a key.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any, Protocol

from zvec_studio.exceptions import InvalidSchemaError

#: Row key carrying the primary key for an ordinary schema.
PK_KEY = "id"
#: First reserved fallback when a column occupies ``id``.
RESERVED_PK_KEY = "$id"
#: Keys of the reserved chain: one or more ``$`` prefixes + ``id``.
_RESERVED_KEY_RE = re.compile(r"^\$+id$")


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


def _column_names(schema: _SchemaLike) -> set[str]:
    # Field and vector names share one namespace in Zvec.
    return {c.name for c in (*schema.fields, *schema.vectors)}


def declares_id_column(schema: _SchemaLike) -> bool:
    """Return True when *schema* has a column literally named ``id``."""
    return PK_KEY in _column_names(schema)


def pk_key(schema: _SchemaLike) -> str:
    """Return the row key that carries the primary key for *schema*.

    Walks the reserved chain ``id`` -> ``$id`` -> ``$$id`` -> ... until a key
    no user column can occupy is found (see module docstring).
    """
    names = _column_names(schema)
    key = PK_KEY
    while key in names:
        key = "$" + key
    return key


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
            is ambiguous: a column occupies ``id`` (so the bare ``id`` could
            be that column) and no reserved key is present. Guessing either
            way risks silently misplacing the key.
    """
    rest = dict(row)
    names = _column_names(schema)
    key = pk_key(schema)

    # Accept any reserved-chain key the row carries (the deepest first), but
    # never one a column occupies — that value belongs to the column, not to
    # the primary key. This is independent of the target schema's own chain
    # depth, so a file exported from a clashing schema stays importable into
    # any other schema.
    reserved = sorted(
        (k for k in rest if _RESERVED_KEY_RE.match(k)), key=len, reverse=True
    )
    for candidate in reserved:
        if candidate in names:
            continue
        raw = rest.pop(candidate)
        if raw is None:
            return None, rest
        return _coerce_pk(raw, key=candidate), rest

    if PK_KEY in rest:
        if declares_id_column(schema):
            raise InvalidSchemaError(
                "Ambiguous 'id': a column occupies 'id' on this collection, so "
                f"the primary key must be given as '{key}'.",
                extra={"column": PK_KEY, "primaryKeyKey": key},
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
