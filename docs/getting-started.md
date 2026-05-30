# Getting Started

A 10-minute walkthrough: install, create a collection, insert documents, run a vector search.

---

## 1. Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.10 | FastAPI backend, pinned by `apps/backend/.python-version` |
| uv | latest | Python environment manager |
| Node.js | ≥ 20 | Vite + React frontend |
| pnpm | ≥ 9 | Workspace package manager |
| Rust | stable | Desktop shell only (Tauri v2) |

macOS: `brew install python@3.11 uv node pnpm rustup-init`

## 2. Clone & Install

```bash
git clone https://github.com/zvec/zvec-studio.git
cd zvec-studio

make install
```

> **AI extras (optional).** The base install above does not pull in
> `sentence-transformers`, `dashscope`, `openai`, or `dashtext`. Without them,
> calls to `local-dense` / `local-sparse` / `bm25` / remote providers return
> HTTP 503. To enable them, replace `make install` with `make install.ai`.

## 3. Run in Web Mode

```bash
make dev
```

This starts:
- Backend: `uvicorn` on port 7860
- Frontend: Vite on port 5173 (proxies `/api/*` → 7860)

Open <http://127.0.0.1:5173>.

> Without `make`, start in two terminals:
> ```bash
> # Terminal 1 — backend
> cd apps/backend
> uv run --no-sync uvicorn zvec_studio.main:app --host 127.0.0.1 --port 7860 --reload
>
> # Terminal 2 — frontend
> pnpm --filter frontend dev
> ```
>
> Stop: `Ctrl+C`, or kill by port: `lsof -ti :7860 | xargs kill`

## 4. Create a Collection

From **Collections** → **Create**:

| Field | Value |
|-------|-------|
| Name | `demo` |
| Path | `./data/demo` (auto-created) |
| Vector field | `embedding`, FP32, dim=4, COSINE, HNSW |
| Primary key | `id` |

You can add multiple vector fields with different index types (FLAT, HNSW, IVF, HNSW_RABITQ), metrics (L2, IP, COSINE), and quantization (FP16, INT8, INT4, RABITQ).

## 5. Insert Documents

Go to **Write** tab → **Insert**, paste:

```json
[
  {"id": "cat",     "embedding": [0.10, 0.20, 0.30, 0.40], "title": "cat"},
  {"id": "dog",     "embedding": [0.90, 0.80, 0.70, 0.60], "title": "dog"},
  {"id": "parrot",  "embedding": [0.50, 0.50, 0.50, 0.50], "title": "parrot"},
  {"id": "hamster", "embedding": [0.15, 0.25, 0.35, 0.45], "title": "hamster"}
]
```

Click **Insert**. A toast confirms `4 documents inserted`.

## 6. Vector Search

Switch to **Query** tab. Paste query vector:

```json
[0.10, 0.20, 0.30, 0.40]
```

Set **topK = 3**, hit **Search**. Expected results: `cat`, `hamster`, `parrot` (ordered by similarity).

## 7. Clean Up

**Collections** → right-click `demo` → **Delete**. This removes the registry entry only — on-disk files remain.

## 8. Next Steps

- `make verify` — run the full self-test loop. See [testing.md](testing.md).
- `pnpm --filter desktop tauri:dev` — desktop shell (requires Rust).
- `make package` — freeze a production bundle. See [PACKAGING.md](PACKAGING.md).
- [architecture.md](architecture.md) — learn where each feature lives.
