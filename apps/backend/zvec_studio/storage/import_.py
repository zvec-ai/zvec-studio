"""Import contracts and source handling.

The pipeline itself (parse -> build -> batched write) is orchestrated by
:meth:`SdkBackend.import_documents`; this module holds the pieces that do not
need a live collection:

* the import vocabulary (modes, error policies) and report dataclasses that
  the HTTP layer serializes verbatim;
* validation of the source path, mapping filesystem problems onto the Studio
  error taxonomy (404 / 403) instead of leaking ``OSError``s as 500s.

See design doc §6.4 for the semantics of each mode and policy.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from zvec_studio.exceptions import (
    ImportFileNotFoundError,
    ImportFileNotReadableError,
)

#: Maximum number of per-row errors carried in a report; the import keeps
#: counting beyond this but only returns the first slice (the pattern is
#: enough for the user to fix their file).
MAX_REPORTED_ERRORS = 100


class ImportMode(str, Enum):
    """How incoming documents are written.

    * ``insert``  - strict: existing primary keys fail the row.
    * ``replace`` - the file's content becomes the whole document for that
      primary key (SDK-native ``upsert``). Chosen over field-level merge so
      re-importing the same file is idempotent; see design doc §6.4.
    """

    INSERT = "insert"
    REPLACE = "replace"


class OnErrorMode(str, Enum):
    """What happens when a row fails.

    * ``abort`` - stop at the first failing row (rows written so far stay).
    * ``skip``  - record the row error and continue to the end.
    """

    ABORT = "abort"
    SKIP = "skip"


@dataclass
class ImportFailure:
    """A single failing row."""

    line: int
    code: str
    message: str


@dataclass
class ImportReport:
    """Outcome of an import run (serialised as the API response)."""

    imported: int = 0
    failed: int = 0
    total_lines: int = 0
    aborted: bool = False
    duration_ms: float = 0.0
    errors: list[ImportFailure] = field(default_factory=list)
    errors_truncated: bool = False

    def add_failure(self, failure: ImportFailure) -> None:
        self.failed += 1
        if len(self.errors) < MAX_REPORTED_ERRORS:
            self.errors.append(failure)
        else:
            self.errors_truncated = True


def validate_import_source(raw_path: str | Path) -> Path:
    """Resolve *raw_path* to a readable regular file.

    Raises:
        ImportFileNotFoundError: missing path, or not a regular file.
        ImportFileNotReadableError: exists but cannot be read.
    """
    candidate = Path(raw_path).expanduser()
    if not candidate.exists() or not candidate.is_file():
        raise ImportFileNotFoundError(
            f"Import source is not a readable file: {candidate}",
            extra={"path": str(candidate)},
        )
    if not os.access(candidate, os.R_OK):
        raise ImportFileNotReadableError(
            f"Import source is not readable: {candidate}",
            extra={"path": str(candidate)},
        )
    return candidate
