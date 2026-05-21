# Zvec Studio

**[Zvec](https://github.com/alibaba/zvec) 向量数据库可视化管理工具** — 不用写代码，直接浏览数据、测试查询、管理 Schema。

[English](README.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)

![Zvec Studio — 集合概览](docs/assets/screenshot.png)

---

## 功能亮点

- **集合管理** — 创建、打开、删除集合，支持多向量字段，每个向量可独立配置索引类型（HNSW / IVF / FLAT / HNSW_RABITQ）、度量方式和量化策略
- **Schema 演进** — 在线添加/删除/重命名字段，创建/删除向量索引，无需重建集合
- **数据浏览** — Filter 表达式筛选文档，分页浏览，JSON 格式文档详情
- **文档操作** — Insert / Upsert / Update / Delete，支持批量 JSON 编辑
- **向量搜索** — 多向量 ANN 搜索，支持 Filter、TopK 调节、搜索历史记录
- **AI 搜索** — 集成 Embedding（OpenAI / Qwen / 本地模型）实现文本直搜；支持 RRF / Weighted / Cross-Encoder 重排
- **中英文界面** — 完整的中英双语支持，随时切换
- **桌面版** — macOS / Linux / Windows 原生应用，无需安装 Python

## 安装

### 方式一：pip 安装（开发者推荐）

```bash
pip install zvec-studio
zvec-studio
```

浏览器自动打开 http://127.0.0.1:7860。

### 方式二：桌面应用下载

从 [GitHub Releases](../../releases) 下载适合你平台的安装包：

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Linux | `.deb` / `.AppImage` |
| Windows | `.msi` / `.exe` |

双击运行，无需安装 Python。

### 方式三：从源码运行（Web）

环境要求：**Node.js ≥ 18**、**pnpm ≥ 8**、**Python ≥ 3.10**

```bash
# 1. 克隆仓库
git clone https://github.com/zvec/zvec-studio.git
cd zvec-studio

# 2. 安装前端依赖
pnpm install

# 3. 配置后端虚拟环境
cd apps/backend
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cd ../..

# 4. 同时启动后端和前端
make dev
```

启动后：
- **后端 API** — http://127.0.0.1:7860（FastAPI + Uvicorn，热重载）
- **前端 SPA** — http://127.0.0.1:5173（Vite 开发服务器）

浏览器打开 **http://127.0.0.1:5173** 即可使用。

> 如果没有 `make`，可以手动启动两个终端：
> ```bash
> # 终端 1 — 后端
> cd apps/backend && source .venv/bin/activate
> python -m uvicorn zvec_studio.main:app --host 127.0.0.1 --port 7860 --reload
>
> # 终端 2 — 前端
> pnpm --filter frontend dev
> ```

## 快速上手

**1. 创建集合** — 打开 Collections 页面 → Create，填写名称、路径，定义向量字段和标量字段。

**2. 插入数据** — 进入集合的 Write 标签页，粘贴 JSON 文档：

```json
[
  {"id": "a", "embedding": [0.1, 0.2, 0.3, 0.4], "title": "cat"},
  {"id": "b", "embedding": [0.9, 0.8, 0.7, 0.6], "title": "dog"}
]
```

**3. 向量搜索** — 切到 Query 标签页，粘贴查询向量 `[0.1, 0.2, 0.3, 0.4]`，设置 TopK，点击搜索。

**4. AI 搜索** — 在侧边栏注册 Embedding 模型（如 OpenAI），搜索时选择 Embedding 即可直接输入文本搜索。

完整教程见 [快速上手指南](docs/getting-started.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [快速上手](docs/getting-started.md) | 10 分钟从安装到第一次向量搜索 |
| [产品概述](docs/overview.md) | 产品定位、用户画像、功能规划、技术架构 |
| [系统架构](docs/architecture.md) | 请求流程、模块结构、代码索引 |
| [API 参考](docs/api.md) | REST API 端点、请求/响应格式、错误码 |
| [测试指南](docs/testing.md) | 测试策略、自验证流程、性能基准 |
| [打包发布](docs/PACKAGING.md) | PyInstaller + Tauri 打包、跨平台说明 |
| [贡献指南](CONTRIBUTING.md) | 开发环境搭建、代码规范、提交流程 |
| [更新日志](CHANGELOG.md) | 版本发布记录 |

## 路线图

| 版本 | 重点 |
|------|------|
| **v0.1.x**（当前） | 集合 CRUD、Schema 演进、文档操作、向量搜索、AI 扩展、深色模式、中英文 i18n、桌面版 |
| **v0.2.x** | 数据导入导出（CSV/JSON/JSONL）、虚拟滚动、批量操作增强、高级搜索 |
| **v0.3.x** | 向量可视化（UMAP/t-SNE）、聚类分析、AI Agent、SDK 代码生成 |
| **v0.4.x** | VS Code 插件、API Playground、Webhook 与通知 |

## 参与贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建和提交流程。

```bash
make dev        # 启动开发环境
make verify     # 运行全部检查（lint + 类型检查 + 测试）
```

## 许可证

[Apache License 2.0](LICENSE)
