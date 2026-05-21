"""Placeholder contract test suite.

Task 2+ wire in Schemathesis-generated cases against the live OpenAPI spec.
We keep a trivial passing test here so ``pytest tests/contract`` produces a
well-formed JUnit XML even on empty suites.
"""

from __future__ import annotations

import pytest


@pytest.mark.contract
def test_contract_suite_discoverable() -> None:
    """Sentinel: ensures the contract directory is collected by pytest."""
    assert True
