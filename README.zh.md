# dsh-pure-search

**给 DeepSeek Harness 的纯本地检索：把 Markdown、TXT、PDF、Word、HTML、JSON 收进索引，按「工作区 / 会话」分层存放，查到的每一段都带原文出处。**

[English](README.md) | 简体中文

> 源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT），已重构为独立项目：新增 **DOCX / HTML / JSON 解析**、**工作区/会话分层索引 + 自动回退**、**检索性能优化** 与 **CI/回归测试**。全程离线，不联网、不调模型、不打开任何 socket。

---

## 它解决什么问题

把文档丢给模型时，常见四种尴尬：上下文装不下、每次都要重新读一遍文件、几个项目的文档互相串味、回答里的引用没法核对。

这个插件把「找原文」这件事从对话里拆出来，交给一个本地索引：

- 文档先入库（一次性），之后只查索引，不再重复读文件；
- 中文按二元组切词做 BM25，换一种说法也能命中；可选接入本地向量模型做混合检索；
- 返回的每一段都带 `path`、`title`、`heading`、`start_line/end_line` 或 `page`，可以直接核对；
- 索引按工作区分开、按会话再分一层，跨项目不会串。

## 支持什么文档

| 格式 | 解析方式 | 引用信息 | 说明 |
|---|---|---|---|
| `.md` / `.markdown` | 标题感知分块，识别 front-matter | 标题、heading、行号 | `status: superseded` 会降权 |
| `.txt` | 纯文本分块 | 行号 | — |
| `.pdf` | PyMuPDF 抽取文本 | 页码 | 扫描件无 OCR，需要时先过一遍 OCR |
| `.docx` | 标准库 zipfile + 解析 `word/document.xml` | 标题（`dc:title`，缺省取首段） | 表格/图片按纯文本处理，不保留样式 |
| `.html` / `.htm` | `HTMLParser`，跳过 script/style/noscript/template/svg/canvas | `<title>` 作为标题 | 正文按块级标签换行 |
| `.json` | 递归扁平化 `a.b[0] = value` | 键路径 | 深度限 8、单值 2000 字、总量 2 MB |

目录递归入库：自动跳过隐藏目录、`.git`、`node_modules`、`.venv`、`__pycache__`。其它扩展名在目录遍历时忽略，显式点名时报 `unsupported_extension`。

## 用了什么技术

**插件层（Node.js，ESM）**：只注册宿主侧八个工具，`package.json` 里刻意不写 `dsh.client` 字段——不带客户端注入，DSH 升级客户端 API 也不会把它带崩（DSH 的启动是全有或全无，这一条很关键）。

**引擎层（Python 3.9+）**：独立子进程跑 `engine/kb_engine.py`，stdin/stdout 走 NDJSON，一次调用一个 JSON 响应。BM25 只用标准库；PDF 才需要 `pymupdf`；稠密检索才需要 `numpy` + `sentence-transformers`。

**检索**：BM25（中文按二元组切词）+ 可选稠密向量（`BAAI/bge-small-zh-v1.5`），混合模式用 RRF 融合两路分数。权重、`top_k`、`include_superseded` 都可按调用覆盖。查询时对「整句命中、标题命中、路径命中」做短语加权。

**索引**：`manifest.json` 记文件内容 sha256，未变化的文件跳过、变化的重新解析、`force` 强制重解；`vectors.meta` 记向量元数据；`sync-state.json` 记同步时间；`sync-log.jsonl` 追加同步日志。索引在进程内缓存，按 `chunks.jsonl` 的 `(mtime, size)` 失效。

**分层**：`<kb_root>/<workspace>/_shared` 存工作区公共文档，`<kb_root>/<workspace>/sessions/<session>` 存会话私有文档。查询默认先查会话层，查不到再回退工作区层；两层分数不混算，回退会显式标记 `fell_back` 与原因（`session_empty` / `no_hits`）。不传 `workspace` 时按当前会话的工作目录自动取工作区名。

## 达到什么水准（实测）

在一台普通 Windows 机器上，用 7 篇中文文档（259 KB，376 块）跑 7 个自然语言问题：

| 指标 | 结果 |
|---|---|
| 中文自然语言问题 top-3 命中 | **7 / 7** |
| 单次查询（引擎进程复用，索引已缓存） | 中位 **2.7 ms**，p95 6.6 ms |
| 单次查询（首次查询 / 冷启动） | 约 12 ms / 134 ms（进程启动占大头） |
| 10,000 块合成语料上的单次查询 | 中位 **45 ms**（同条件上游实现约 1,077 ms） |
| 建索引 8 篇 / 376 块 | 132 ms |
| 建索引 37 篇 / 2013 块 | 746 ms |
| 对照：逐字匹配脚本 | 0.1 ms，但只命中 2 / 7 |
| 对照：PowerShell `Select-String` | 约 780 ms，也只命中 2 / 7 |

结论：**找文件名、常量、函数名用 grep 更快；找“哪份文档讲过这个事”用知识库更快**——逐字匹配对换说法的问题基本无能为力，而一次模型往返就是秒级。

## 安装

从 Git 仓库安装（推荐，发布初期）：

```powershell
dsh plugin --profile desktop add "git+https://github.com/silentlamb05147/dsh-pure-search.git"
```

本地开发时用链接安装，改源码即时生效：

```powershell
dsh plugin --profile desktop add "link:<你的仓库路径>"
```

安装后重启 DSH。首次使用先建索引（工具名保持 `kb_*` 前缀，与上游 API 兼容）：

```json
{ "paths": ["<你的项目>/docs"], "workspace": "my-project" }
```

## 八个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `kb_ingest` | 文档入库 | `paths`、`workspace`、`session`、`force`、`prune`、`max_files`、`chunk_chars`、`chunk_overlap`、`with_embeddings` |
| `kb_search` | 检索片段 | `query`、`workspace`、`session`、`fallback`、`top_k`、`mode`、`weights`、`include_superseded`、`context` |
| `kb_ask` | 带出处的原文证据 | 同上，外加 `max_chars` |
| `kb_outline` | 列出已入库文档与标题树 | `query`（按路径/标题过滤）、`workspace`、`session`、`limit` |
| `kb_get` | 按 path 或 chunk_id 取原文/行区间 | `path`、`chunk_id`、`start_line`、`end_line`、`max_chars` |
| `kb_stats` | 索引统计 | `workspace`、`session` |
| `kb_sync` | 增量同步 | `max_files`、`prune` |
| `kb_clear` | 清空 | `scope`：`session` / `workspace` / `all` |

`kb_ask` 只给原文段落与出处，不改写、不摘要、不润色——引用保真优先。`kb_outline` 只读 `manifest.json`，不触发内容解析；`kb_get` 走本地解析器读原文，命中块可直接用 `chunk_id` 展开上下文。

插件每 30 秒对已入库的目录做一次惰性扫描：文件改动、新增（支持的扩展名）会自动增量入库，删除的标记为 `missing`，不需要手动 `kb_sync`。

## 已知限制

- 冷启动后第一次查询要加载索引（约 12 ms，进程启动约 130 ms），之后走内存缓存；
- 扫描版 PDF 无文字层，需要先 OCR；
- DOCX 只取正文文本，不保留表格结构、图片、批注；
- JSON 只做扁平化，深层嵌套会截断到 8 层；
- 稠密检索需另装 2 GB 级依赖，默认关闭；
- 与上游 0.4.x 的分叉点、合并策略见 [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md)。

## 开源与发布

- **许可证**：MIT，保留上游版权与 LICENSE；
- **版本**：`1.0.0` 起独立版本号，不再跟随上游的 `-local.N`；
- **上游合并**：不自动跟随，按需 `git fetch upstream && git merge`，冲突热点与步骤见 `UPSTREAM-DIFF.md`；
- **兼容性**：在 DSH 0.2.1-rc.2 / 0.2.2-rc.1 上验证，Node.js 18+、Python 3.9+；
- **开发与测试**：见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可证

MIT。本项目源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT），原始版权归原作者所有。
