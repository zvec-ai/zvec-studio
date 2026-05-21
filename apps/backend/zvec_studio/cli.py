"""Command-line entry point for `zvec-studio`.

Launches the FastAPI app with uvicorn on 127.0.0.1:7860 by default.
"""

from __future__ import annotations

import argparse
import sys

import uvicorn


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zvec-studio",
        description="Zvec Studio - visual management tool for the Zvec vector database.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=7860, help="Bind port (default: 7860)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload (dev only)")
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    uvicorn.run(
        "zvec_studio.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
