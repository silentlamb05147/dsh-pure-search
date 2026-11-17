# dsh-pure-search

**给 DeepSeek Harness 的纯本地检索：把 Markdown、TXT、PDF、Word、HTML、JSON 收进索引，按「工作区 / 会话」分层存放，查到的每一段都带原文出处。**

[English](README.md) | 简体中文

> 源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT），在其 0.4.x 基础上重构为独立项目：新增 **DOCX / HTML / JSON 解析**、**工作区/会话分层索引 + 自动回退**、**章节识别与整章读取**、**两段式段落重排**、**检索性能优化** 与 **CI/回归测试**。全程离线，不联网、不调模型、不打开任何 socket。

---

## 为什么值得用（实测优势）

| 优势 | 实测数据 | 意义 |
|---|---|---|
| **轻** | 引擎 133 KB + 插件 48 KB，纯 Python 标准库，零运行时依赖 | 装完就是一个目录，卸载干净；不为了搜索拖进 2 GB 的模型栈 |
| **快** | 395 块：**2.7 ms**（p95 6.6）；10,000 块：**45 ms**（同条件上游实现约 1,077 ms） | 日常检索低于一次模型往返的零头；规模放大 25 倍仍然不卡 |
| **段落准** | 合成 50 篇 100 题，「答案段出现在返回结果里」**24% → 95%** | 不只是「文档找对了」，而是「答案那一段排在前面」——靠两段式重排：先定文档，再在文档内剔除识别性 token 重算段落 |
| **章节可用** | 1.33M 字小说：1,472 块 / 438 章；《晋书》59 万字：695 块 / 130 传纪；`kb_get path+chapter` 直接返回整章 | 长篇/史书/剧本不必再 `search` 后猜行号，按「第 140 章」「谢安传」直接取原文 |
| **出处可核对** | 每段带 `path` / `title` / `heading` / `start_line` / `end_line` / `page` | 引用能落到具体行，不是「某篇文档大概说过」 |
| **不串项目** | 索引按 `<workspace>/_shared` 与 `sessions/<session>` 分层，会话查不到才回退工作区 | 同一台机器上多个项目的文档互不可见，也不会互相污染排名 |
| **不碰客户端** | `package.json` 刻意不写 `dsh.client`，只注册宿主侧 8 个工具 | DSH 升级客户端 API 不会把它带崩（DSH 启动是全有或全无） |
| **可维护** | 保留上游 git 历史与 tag，4 套测试 + GitHub Actions，每次合并可复现 | 不是一次性 fork，上游修复可以按需合入 |

## 它解决什么问题

把文档丢给模型时，常见四种尴尬：上下文装不下、每次都要重新读一遍文件、几个项目的文档互相串味、回答里的引用没法核对。

这个插件把「找原文」这件事从对话里拆出来，交给一个本地索引：

- 文档先入库（一次性），之后只查索引，不再重复读文件；
- 中文按二元组切词做 BM25，能命中同词不同序、词组、原句——**换说法（同义改写）靠词面重叠，命中率有限，这是 BM25 的上限，不是隐藏项**；
- 返回的每一段都带 `path`、`title`、`heading`、`start_line/end_line` 或 `page`，可以直接核对；
- 索引按工作区分开、按会话再分一层，跨项目不会串。

## 支持什么文档

| 格式 | 解析方式 | 引用信息 | 说明 |
|---|---|---|---|
| `.md` / `.markdown` | 标题感知分块，识别 front-matter | 标题、heading、行号 | `status: superseded` 会降权 |
| `.txt` | 纯文本分块，自动识别 `第N章/卷/回`、`卷N`、`…纪/传/志` 等章节行；每个 chunk 归属所在章节 | 行号、章节标题 | 无章节行时按段落贪心切块 |
| `.pdf` | PyMuPDF 抽取文本 | 页码 | 扫描件无 OCR，需要时先过 OCR |
| `.docx` | 标准库 zipfile + 解析 `word/document.xml` | 标题（`dc:title`，缺省取首段） | 表格/图片按纯文本处理，不保留样式 |
| `.html` / `.htm` | `HTMLParser`，跳过 script/style/noscript/template/svg/canvas | `<title>` 作为标题 | 正文按块级标签换行 |
| `.json` | 递归扁平化 `a.b[0] = value` | 键路径 | 深度限 8、单值 2,000 字、总量 2 MB |

目录递归入库：自动跳过隐藏目录、`.git`、`node_modules`、`.venv`、`__pycache__`。其它扩展名在目录遍历时忽略，显式点名时报 `unsupported_extension`。

## 用了什么技术

**插件层（Node.js，ESM）**：只注册宿主侧八个工具，`package.json` 里刻意不写 `dsh.client` 字段——不带客户端注入，DSH 升级客户端 API 也不会把它带崩。

**引擎层（Python 3.9+）**：独立子进程跑 `engine/kb_engine.py`，stdin/stdout 走 NDJSON，一次调用一个 JSON 响应。BM25 只用标准库；PDF 才需要 `pymupdf`；稠密检索才需要 `numpy` + `sentence-transformers`。

**检索**：BM25（中文按二元组切词）+ 可选稠密向量（`BAAI/bge-small-zh-v1.5`），混合模式用 RRF 融合两路分数。命中后做两段式重排：先按文档取最高分定文档顺序，再在文档内部剔除「识别该文档的 token」（标题/路径），用剩余查询在该文档段落上重算 BM25，并给命中章节标题的段落加权。查询里直接点名章节（`第140章`、`谢安传`）时，该章节在段内排序中强加权。

**章节**：纯文本文档按章节行切分 chunk，`kb_get path + chapter` 直接返回该章原文（1-based 行号区间）。章节识别是行级规则（`第N章/卷/节/回/篇/部/集`、`卷N`、`数字. 标题`、`…纪/传/志/载记/表/书`），不做语义判断。

**索引与缓存**：`manifest.json` 记文件 sha256 与文档元数据；`chunks.jsonl` 存块文本与行号；`sync-state.json` / `sync-log.jsonl` 记同步状态。进程内缓存块列表、切词结果与 BM25 倒排，按 `chunks.jsonl` 的 `(mtime_ns, size)` 与 `root::doc_id` 失效——这是 2.7 ms 查询的来源。`top_k` 精确截断（不再返回 `max(top_k, 24)` 条）。

**分层**：`<kb_root>/<workspace>/_shared` 存工作区公共文档，`<kb_root>/<workspace>/sessions/<session>` 存会话私有文档。查询默认先查会话层，查不到再回退工作区层；两层分数不混算，回退显式标记 `fell_back` 与原因（`session_empty` / `no_hits`）。不传 `workspace` 时按当前会话工作目录自动取工作区名（在 DSH 0.2.1 上按 `session.header.cwd` 解析）。

## 达到什么水准（实测）

普通 Windows 机器，中文语料：

| 指标 | 结果 |
|---|---|
| 7 篇 / 259 KB / 376 块，7 个自然语言问题 top-3 | **7 / 7** |
| 单次查询（进程复用、索引已缓存） | 中位 **2.7 ms**，p95 6.6 ms |
| 10,000 块合成语料单次查询 | 中位 **45 ms**（上游同条件 1,077 ms） |
| 建索引 8 篇 / 376 块 | 132 ms |
| 建索引 37 篇 / 2,013 块 | 746 ms |
| 1.33M 字小说（1,472 块 / 438 章） | 首次查询 3.3 s（建缓存）；之后中位 **16.7 ms** |
| 59 万字《晋书》（695 块 / 130 传纪） | 首次查询 1.9 s；之后中位 **8.8 ms** |

**检索准确率**（20 题真实小说评测，人工写期望章节 + 锚点原文）：

| 题型 | top-1 命中 | top-5 命中 |
|---|---|---|
| 字面（给原句/原词） | **10 / 10** | 10 / 10 |
| 语义（换一种说法） | **4 / 10** | **6 / 10** |
| 合计 | 14 / 20 | 16 / 20 |

合成语料（50 篇 / 200 题，文档级）另测：literal `doc@1` 100%，paraphrase `doc@1` 90%（该集合题干与正文词汇重合度高，偏乐观，不作为公开结论）。

结论：**找关键词、原句、文件名、常量、函数名，它又快又准；找「换了个说法的意思」，它只能做到 4–6/10，这是 BM25 的固有上限。** 要补语义得另装约 2 GB 的稠密依赖，默认关闭。

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
| `kb_ingest` | 文档入库 | `paths`、`workspace`、`session`、`force`、`prune`、`max_files`、`chunk_chars`、`chunk_overlap`、`max_file_mb`、`with_embeddings` |
| `kb_search` | 检索片段 | `query`、`workspace`、`session`、`fallback`、`top_k`、`mode`、`weights`、`include_superseded`、`context` |
| `kb_ask` | 带出处的原文证据 | 同上，外加 `max_chars` |
| `kb_outline` | 列出已入库文档与标题树 | `query`（按路径/标题过滤）、`workspace`、`session`、`limit` |
| `kb_get` | 按 `path` 或 `chunk_id` 取原文/行区间；`path + chapter` 直接取整章 | `path`、`chunk_id`、`chapter`、`start_line`、`end_line`、`max_chars` |
| `kb_stats` | 索引统计与体检 | `workspace`、`session` |
| `kb_sync` | 增量同步 | `max_files`、`prune` |
| `kb_clear` | 清空 | `scope`：`session` / `workspace` / `all` |

`kb_ask` 只给原文段落与出处，不改写、不摘要、不润色——引用保真优先。插件每 30 秒惰性扫描已入库目录：改动/新增自动增量入库，删除标记 `missing`。

## 已知限制

- 冷启动第一次查询要加载索引（约 12 ms，进程启动约 130 ms）；超大单文件首次查询需建缓存（1.33M 字约 3.3 s）；
- 语义（换说法）召回只有 4–6/10，稠密检索默认关闭且需额外依赖；
- 扫描版 PDF 无文字层，需要先 OCR；
- DOCX 只取正文文本，不保留表格结构、图片、批注；md/docx 的标题样式不识别为章节（章节仅纯文本行规则）；
- JSON 只做扁平化，深层嵌套截断到 8 层；
- 与上游 0.4.x 的分叉点、合并策略见 [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md)。

## 开源与发布

- **许可证**：MIT，保留上游版权与 LICENSE；
- **版本**：`1.0.0` 起独立版本号；
- **上游合并**：不自动跟随，按需 `git fetch upstream && git merge`，冲突热点与步骤见 `UPSTREAM-DIFF.md`；
- **兼容性**：在 DSH 0.2.1-rc.2 / 0.2.2-rc.1 上验证，Node.js 18+、Python 3.9+；
- **开发与测试**：见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可证

MIT。本项目源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT），原始版权归原作者所有。
