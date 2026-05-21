"""Compatibility constraint tests.

Validates that:
1. The runtime Python version satisfies pyproject.toml's requires-python.
2. Critical dependency versions match declared constraints.
3. Key API routes exist with expected HTTP methods (schema stability).
4. Core Pydantic models can be instantiated and serialized.
5. Environment variables used in the codebase have defaults or documentation.
"""

from __future__ import annotations

import re
import sys
from importlib.metadata import version as installed_version
from pathlib import Path
from typing import Any

import pytest
from packaging.specifiers import SpecifierSet
from packaging.version import Version

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_PYPROJECT = _BACKEND_ROOT / "pyproject.toml"


def _parse_pyproject() -> dict[str, Any]:
    """Minimal TOML parser for pyproject.toml (stdlib tomllib in 3.11+, fallback regex)."""
    text = _PYPROJECT.read_text(encoding="utf-8")
    if sys.version_info >= (3, 11):
        import tomllib

        return tomllib.loads(text)
    # Python 3.10 fallback: try tomli (bundled by pip) or do regex extraction.
    try:
        import tomli

        return tomli.loads(text)
    except ImportError:
        pass
    # Last resort: simple regex extraction for the fields we need.
    return _regex_parse_pyproject(text)


def _regex_parse_pyproject(text: str) -> dict[str, Any]:
    """Extract requires-python and dependencies via regex (Python 3.10 fallback)."""
    result: dict[str, Any] = {"project": {}}
    # requires-python
    m = re.search(r'requires-python\s*=\s*"([^"]+)"', text)
    if m:
        result["project"]["requires-python"] = m.group(1)
    # dependencies list
    dep_match = re.search(r"dependencies\s*=\s*\[(.*?)\]", text, re.DOTALL)
    if dep_match:
        deps = re.findall(r'"([^"]+)"', dep_match.group(1))
        result["project"]["dependencies"] = deps
    return result


def _parse_dep_constraint(dep_str: str) -> tuple[str, str]:
    """Extract (package_name, version_specifier_string) from a PEP 508 dependency string.

    Examples:
        'fastapi>=0.115,<0.120' -> ('fastapi', '>=0.115,<0.120')
        'uvicorn[standard]>=0.30,<0.35' -> ('uvicorn', '>=0.30,<0.35')
    """
    # Strip extras like [standard]
    dep_str = re.sub(r"\[.*?\]", "", dep_str).strip()
    # Split on first version specifier character
    m = re.match(r"^([A-Za-z0-9_-]+)\s*(.*)", dep_str)
    if not m:
        return (dep_str, "")
    name = m.group(1).strip()
    spec = m.group(2).strip()
    return (name, spec)


# ---------------------------------------------------------------------------
# 1. Python version compatibility
# ---------------------------------------------------------------------------


class TestPythonVersionCompatibility:
    """Verify the running Python satisfies pyproject.toml requires-python."""

    def test_runtime_satisfies_requires_python(self) -> None:
        pyproject = _parse_pyproject()
        requires_python = pyproject["project"]["requires-python"]
        specifier = SpecifierSet(requires_python)
        current = Version(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
        assert current in specifier, (
            f"Python {current} does not satisfy requires-python={requires_python!r}"
        )

    def test_requires_python_is_declared(self) -> None:
        pyproject = _parse_pyproject()
        assert "requires-python" in pyproject["project"], (
            "pyproject.toml must declare requires-python"
        )


# ---------------------------------------------------------------------------
# 2. Dependency version constraints
# ---------------------------------------------------------------------------

_CRITICAL_PACKAGES = ["fastapi", "uvicorn", "pydantic", "httpx"]


class TestDependencyVersionConstraints:
    """Verify critical packages are installed at versions matching declared constraints."""

    def _get_declared_deps(self) -> dict[str, str]:
        """Return {normalized_name: specifier_string} for all declared deps."""
        pyproject = _parse_pyproject()
        all_deps: list[str] = list(pyproject["project"].get("dependencies", []))
        # Also check dev dependencies where httpx lives
        optional = pyproject.get("project", {}).get("optional-dependencies", {})
        if isinstance(optional, dict):
            for group_deps in optional.values():
                if isinstance(group_deps, list):
                    all_deps.extend(group_deps)
        # For regex fallback, also parse dev deps manually
        if not optional:
            text = _PYPROJECT.read_text(encoding="utf-8")
            dev_match = re.search(r"dev\s*=\s*\[(.*?)\]", text, re.DOTALL)
            if dev_match:
                dev_deps = re.findall(r'"([^"]+)"', dev_match.group(1))
                all_deps.extend(dev_deps)

        result: dict[str, str] = {}
        for dep in all_deps:
            name, spec = _parse_dep_constraint(dep)
            # Normalize: PEP 503 lowercases and replaces [-_.] with -
            normalized = re.sub(r"[-_.]+", "-", name).lower()
            result[normalized] = spec
        return result

    @pytest.mark.parametrize("package", _CRITICAL_PACKAGES)
    def test_critical_package_satisfies_constraint(self, package: str) -> None:
        declared = self._get_declared_deps()
        normalized_pkg = re.sub(r"[-_.]+", "-", package).lower()
        assert normalized_pkg in declared, (
            f"Package {package!r} is not declared in pyproject.toml dependencies"
        )
        spec_str = declared[normalized_pkg]
        if not spec_str:
            # No version constraint declared; just verify it's installed.
            installed_version(package)
            return

        specifier = SpecifierSet(spec_str)
        current = Version(installed_version(package))
        assert current in specifier, (
            f"{package}=={current} does not satisfy declared constraint {spec_str!r}"
        )

    @pytest.mark.parametrize("package", _CRITICAL_PACKAGES)
    def test_critical_package_is_importable(self, package: str) -> None:
        """Verify the critical package can actually be imported."""
        __import__(package)


# ---------------------------------------------------------------------------
# 3. API schema stability
# ---------------------------------------------------------------------------


class TestAPISchemaStability:
    """Verify key endpoints exist with expected HTTP methods and path patterns."""

    @pytest.fixture(autouse=True)
    def _setup_app(self) -> None:
        from zvec_studio.main import create_app

        self.app = create_app()
        self.route_map: dict[str, set[str]] = {}
        for route in self.app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None)
            if path and methods:
                self.route_map.setdefault(path, set()).update(
                    m.upper() for m in methods
                )

    @pytest.mark.parametrize(
        "method,path",
        [
            ("GET", "/api/v1/healthz"),
            ("GET", "/api/v1/readyz"),
            ("POST", "/api/v1/collections"),
            ("POST", "/api/v1/collections/open"),
            ("DELETE", "/api/v1/collections/{name}"),
            ("GET", "/api/v1/collections/{name}/schema"),
            ("GET", "/api/v1/collections/{name}/stats"),
            ("PATCH", "/api/v1/collections/{name}/documents"),
            ("POST", "/api/v1/collections/{name}/documents:browse"),
            ("POST", "/api/v1/collections/{name}/searches"),
            ("GET", "/api/v1/fs/list"),
            ("POST", "/api/v1/ai/embeddings"),
            ("POST", "/api/v1/ai/rerankers"),
        ],
    )
    def test_endpoint_exists(self, method: str, path: str) -> None:
        assert path in self.route_map, (
            f"Route {path!r} not found. Available routes: "
            f"{sorted(self.route_map.keys())}"
        )
        assert method in self.route_map[path], (
            f"Method {method} not registered for {path!r}. "
            f"Registered methods: {self.route_map[path]}"
        )

    def test_collections_router_has_crud_methods(self) -> None:
        """Collections must support create (POST) and delete (DELETE)."""
        assert "POST" in self.route_map["/api/v1/collections"]
        assert "DELETE" in self.route_map["/api/v1/collections/{name}"]

    def test_no_accidental_route_prefix_change(self) -> None:
        """At least one route must start with /api/v1/ (prefix sanity check)."""
        api_routes = [p for p in self.route_map if p.startswith("/api/v1/")]
        assert len(api_routes) > 10, (
            f"Expected >10 API routes under /api/v1/, found {len(api_routes)}"
        )


# ---------------------------------------------------------------------------
# 4. Pydantic model compatibility
# ---------------------------------------------------------------------------


class TestPydanticModelCompatibility:
    """Verify key schema models can be instantiated and serialized to JSON."""

    def test_search_result_model(self) -> None:
        from zvec_studio.schemas import SearchResult

        obj = SearchResult(id="doc-1", score=0.95, fields={"title": "hello"})
        data = obj.model_dump_json()
        assert "doc-1" in data
        assert "0.95" in data

    def test_search_response_model(self) -> None:
        from zvec_studio.schemas import SearchResponse, SearchResult

        result = SearchResult(id="abc", score=0.5, fields={})
        resp = SearchResponse(results=[result], took_ms=1.23)
        data = resp.model_dump_json()
        assert "abc" in data
        assert "1.23" in data

    def test_collection_list_item_model(self) -> None:
        from zvec_studio.schemas import CollectionListItem

        item = CollectionListItem(name="my_col", path="/tmp/my_col")
        data = item.model_dump_json()
        assert "my_col" in data

    def test_collection_list_response_model(self) -> None:
        from zvec_studio.schemas import CollectionListItem, CollectionListResponse

        resp = CollectionListResponse(
            items=[CollectionListItem(name="test", path="/tmp/test")]
        )
        data = resp.model_dump_json()
        assert "test" in data

    def test_document_insert_request_model(self) -> None:
        from zvec_studio.schemas import DocumentInsertRequest

        req = DocumentInsertRequest(documents=[{"id": "1", "text": "hello"}])
        data = req.model_dump_json()
        assert "hello" in data

    def test_document_browse_request_defaults(self) -> None:
        from zvec_studio.schemas import DocumentBrowseRequest

        req = DocumentBrowseRequest()
        assert req.limit == 50
        assert req.filter is None
        data = req.model_dump_json()
        assert "50" in data

    def test_embedding_function_record_model(self) -> None:
        from zvec_studio.schemas import DefaultLocalDenseConfig, EmbeddingFunctionRecord

        rec = EmbeddingFunctionRecord(
            name="test-emb",
            description="Test embedding",
            config=DefaultLocalDenseConfig(),
        )
        data = rec.model_dump_json()
        assert "test-emb" in data

    def test_search_request_legacy_form(self) -> None:
        from zvec_studio.schemas import SearchRequest

        req = SearchRequest(vector=[0.1, 0.2, 0.3], topK=5)
        assert req.topK == 5
        data = req.model_dump_json()
        assert "0.1" in data

    def test_maintenance_response_model(self) -> None:
        from zvec_studio.schemas import MaintenanceResponse

        resp = MaintenanceResponse(operation="flush", timestamp="2024-01-01T00:00:00Z")
        data = resp.model_dump_json()
        assert "flush" in data


# ---------------------------------------------------------------------------
# 5. Required env vars documentation
# ---------------------------------------------------------------------------


class TestEnvVarsDocumented:
    """Verify all env vars referenced in source have defaults or are documented."""

    def _find_env_var_references(self) -> list[tuple[str, str, bool]]:
        """Scan Python source for os.environ/os.getenv usage.

        Returns list of (file_path, var_name, has_default).
        """
        source_dir = _BACKEND_ROOT
        results: list[tuple[str, str, bool]] = []
        # Exclude this test file itself to avoid matching regex patterns in comments
        this_file = Path(__file__).resolve()

        # Search in zvec_studio/ and tests/
        for pattern_dir in [source_dir / "zvec_studio", source_dir / "tests"]:
            if not pattern_dir.exists():
                continue
            for py_file in pattern_dir.rglob("*.py"):
                if py_file.resolve() == this_file:
                    continue
                text = py_file.read_text(encoding="utf-8", errors="replace")
                # os.environ.get("VAR", default) or os.environ.get("VAR")
                for m in re.finditer(
                    r'os\.environ\.get\(\s*["\']([^"\']+)["\'](?:\s*,\s*(.+?))?\s*\)',
                    text,
                ):
                    has_default = m.group(2) is not None
                    results.append((str(py_file), m.group(1), has_default))
                # os.getenv("VAR", default) or os.getenv("VAR")
                for m in re.finditer(
                    r'os\.getenv\(\s*["\']([^"\']+)["\'](?:\s*,\s*(.+?))?\s*\)',
                    text,
                ):
                    has_default = m.group(2) is not None
                    results.append((str(py_file), m.group(1), has_default))
                # os.environ["VAR"] (no default, will raise if missing)
                for m in re.finditer(
                    r'os\.environ\[\s*["\']([^"\']+)["\']\s*\]',
                    text,
                ):
                    results.append((str(py_file), m.group(1), False))
                # os.environ.setdefault("VAR", ...) — has a default
                for m in re.finditer(
                    r'os\.environ\.setdefault\(\s*["\']([^"\']+)["\']',
                    text,
                ):
                    results.append((str(py_file), m.group(1), True))
        return results

    def test_all_env_vars_have_defaults(self) -> None:
        """Every os.environ/os.getenv reference must provide a default value.

        Env vars without defaults will cause runtime KeyError/None issues if
        the var is not set. The pydantic-settings based Settings class handles
        its own env vars with declared defaults; this test covers raw os.environ
        usage elsewhere in the codebase.
        """
        refs = self._find_env_var_references()
        no_default: list[tuple[str, str]] = []
        for filepath, var_name, has_default in refs:
            if not has_default:
                no_default.append((filepath, var_name))

        assert not no_default, (
            "The following env var references lack defaults or documentation:\n"
            + "\n".join(f"  {f}: {v}" for f, v in no_default)
        )

    def test_pydantic_settings_fields_have_defaults(self) -> None:
        """All Settings fields must declare default values (no required env vars)."""
        from zvec_studio.settings import Settings

        # The real test: can we construct Settings with no env vars set?
        # We rely on pydantic-settings: if any field lacks a default, this raises.
        settings = Settings()
        assert settings.host is not None
        assert settings.port > 0
