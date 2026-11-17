# Changelog

本项目从 `1.0.0` 起独立版本号，不再跟随上游的 `0.4.x-local.N`。

## 1.0.0 — 2026-11-17

首个公开发布版本，源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) 0.4.11（已合并上游 0.4.12）。

### 新增

- **DOCX 支持**：标准库 `zipfile` 解析 `word/document.xml`，`dc:title` 缺省时用首段作标题。
- **HTML 支持**：标准库 `HTMLParser`，跳过 script/style/noscript/template/svg/canvas，块级标签转换行。
- **JSON 支持**：递归扁平化为 `a.b[0] = value`，限深 8、单值 2,000 字、全文 2 MB。
- **工作区 / 会话分层索引**：`<kb_root>/<workspace>/_shared` 与 `sessions/<session>`，查询先会话层、未命中回退工作区层，显式返回 `layer` / `fell_back` / `fallback_reason`。
- **`kb_outline`**：只读 manifest 列出文档与标题树，支持路径/标题过滤。
- **`kb_get`**：按 `path` 或 `chunk_id` 取原文，支持 `start_line` / `end_line` 与 `max_chars`。
- **`watch` 自动增量**：每 30 秒惰性扫描已入库目录，变更/新增自动入库，删除标 `missing`。
- **`context` 邻块**：`kb_search` 命中可返回前后邻块。
- **体积护栏**：`max_file_mb`（默认 20 MB）与 `kb_stats.warnings`。
- **自动工作区**：不传 `workspace` 时按会话工作目录解析，兼容多种 DSH 宿主字段。
- **首查预热**：注册后 ping 引擎并后台 warmup。
- **测试与 CI**：`test/smoke.mjs`、`test-layers.mjs`、GitHub Actions（Ubuntu/Windows × Node 20/22）。

### 性能

- 块文本 casefold 预算（`text_l`），短语加权不再逐次转换。
- BM25 postings 直接携带 `(doc_index, tf)`，去掉逐条 `Counter.get`。
- 候选集改用 `heapq.nlargest`。
- chunks / BM25 索引按 `(mtime_ns, size)` 进程内缓存。
- 修复 `top_k`：此前返回 `max(top_k, 24)` 条，现按 `top_k` 精确截断。

实测：395 块语料 search 中位 2.7 ms（p95 6.6 ms）；10,000 块合成语料 45 ms；同条件上游实现分别为 71 ms 与 1,077 ms。

### 变更

- 包名/仓库名改为 `dsh-pure-search`，版本 `1.0.0`，MIT 保留上游版权。
- `FORK.md` 由面向公众的 `DEVELOPMENT.md` 取代。
- `package.json` 的 `files` 纳入 `DEVELOPMENT.md`、`CHANGELOG.md`、`docs/`、`UPSTREAM-DIFF.md`。
- 工具名保持 `kb_*` 前缀，与上游 API 兼容。

### 已知限制

- 扫描版 PDF 无文字层，需先 OCR。
- DOCX 只取正文文本，不保留表格结构、图片、批注。
- 稠密检索需另装约 2 GB 依赖，默认关闭。
