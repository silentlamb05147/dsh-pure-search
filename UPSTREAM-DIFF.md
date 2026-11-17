# 上游同步（upstream diff / merge）

本仓库是把 `dsh-kb-lite` 0.4.11 的 npm 包内容作为基线、加上本地改动后的 **git 仓库**。
目的：以后上游发版时，能用 `git` 看清差异、预演冲突、合并、回滚，而不是靠人工比对。

## 仓库关系

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/imaused/dsh-kb-lite.git`（remote 名 `upstream`） |
| 基线标签 | `v0.4.11`（= 我们 fork 的起点） |
| 本地分支 | `main`，跟踪 `upstream/master` |
| 基线提交 | `2a30785`（npm 0.4.11 文件树 + 本地改动） |
| 历史连接 | `git replace --graft 2a30785 v0.4.11`，让 `git log/merge` 认为我们的基线接在 v0.4.11 之后 |

> 由于 npm 包不含 `test/`、`docs/`、`.github/`，这些目录在本仓库里不存在；上游改动它们时会被视为“上游新增/修改”，合并可能多出这些文件，属正常。

## 日常检查（只看不改）

```powershell
cd <本仓库根目录>
git fetch upstream --tags --prune
git status -sb                              # 落后几个提交
git log --oneline HEAD..upstream/master     # 上游新增了什么
git diff --stat HEAD..upstream/master       # 哪些文件会变
git diff --ignore-cr-at-eol HEAD..upstream/master -- engine/kb_engine.py lib/plugin.js   # 忽略行尾看真实差异
```

## 预演合并冲突（不动工作区）

```powershell
git merge-tree --write-tree --name-only HEAD upstream/master
```

输出里 `CONFLICT (content): Merge conflict in <文件>` 就是需要人工处理的文件；退出码 1 表示有冲突。

## 真正合并

```powershell
git merge upstream/master
# 冲突逐个解决后：
git add -A
git commit -m "merge upstream v0.4.12"
```

合并后做冒烟：

```powershell
node --check lib/plugin.js
node test-layers.mjs
# 在 DSH 里：kb_stats + kb_search "如何避免 NPC 行为抖动"
```

回滚：`git reset --hard <合并前的提交>`（确认工作区干净后再做）。

## 冲突热点（按经验）

| 文件 | 原因 | 处理 |
|---|---|---|
| `package.json` | 上游每版都改 version/description/peerDependencies；本项目用独立包名与版本 | 保留 `name: dsh-pure-search`、`version: 1.0.0`、本项目的 description；`peerDependencies` 取上游更宽的范围 |
| `engine/kb_engine.py` | 我们加了 `SUPPORTED_EXTS` 的 docx/html/json、`extract_docx/extract_html/extract_json`、`_chunk_extracted` 等 | 保留我们的扩展，其余跟随上游 |
| `lib/plugin.js` | 我们加了分层参数（workspace/session/fallback/scope）、`layerRoots`、`runLayered*`、`toolDefinitions` 里的参数 | 保留分层逻辑，工具描述与上游新增字段合并 |
| `cordis.patch.yml` | 上游可能调整 config schema | 保留 `name: dsh-pure-search` |

## 行尾说明

- `.gitattributes` 统一 `* text=auto eol=lf`，`merge.renormalize=true`。
- 上游部分文件（`engine/kb_engine.py`、`lib/plugin.js`、`README.md`）在仓库里存的是 CRLF；合并时 git 会归一化，**不要手工转换工作区行尾**。
- 如果 `git status` 出现整文件“全改”，先检查是不是行尾被改过，用 `git diff --ignore-cr-at-eol` 复核。

## 当前状态（2026-11-17）

- 上游基线：已合并 **0.4.12**；本项目从该基线分出独立版本 `1.0.0`，不再使用 `-local.N` 后缀。
- 合并时只有 `package.json` 冲突：保留本项目的 `name` / `version` / description；`peerDependencies` 采用上游放宽后的 `@deepseek-ai/cordis >=4.0.0`、`@deepseek-ai/dsh-tools >=0.1.0-rc.6`。
- 上游 0.4.12 的 `lib/index.js` 改动（`loadDefineTool` 懒解析）已并入本项目。
- 后续合并步骤与冲突处理同上；合并后跑 `node test/run-all.mjs` 并重启 DSH 冒烟。
