# Changelog

本项目从 `1.0.0` 起独立版本号，不再跟随上游的 `0.4.x-local.N`。

## 1.1.0 — 2026-11-23

### 新增

- **`kb_delete`**：从索引移除一篇文档，原文件不动；写入 `status: excluded` 墓碑，后台 `watch` 扫描不会把它重新收录；`restore: true` 或再次 `kb_ingest` 该路径可恢复。
- **设置页「纯索引」**：列出所有已索引文件的文件名与层级（工作区 / 会话），每行可一键从索引移除；只读 manifest，不经检索，空索引也可打开。
- **`/api/pure-search`**：`GET /docs` 汇总所有工作区与会话层的索引清单，`POST /delete` 按 `workspace` / `session` / `path` 定位到当前层执行删除。
- **`kb_outline` 新增 `include_excluded`**：可查看墓碑条目（用于找到待恢复的路径）。

### 变更

- 插件从 host-only 变为「host + 一个设置页」：`package.json` 增加 `dsh.client`，新增 `client.js`，`exports` 增加 `./client`。
- `test/run-all.mjs` 增加 `test/delete.mjs`（12 项断言：删除、墓碑、watch 不复活、恢复、错误路径）。

## 1.0.0 — 2026-11-17

首个公开发布版本，源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) 0.4.11（已合并上游 0.4.12）。

### 新增

- **DOCX 支持**：标准库 `zipfile` 解析 `word/document.xml`，`dc:title` 缺省时用首段作标题。
- **HTML 支持**：标准库 `HTMLParser`，跳过 script/style/noscript/template/svg/canvas，块级标签转换行。
- **JSON 支持**：递归扁平化为 `a.b[0] = value`，限深 8、单值 2,000 字、全文 2 MB。
- **工作区 / 会话分层索引**：`<kb_root>/<workspace>/_shared` 与 `sessions/<session>`，查询先会话层，未命中回退工作区层，显式返回 `layer` / `fell_back` / `fallback_reason`。
- **章节识别与整章读取**：纯文本按 `第N章/卷/节/回`、`卷N`、`…纪/传/志` 等行切块；`kb_get path + chapter` 返回整章原文与行号区间。
- **两段式段落重排**：先按文档定序，再在文档内剔除标题/路径等识别性 token 重算段落分数，并对查询点名的章节加权——「文档对、段落错」显著减少。
- **`kb_outline`**：只读 manifest 列出文档与标题树，支持路径/标题过滤。
- **`kb_get`**：按 `path` / `chunk_id` 取原文，支持 `start_line` / `end_line` / `max_chars` / `chapter`。
- **`watch` 自动增量**：每 30 秒惰性扫描已入库目录，变化/新增自动入库，删除标记 `missing`。
- **`context` 邻块**：`kb_search` 可返回命中块前后的邻块。
- **体积护栏**：`max_file_mb`（默认 20 MB）与 `kb_stats.warnings`。
- **自动工作区**：不传 `workspace` 时按会话工作目录解析（DSH 0.2.1 为 `session.header.cwd`）。
- **首查预热**：注册后 ping 引擎并后台 warmup。
- **测试与 CI**：`test/smoke.mjs`、`test-layers.mjs`、`test/section-rerank.mjs`、`test/chapter.mjs`，GitHub Actions（Ubuntu/Windows × Node 20/22）。

### 性能

- 块文本 casefold 预计算（`text_l`），短语加权不再逐次转换。
- BM25 postings 直接携带 `(doc_index, tf)`，去掉逐条 `Counter.get`。
- 候选集改用 `heapq.nlargest`。
- 切词缓存、分段重排缓存按 `root::doc_id` 隔离；chunks / BM25 索引按 `(mtime_ns, size)` 进程内缓存。
- 修复 `top_k`：此前返回 `max(top_k, 24)` 条，现按 `top_k` 精确截断。
- 修复章节重排开启时每次查询重建分词的性能问题（659 块单书 1.5 s → 毫秒级）。

实测：395 块语料 search 中位 2.7 ms（p95 6.6 ms）；10,000 块合成语料 45 ms；同条件上游实现分别为 71 ms 与 1,077 ms。1.33M 字小说 warm 中位 16.7 ms。

### 变更

- 包名/仓库名改为 `dsh-pure-search`，版本 `1.0.0`，MIT 保留上游版权。
- `FORK.md` 由面向公众的 `DEVELOPMENT.md` 取代。
- `package.json` 的 `files` 纳入 `DEVELOPMENT.md`、`CHANGELOG.md`、`docs/`、`UPSTREAM-DIFF.md`。
- 工具名保持 `kb_*` 前缀，与上游 API 兼容。

### 已知限制

- 语义（换说法）召回 4–6/10，稠密检索默认关闭且需约 2 GB 依赖。
- 扫描版 PDF 无文字层，需先 OCR。
- DOCX 只取正文文本，不保留表格结构、图片、批注。
- md/docx 的标题样式不识别为章节（章节仅纯文本行规则）。
