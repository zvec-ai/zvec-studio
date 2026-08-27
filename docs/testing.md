# Testing

> Zvec Studio's core engineering invariant: **no Task is merged unless
> `make verify` is green on the developer laptop, and reproducing a CI
> failure locally is a single command.**

## The self-test loop

```
(1) edit → (2) make verify → (3) failed?
                              ├─ yes → artifacts/ dump + auto-diagnose → fix → back to (2)
                              └─ no  → (4) coverage gate ok?
                                        ├─ no → add tests → back to (2)
                                        └─ yes → commit
```

Artifacts (stderr logs, coverage XML, Playwright trace/video, OpenAPI
diff) are written under `artifacts/<task-id>-<timestamp>/` and excluded
from Git. Do not delete the folder — it is the on-disk memory of the
last failed run.

## Entry points

| Command | What it runs | Target audience |
|---------|--------------|-----------------|
| `make verify`        | ruff + mypy + eslint + tsc + pytest (unit/integration/contract) + coverage gate 60 % | every pre-commit / pre-push |
| `make verify.fast`   | subset by `git diff` heuristic | inner dev loop |
| `make verify.desktop`| `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` | when touching `apps/desktop/` |
| `make e2e`           | Playwright web smoke (video + trace) | before opening a PR that touches UI flows |
| `make release-check` | `verify` + `verify.desktop` + `e2e` + frontend unit | release gate (run by CI on `v*` tags, locally before `git tag`) |

## Layered tests

### Backend — `apps/backend/tests/`

| Layer        | Directory        | Count  | Notes |
|--------------|------------------|--------|-------|
| Unit         | `tests/unit/`        | ~100+  | Schemas, filter DSL, middleware, AI registry, search params |
| Integration  | `tests/integration/` | ~100+  | httpx `AsyncClient` + real zvec SDK + `tmp_path` persistence |
| Contract     | `tests/contract/`    | placeholder | Schemathesis over `/openapi.json`; full suite planned for v0.4 |
| Benchmark    | `tests/benchmark/`   | small  | pytest-benchmark; baselines frozen in [`benchmarks/baseline.json`](../benchmarks/baseline.json) |

Total: **216 tests** passing. Coverage gate is enforced at **60 %**
overall; routers / middleware hold at **≥ 75 %**. Actual figures at
0.1.0: **94.28 % overall**.

### Frontend — `apps/frontend/src/`

**97 tests** across 20 test files.

- **Vitest** for hooks + pure logic (`features/*/hooks.test.tsx`).
- **React Testing Library + MSW** for components that hit the API
  (see `BrowseTab.test.tsx`, `ExportDocumentsDialog.test.tsx` for patterns).
- **UI component tests** for Toast, EmptyState, ErrorState, Skeleton,
  and the query client error sink.
- **Playwright** for happy-path E2E in `apps/frontend/tests/e2e/`.
  Video + trace recording is on by default; artifacts land under
  `artifacts/` on failure.

### Desktop — `apps/desktop/src-tauri/src/`

- `cargo test` — 6 unit tests cover sidecar configuration, ready-probe
  success + timeout, invalid address reporting and launch-summary
  dev-vs-bundled disambiguation.
- CI installs the built desktop artifact and runs `desktop_api_smoke.py`
  against the bundled sidecar. Linux and Windows also run the installed-app
  UI smoke through `tauri-driver`; macOS is limited to install/start/API
  smoke because Tauri does not provide an official WKWebView WebDriver.

## Reproducing a CI failure locally

1. Look at the failing job log and find the command it ran (e.g.
   `make verify` or `pnpm --filter frontend test:unit`).
2. Run the same command locally. The Makefile is the single source of
   truth; CI never invents new commands.
3. Inspect `artifacts/<task>-<timestamp>/` for:
   - `pytest-output.log` — full stdout/stderr
   - `coverage.xml` — line-by-line coverage
   - `playwright/trace.zip` — open with `pnpm exec playwright show-trace …`
   - `openapi-diff.txt` — schema drift, if contract tests fail

## Writing new tests — the golden rules

1. **Red before green.** A bug report becomes a failing test *first*.
2. **Don't skip, xfail.** `@pytest.mark.skip` is banned; `xfail` is
   permitted only with a linked GitHub issue.
3. **Don't relax assertions to hide a bug.** Fix the implementation.
   Legitimate test bugs must be called out in the commit message.
4. **Don't lower coverage gates.** If a PR drops coverage, add tests.
5. **Quarantine flakes.** After three retries Playwright isolates the
   spec with `@flaky` and files an issue — it does not block the main
   flow, but it becomes tech debt.

## Performance testing

`apps/backend/tests/benchmark/` runs topK=10 searches against an
in-memory collection of 1 k documents. Targets:

| Metric  | Budget      | Source |
|---------|-------------|--------|
| p50     | ≤ 40 ms     | `benchmarks/baseline.json` |
| p95     | ≤ 100 ms    | `benchmarks/baseline.json` |
| p99     | ≤ 200 ms    | pytest-benchmark regression threshold (+20 % = fail) |

These numbers are **local-SSD** measurements. Shared CI runners relax
the budgets by 5× to avoid flakes, and the real targets are guarded by
the nightly benchmark workflow.

## Destructive / soak tests

The following are kept in CI's `release` workflow only (too slow for
`verify`):

- **SIGKILL the backend mid-request** — the desktop shell must surface
  an error state and auto-reconnect within 5 s.
- **Read-only data dir** — error code must be `code=COLLECTION_WRITE_DENIED`
  with a human-readable message.
- **2-hour soak (insert + search loop)** — RSS drift budget ≤ 5 %.
  Runs weekly, not on every PR.

## Further reading

- Test commands in detail: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Architecture diagram: [architecture.md](architecture.md)
- Packaging test loop: [PACKAGING.md](PACKAGING.md)
