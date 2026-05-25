<p align="right">
  English | <a href="https://github.com/zvec-ai/zvec-studio/blob/main/README.zh-CN.md">中文</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zvec-ai/zvec-studio/main/docs/assets/hero-dark.svg" />
    <img src="https://raw.githubusercontent.com/zvec-ai/zvec-studio/main/docs/assets/hero-light.svg" width="480" alt="Zvec Studio" />
  </picture>
</p>

<p align="center">
  <strong>Visual management tool for the <a href="https://github.com/alibaba/zvec">Zvec</a> embedded vector database</strong><br/>
  Browse data, test queries, and manage schemas — without writing code.
</p>

<p align="center">
  <a href="https://github.com/zvec-ai/zvec-studio/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"/></a>
  <a href="https://pypi.org/project/zvec-studio/"><img src="https://img.shields.io/pypi/v/zvec-studio?color=blue&label=version" alt="Version"/></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-3DDC84" alt="Platforms"/></a>
  <a href="https://github.com/zvec-ai/zvec-studio/actions/workflows/ci.yml"><img src="https://github.com/zvec-ai/zvec-studio/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"/></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/zvec-ai/zvec-studio/main/docs/assets/tour-guide.gif" width="720" alt="Zvec Studio guided tour" />
</p>

---

## 📦 Installation

### Option 1: pip (recommended for developers)

```bash
pip install zvec-studio
zvec-studio
```

Opens http://127.0.0.1:7860 in your browser.

### Option 2: Desktop download

Grab the installer for your platform from [GitHub Releases](https://github.com/zvec-ai/zvec-studio/releases):

| Platform | Architectures | Installer |
|----------|---------------|-----------|
| macOS | Apple Silicon (arm64) | `.dmg` |
| Linux | x86_64, arm64 | `.deb` / `.AppImage` |
| Windows | x86_64 | `.msi` / `.exe` |

Double-click to run — no Python needed.

### Option 3: From source

```bash
git clone https://github.com/zvec-ai/zvec-studio.git
cd zvec-studio
make install    # install Node + Python dependencies
make dev        # starts backend + frontend dev servers
```

> Prerequisites: **Node.js ≥ 20**, **pnpm ≥ 9**, **Python ≥ 3.10**, **Rust** (desktop only).
> See [Contributing](https://github.com/zvec-ai/zvec-studio/blob/main/CONTRIBUTING.md) for the full dev setup guide.

## ⚡ Quick Start

1. **Create a collection** — Collections → Create. Define vector and scalar fields.
2. **Insert data** — Paste JSON documents in the Write tab.
3. **Vector search** — Paste a query vector in the Query tab, set TopK, hit Search.
4. **AI search** — Register an embedding model, then search by typing text directly.

Full walkthrough → [Getting Started](https://github.com/zvec-ai/zvec-studio/blob/main/docs/getting-started.md)

## 📖 Documentation

| | |
|---|---|
| [Getting Started](https://github.com/zvec-ai/zvec-studio/blob/main/docs/getting-started.md) | 10-minute walkthrough from install to first search |
| [Architecture](https://github.com/zvec-ai/zvec-studio/blob/main/docs/architecture.md) | Request flow, module map, code index |
| [API Reference](https://github.com/zvec-ai/zvec-studio/blob/main/docs/api.md) | REST endpoints, request/response formats, error codes |
| [Testing](https://github.com/zvec-ai/zvec-studio/blob/main/docs/testing.md) | Test strategy, self-verification loop, performance baselines |
| [Packaging](https://github.com/zvec-ai/zvec-studio/blob/main/docs/PACKAGING.md) | PyInstaller + Tauri cross-platform packaging |
| [Contributing](https://github.com/zvec-ai/zvec-studio/blob/main/CONTRIBUTING.md) | Dev setup, code style, commit workflow |

## 🗺️ Roadmap

| Version | Focus |
|---------|-------|
| **v0.1.x** (current) | Collection CRUD, schema evolution, document ops, vector search, AI extension, i18n, desktop app |
| **v0.2.x** | Data import/export, virtual scrolling, batch operations, advanced search |
| **v0.3.x** | Vector visualization (UMAP/t-SNE), clustering, AI Agent, SDK code generation |
| **v0.4.x** | VS Code extension, API Playground, webhooks & notifications |

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](https://github.com/zvec-ai/zvec-studio/blob/main/CONTRIBUTING.md) for details.

```bash
make dev        # Start dev servers
make verify     # Lint + typecheck + tests
```

## 📄 License

[Apache License 2.0](https://github.com/zvec-ai/zvec-studio/blob/main/LICENSE)
