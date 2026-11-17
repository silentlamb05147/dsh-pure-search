# 开发说明

本仓库是 [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite)（MIT）的独立分支：上游基线 0.4.11，已合并 0.4.12，之后按本项目的版本号演进（`1.0.0` 起），不再使用 `-local.N` 后缀。

## 目录结构

```
dsh-pure-search/
├── lib/
│   ├── index.js        插件入口：注册工具、启动引擎、定时 watch
│   ├── plugin.js       工具定义、参数校验、分层包装（session → workspace 回退）
│   └── rpc.js          NDJSON 子进程协议
├── engine/
│   └── kb_engine.py    单文件引擎：解析、分块、BM25、分层存储、watch
├── test/
│   ├── smoke.mjs       便携冒烟测试（无 DSH、无网络）
│   └── run-all.mjs     跑 smoke + layers
├── test-layers.mjs     分层与回退场景
├── scripts/
│   ├── check-upstream.mjs   比较与上游的 ahead/behind
│   ├── restore-drill.mjs    备份复原演练
│   └── kb-sync-audit.mjs    同步结果审计
├── docs/market-listing.md   市场文案草稿
├── cordis.patch.yml         安装补丁：插入 Host 插件行
├── UPSTREAM-DIFF.md         与上游的分叉点、合并策略
└── CHANGELOG.md
```

## 相对上游的主要改动

### 1. 新增三种入库格式

| 扩展名 | 实现 | 说明 |
|---|---|---|
| `.docx` | 标准库 `zipfile` + 解析 `word/document.xml` | 不依赖 python-docx；`dc:title` 为空时用首段当标题 |
| `.html` `.htm` | 标准库 `HTMLParser` | 跳过 script/style/noscript/template/svg/canvas；块级标签转换行；`<title>` 当标题 |
| `.json` | 标准库 `json`，递归扁平化 | 每行 `a.b[0] = 值`，让 BM25 同时命中键名和值；限深 8、单值 2000 字、全文 2 MB |

PDF 沿用上游实现（需要 `pymupdf`，无 OCR）。扩展名白名单在 `engine/kb_engine.py` 的 `SUPPORTED_EXTS`。

### 2. 工作区 / 会话分层 + 回退

索引目录约定：

```
<kb_root>/
  <工作区名>/
    _shared/                       工作区级文档
    sessions/<会话名>/              会话级文档
```

工具参数：`workspace`、`session`、`fallback`；`kb_clear` 增加 `scope`（`session` | `workspace` | `all`）；新增 `kb_outline`（只读 manifest 列文档与标题）与 `kb_get`（按 path 或 chunk_id 取原文、支持行区间）。

行为：

1. `kb_search` / `kb_ask` 先查会话层；
2. 会话层没有文档或没有命中时回退工作区层，返回 `layer: "workspace"`、`fell_back: true`、`fallback_reason: "session_empty" | "no_hits"`；
3. `fallback: false` 时只查会话层；
4. 两层分数不混合——两个索引的 BM25 统计彼此独立，只做“命中/未命中”切换。

省略 `workspace` 时退回旧的平铺行为（`kb_root` 直接当索引根），向后兼容。

### 3. 性能

- 块文本预算 `text_l`：入库时算一次 casefold，短语加权不再逐次转换。
- BM25 postings 直接携带 `(doc_index, tf)`，评分时不再逐条 `Counter.get`。
- 候选集用 `heapq.nlargest`，不再对全部文档排序。
- 索引与 chunks 按 `(mtime_ns, size)` 进程内缓存，`_save_chunks` / `op_clear` 主动失效。
- 修复 `top_k` 截断：此前返回 `ranked[:max(top_k, 24)]`，传 3 实际返回 24 条；现为 `ranked[:top_k]`。

实测（Windows，Python 3.15）：

| 语料 | search 中位 | p95 | 说明 |
|---|---|---|---|
| 395 块 | 2.7 ms | 6.6 ms | +context 3.0 ms |
| 10,000 块 | 45 ms | 60 ms | 同条件上游 1,077 ms |
| 冷启动 | spawn 120–134 ms | — | 首查 10–12 ms |

### 4. 质量与维护能力

- `watch`：插件每 30 s 扫描已入库目录，变更/新增自动入库，删除标 `missing`；`watch: false` 关闭。
- `context`：`kb_search` 命中附带前后邻块（各 300 字）与位置。
- 体积护栏：`max_file_mb`（参数 > `KB_LITE_MAX_FILE_MB` > 20 MB），超限报 `file_too_large`；`kb_stats` 返回 `warnings`（块数 > 5 万、体积 > 200 MB、缺失文档）。
- 自动作用域：不传 `workspace` 时依次取 `KB_LITE_WORKSPACE` → `options.workspace` → 会话工作目录名 → 宿主 cwd。
- 首查预热：注册 300 ms 后 ping 引擎并后台 `warmup`。
- 测试与 CI：`test/smoke.mjs` + `test-layers.mjs`，GitHub Actions 在 Ubuntu/Windows × Node 20/22 上跑 `node test/run-all.mjs`。

## 开发命令

```powershell
# 改完 Python 引擎后：结束引擎进程，宿主会自动重启它
Get-Process python | Stop-Process

# 改完宿主 JS 后：需要重启 DSH 才生效

# 端到端测试（不依赖 DSH）
node test/run-all.mjs      # smoke + layers
node test-layers.mjs       # 只跑分层场景
```

测试与基准会启动 Python 子进程并写索引目录；在 DSH 的受限沙箱里可能因 `EPERM` 失败，需要在允许子进程的环境下运行。

## 会话工作区解析

不同 DSH 宿主版本暴露的字段不同，当前按顺序尝试：

`agent.cwd → session.cwd → session.meta.cwd → session.header.cwd → session.header.workspace → exec.cwd → exec.workspace`

实测 DSH 0.2.1-rc.2 命中 `session.header.cwd`。若落到 DSH profile 目录（`…\.dsh\profiles\…`）则视为无工作区，退回非分层模式，避免生成垃圾 `desktop` 索引。

排查时设 `KB_LITE_DEBUG_SCOPE=1`，工具返回的 `scope.exec_probe` 会给出 `cwd_source`、`header_keys`、`session_keys` 等定位信息。

## 上游合并策略

- 上游基线固定为已合并的 0.4.12；不自动跟随。
- 本地 git 仓库保留了上游历史（remote `upstream`），需要时 `git fetch upstream && git merge upstream/master`，冲突热点与步骤见 `UPSTREAM-DIFF.md`。
- 发布物不依赖上游 npm 包；`peerDependencies` 只声明 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`。
