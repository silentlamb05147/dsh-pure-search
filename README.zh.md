# dsh-pure-search

[![ci](https://github.com/silentlamb05147/dsh-pure-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/silentlamb05147/dsh-pure-search/actions/workflows/ci.yml)

**面向 DeepSeek Harness 的本地文档检索插件：将 Markdown、TXT、PDF、DOCX、HTML、JSON 纳入本地索引，按工作区与会话分层存储，检索结果附带可核对的原文出处。**

[English](README.md) | 简体中文

| 版本 | 许可 | 运行环境 |
|---|---|---|
| 1.0.0（2026-11-17） | MIT | DSH 0.2.1-rc.2 / 0.2.2-rc.1；Node.js ≥ 18；Python ≥ 3.9 |

本项目基于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT）的 0.4.x 版本重构，保留其工具接口与数据结构，并新增 DOCX / HTML / JSON 解析、工作区与会话分层索引、章节识别与整章读取、段落级重排及检索路径性能优化。插件全程离线运行：不发起网络请求，不调用模型，不监听端口。

---

## 可有效解决哪些问题

| 问题 | 本插件的做法 | 可核对的结果 |
|---|---|---|
| 上下文装不下整份文档 | 只返回命中的原文段落与行号；需要上下文时再用 `kb_get` 扩读或读取整章 | 单次定位 2.7 ms；每条结果带 `path`、`heading`、`start_line` / `end_line` |
| 每轮对话都重复读取同一批文件 | 文档一次性入库，索引常驻内存，按 `(mtime, size)` 自动失效 | 395 块 2.7 ms；10,000 块 45 ms |
| 多个项目的文档互相干扰 | 工作区共享层与会话私有层分开存储；查询先会话层、未命中显式回退 | 两层分数不混合计算；返回 `layer`、`fell_back`、`fallback_reason` |
| 引用无法核对 | 每条结果附带文档路径、标题、章节标题与基于 1 的行号区间 | 可直接跳转到原文行核对 |
| 文档找对了、段落找错了 | 两段式重排：先按文档定序，再在文档内剔除标题/路径等识别性 token 重算段落 | 合成 100 题「答案段出现在结果中」24% → 95% |
| 长篇小说、史书没有章节结构 | 识别 `第N章/卷/节/回`、`卷N`、`…纪/传/志` 等章节行，块归属章节；`kb_get` 读取整章 | 1.33M 字识别 438 章；59 万字《晋书》识别 130 传纪 |
| 不希望插件联网或调用模型 | 解析、索引与检索全部在本地完成 | 无网络请求、无 socket、无模型调用 |
| 担心升级 DSH 后插件被带崩 | 功能全在宿主工具里，客户端只有一个可选设置页 | 删掉 `client.js` 后仍是完整的纯宿主插件 |

### 适用与不适用

**适用**：按关键词、原句、文件名、函数名、标识符定位原文；为项目文档、规范、笔记建立可引用的检索；长篇小说、史书、剧本的章节定位；同一台机器上多个项目的文档隔离；离线或内网环境。

**不适用**：以同义改写为主的模糊搜索（当前召回 4–6 / 10）；需要生成答案、摘要或改写的场景；扫描版 PDF（需先 OCR）；不愿安装约 2 GB 向量依赖却又要求语义召回的场景。

## 事实速览

| 指标 | 数值 | 测试条件 |
|---|---|---|
| 单次查询延迟 | 中位 **2.7 ms**，p95 6.6 ms | 395 块中文语料，引擎复用、索引已缓存 |
| 万块规模延迟 | 中位 **45 ms** | 10,000 块合成语料；同条件上游实现 1,077 ms |
| 字面检索准确率 | top-1 **10 / 10** | 真实小说 20 题中字面题 |
| 语义检索准确率 | top-1 **4 / 10**，top-5 **6 / 10** | 真实小说 20 题中同义改写题 |
| 段落命中提升 | **24% → 95%** | 合成 50 篇 100 题，答案段出现在返回结果中 |
| 章节识别 | 438 章 / 130 传纪 | 1.33M 字小说；59 万字《晋书》 |
| 建索引耗时 | 132 ms / 746 ms | 8 篇 376 块 / 37 篇 2,013 块 |

## 核心特性

| 特性 | 说明 |
|---|---|
| 轻量 | 引擎 133 KB，插件 48 KB，仅使用 Python 标准库；无运行时依赖，安装与卸载均作用于单一目录 |
| 低延迟 | 查询走进程内缓存；检索路径无重复分词与重复建索引 |
| 段落级排序 | 先定文档、再定段落，减少「文档正确、段落错误」 |
| 章节支持 | 纯文本章节行识别；`kb_get path + chapter` 返回整章原文与行号区间 |
| 引用保真 | 返回原文与位置，不改写、不摘要、不润色 |
| 分层隔离 | 工作区共享层与会话私有层分离，回退显式标记 |
| 索引管理 | 设置页列出已索引文件的文件名与真实路径，支持删除到回收站与恢复 / 彻底删除；只改索引，不动磁盘 |
| 宿主兼容 | 功能全在宿主工具里；唯一的客户端代码是一个可选设置页，删掉 `client.js` 仍可纯宿主运行 |
| 可维护 | 保留上游 git 历史与标签，四套测试与持续集成 |

## 设计原则

1. **默认离线**：检索、解析、索引均不联网；可选稠密检索默认关闭。
2. **引用优先**：只返回原文与位置，不生成答案。
3. **最小依赖**：BM25、分词、DOCX/HTML/JSON 解析均使用标准库；PDF 才需要 PyMuPDF。
4. **不侵入宿主**：只增加一个可选设置页（列出索引、回收站），其余不修改 DSH 界面；关掉或删掉该页不影响插件工作。
5. **行为可预期**：分层、回退、缓存失效与索引状态均有显式字段。

## 技术实现

**插件层（Node.js，ESM）**：注册九个宿主工具，负责参数校验、分层路径解析与工具描述；另提供一个可选设置页（`client.js`：文件名 + 真实路径 + 回收站），通过 `/api/pure-search` 访问宿主。

**引擎层（Python ≥ 3.9）**：`engine/kb_engine.py` 以独立子进程运行，通过 stdin/stdout 上的 NDJSON 协议处理请求，每次调用返回一个 JSON 响应。

**检索**：BM25（中文二元组切词）；可选稠密向量（`BAAI/bge-small-zh-v1.5`），混合模式以 RRF 融合；支持按调用覆盖权重、`top_k` 与 `include_superseded`。

**段落重排**：检索后先按文档聚合得分并确定文档顺序，再在每篇文档内部剔除用于识别该文档的 token（标题、路径），以剩余查询词重算段落 BM25，并对命中章节标题的段落加权。查询中直接出现章节名（如 `第140章`、`谢安传`）时，该章节获得额外权重。

**索引与缓存**：`manifest.json` 保存文件摘要与文档元数据；`chunks.jsonl` 保存文本块、章节标题与行号区间；`sync-state.json` 与 `sync-log.jsonl` 记录同步状态。块列表、切词结果与 BM25 倒排索引在进程内缓存，并按 `chunks.jsonl` 的 `(mtime_ns, size)` 与 `root::doc_id` 失效。

**分层**：`<kb_root>/<workspace>/_shared` 存放工作区共享文档，`<kb_root>/<workspace>/sessions/<session>` 存放会话私有文档。查询默认先访问会话层，未命中时回退至工作区层，并返回 `layer`、`fell_back` 与 `fallback_reason`。未显式指定 `workspace` 时，按当前会话的工作目录推导工作区名称。

## 支持的文档格式

| 格式 | 解析方式 | 引用信息 | 说明 |
|---|---|---|---|
| `.md` / `.markdown` | 标题感知分块，识别 front-matter | 标题、章节标题、行号 | `status: superseded` 的文档降权 |
| `.txt` | 纯文本分块，识别章节行 | 行号、章节标题 | 无章节行时按段落切分 |
| `.pdf` | PyMuPDF 提取文本 | 页码 | 扫描件无文字层，需先 OCR |
| `.docx` | 标准库 `zipfile` 解析 `word/document.xml` | 标题（`dc:title`，缺省取首段） | 表格与图片按纯文本处理 |
| `.html` / `.htm` | 标准库 `HTMLParser`，跳过脚本与样式节点 | `<title>` | 块级标签转换为换行 |
| `.json` | 递归扁平化为 `a.b[0] = value` | 键路径 | 深度上限 8，单值 2,000 字，总量 2 MB |

目录递归入库时自动跳过隐藏目录、`.git`、`node_modules`、`.venv` 与 `__pycache__`；其他扩展名在目录遍历中忽略，显式指定时返回 `unsupported_extension`。

## 工具接口

| 工具 | 用途 | 主要参数 |
|---|---|---|
| `kb_ingest` | 文档入库 | `paths`、`workspace`、`session`、`force`、`prune`、`max_files`、`chunk_chars`、`chunk_overlap`、`max_file_mb`、`with_embeddings` |
| `kb_search` | 检索文本块 | `query`、`workspace`、`session`、`fallback`、`top_k`、`mode`、`weights`、`include_superseded`、`context` |
| `kb_ask` | 返回原文证据与出处 | 同 `kb_search`，另含 `max_chars` |
| `kb_outline` | 列出文档与标题结构 | `query`（按路径或标题过滤）、`workspace`、`session`、`limit` |
| `kb_get` | 按路径或块 ID 读取原文；`path + chapter` 读取整章 | `path`、`chunk_id`、`chapter`、`start_line`、`end_line`、`max_chars` |
| `kb_delete` | 移到回收站：搜索与列表不再返回，原文件不动；`restore: true` 立即恢复 | `path`、`restore`、`workspace`、`session`（设置页会一次移动该文件所在的所有层） |
| `kb_stats` | 索引统计与健康检查 | `workspace`、`session` |
| `kb_sync` | 增量同步 | `max_files`、`prune` |
| `kb_clear` | 清理索引 | `scope`：`session` / `workspace` / `all` |

`kb_ask` 仅返回原文段落与出处，不进行改写、摘要或润色。插件每 30 秒对已入库目录执行一次惰性扫描：新增与变更文件自动入库，删除文件标记为 `missing`。`kb_delete` 把文档移入**回收站**：块从 `chunks.jsonl` 搬到 `trash.jsonl`，manifest 保留 `status: trashed` 条目，因此搜索、列表与后台扫描都不会再碰它；在设置页或 `kb_delete(restore: true)` 中可恢复，只有“彻底删除/清空回收站”才真正移除条目。

## 设置页

设置 → 纯索引 是一个纯索引管理页：

- **已索引文件**：列出每个文件的文件名与真实路径（等宽字体、整行可读），每行一个“删除”，把文件移入回收站；
- **搜索与筛选**：工具卡里可按文件名或真实路径实时搜索，也可点类型筛选（全部 / MD / PDF / DOCX / HTML / JSON / TXT …，带数量），两者可叠加，底部显示“显示 x / y 个文件”；
- **回收站**：列出已移出索引的文件（名称、路径、移入时间），可“恢复”或“彻底删除”，也可“清空回收站”。

所有操作只改索引（`manifest.json`、`chunks.jsonl`、`trash.jsonl`），**磁盘上的原文件始终保留**；页面不提供任何移动、重命名磁盘文件的能力。

## 性能与准确率

测试环境为普通 Windows 桌面机，中文语料，索引已缓存且引擎进程复用：

| 指标 | 结果 |
|---|---|
| 7 篇 / 259 KB / 376 块，7 个自然语言问题 top-3 | 7 / 7 |
| 单次查询延迟 | 中位 2.7 ms，p95 6.6 ms |
| 10,000 块合成语料单次查询 | 中位 45 ms（同条件上游实现 1,077 ms） |
| 建索引 8 篇 / 376 块 | 132 ms |
| 建索引 37 篇 / 2,013 块 | 746 ms |
| 1.33M 字小说（1,472 块 / 438 章） | 首次查询 3.3 s（构建缓存）；此后中位 16.7 ms |
| 59 万字《晋书》（695 块 / 130 传纪） | 首次查询 1.9 s；此后中位 8.8 ms |

准确率以 20 题真实小说评测衡量，期望章节与锚点原文由人工标注：

| 题型 | top-1 | top-5 |
|---|---|---|
| 字面（原句、原词） | 10 / 10 | 10 / 10 |
| 语义（同义改写） | 4 / 10 | 6 / 10 |
| 合计 | 14 / 20 | 16 / 20 |

合成语料（50 篇 / 200 题，文档级）另测得 literal `doc@1` 100%、paraphrase `doc@1` 90%；该集合题干与正文词汇重合度较高，结果偏乐观，不作为公开结论。

## 安装与升级

从 Git 仓库安装：

```powershell
dsh plugin --profile desktop add "git+https://github.com/silentlamb05147/dsh-pure-search.git"
```

本地开发使用链接安装：

```powershell
dsh plugin --profile desktop add "link:<仓库路径>"
```

安装后重启 DSH。首次使用需先建立索引（工具名保持 `kb_*` 前缀，与上游接口兼容）：

```json
{ "paths": ["<项目>/docs"], "workspace": "my-project" }
```

升级时重新执行 `add` 并重启 DSH；索引格式向后兼容，无需重建。

## 已知限制

- 冷启动后的首次查询需加载索引（约 12 ms，进程启动约 130 ms）；超大单文件首次查询需构建缓存（1.33M 字约 3.3 s）。
- 同义改写召回率为 4–6 / 10；稠密检索默认关闭，且需要约 2 GB 的额外依赖。
- 扫描版 PDF 无文字层，需先执行 OCR。
- DOCX 仅提取正文文本，不保留表格结构、图片与批注；Markdown 与 DOCX 的标题样式不识别为章节，章节识别仅针对纯文本行规则。
- JSON 仅做扁平化，嵌套深度超过 8 层的内容会被截断。
- 与上游 0.4.x 的分叉位置与合并策略见 [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md)。

## 开发与维护

- 开发说明见 [DEVELOPMENT.md](DEVELOPMENT.md)；
- 测试：`node test/run-all.mjs`（smoke、layers、section-rerank、chapter 四套）；
- 持续集成：`.github/workflows/ci.yml`，覆盖 Ubuntu / Windows 与 Node 20 / 22；
- 上游同步：不自动跟随，按需 `git fetch upstream && git merge`，冲突热点与步骤见 `UPSTREAM-DIFF.md`。

## 许可证

MIT。本项目源于 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT），原始版权归原作者所有。
