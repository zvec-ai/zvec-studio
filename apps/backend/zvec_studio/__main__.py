"""Allow ``python -m zvec_studio`` to start the FastAPI server.

This is also the canonical entry point used by PyInstaller (see
``zvec_studio.spec``) when freezing the sidecar into a single-file binary
for the desktop bundle (Task 13).
"""

from __future__ import annotations

import sys

# These imports are executed for their side effect of being statically
# discoverable by PyInstaller. ``cli.main`` calls
# ``uvicorn.run("zvec_studio.main:app", ...)`` with a *string* import path,
# which the static analyzer cannot follow — the resulting frozen binary
# would otherwise fail with ``Could not import module "zvec_studio.main"``.
import zvec_studio.main  # noqa: F401  # PyInstaller hint
from zvec_studio.cli import main

if __name__ == "__main__":  # pragma: no cover - thin re-export
    sys.exit(main())
