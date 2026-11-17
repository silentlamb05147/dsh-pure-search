# dsh-pure-search

**Pure-local retrieval for DeepSeek Harness: index Markdown, TXT, PDF, Word, HTML and JSON, store them per-workspace / per-session, and get every hit back with a verifiable citation.**

English | [简体中文](README.zh.md)

> Derived from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT) and rebuilt as an independent project on top of its 0.4.x line: **DOCX / HTML / JSON parsing**, **workspace/session layered index with fallback**, **chapter detection and whole-chapter reads**, **two-stage passage reranking**, **query-path performance work**, and **CI / regression tests**. Fully offline — no network, no model calls, no sockets.

---

## Why use it (measured)

| Advantage | Measured | What it means |
|---|---|---|
| **Light** | 133 KB engine + 48 KB plugin, Python stdlib only, zero runtime deps | Install is one directory, uninstall is clean; no 2 GB model stack for search |
| **Fast** | 395 chunks: **2.7 ms** (p95 6.6); 10,000 chunks: **45 ms** (upstream ~1,077 ms) | Day-to-day search costs a fraction of one model turn; still flat at 25× the corpus |
| **Right passage** | Synthetic 50 docs / 100 questions: answer-in-results **24% → 95%** | Not "right document, wrong paragraph": doc-first, then in-document rerank after stripping identity tokens |
| **Chapters** | 1.33M-char novel: 1,472 chunks / 438 chapters; 591K-char *Jinshu*: 695 chunks / 130 biographies; `kb_get path+chapter` returns the whole chapter | No more "search, then guess the line number" for long books |
| **Citations** | Every hit carries `path` / `title` / `heading` / `start_line` / `end_line` / `page` | You can verify the quote at the line level |
| **No cross-project bleed** | `<workspace>/_shared` and `sessions/<session>`, session-first with explicit fallback | Different projects never see each other's documents or ranks |
| **No client injection** | No `dsh.client` field; registers 8 host-side tools only | A DSH client-API bump cannot take it down (DSH boots all-or-nothing) |
| **Maintainable** | Upstream git history and tags kept, 4 test suites + GitHub Actions | Not a one-shot fork; upstream fixes can be merged on demand |

## What problem it solves

Four common pains when feeding documents to a model: context doesn't fit, files are re-read every turn, documents from different projects bleed together, and citations can't be checked.

This plugin takes "find the source text" out of the conversation and hands it to a local index:

- documents are ingested once, then only the index is queried;
- Chinese is tokenized into bigrams for BM25, so word order and phrases work — **paraphrases rely on lexical overlap and are limited; that is BM25's ceiling, not a hidden feature**;
- every hit carries `path`, `title`, `heading`, `start_line/end_line` or `page` for verification;
- the index is split by workspace and then by session, so projects don't mix.

## Supported formats

| Format | Parsing | Citation | Notes |
|---|---|---|---|
| `.md` / `.markdown` | heading-aware chunking, front-matter aware | title, heading, lines | `status: superseded` is down-weighted |
| `.txt` | plain-text chunking; detects `Chapter N` / `卷N` / `…纪/传/志` chapter lines | lines, chapter title | falls back to greedy paragraph chunks |
| `.pdf` | PyMuPDF text extraction | page | scanned PDFs need OCR first |
| `.docx` | stdlib `zipfile` + `word/document.xml` | title (`dc:title`, else first paragraph) | tables/images flattened to text |
| `.html` / `.htm` | `HTMLParser`, skipping script/style/noscript/template/svg/canvas | `<title>` | block tags become line breaks |
| `.json` | recursive flatten to `a.b[0] = value` | key path | depth 8, 2,000 chars/value, 2 MB total |

Directory ingest skips hidden dirs, `.git`, `node_modules`, `.venv`, `__pycache__`. Other extensions are ignored during traversal and reported as `unsupported_extension` when named explicitly.

## How it works

**Plugin layer (Node.js, ESM)**: registers eight host-side tools and deliberately omits `dsh.client`, so there is no client injection to break on DSH upgrades.

**Engine layer (Python 3.9+)**: a child process runs `engine/kb_engine.py` over NDJSON on stdin/stdout. BM25 uses the stdlib only; PDF needs `pymupdf`; dense retrieval needs `numpy` + `sentence-transformers`.

**Retrieval**: BM25 (CJK bigrams) plus optional dense vectors (`BAAI/bge-small-zh-v1.5`) fused with RRF. After retrieval, a two-stage rerank picks documents first, then re-scores passages inside each document with identity tokens (title/path) removed, and boosts passages whose chapter title is named in the query.

**Chapters**: plain-text documents are chunked at chapter lines; `kb_get path + chapter` returns the chapter body with 1-based line ranges. Chapter detection is line-level only (`第N章/卷/节/回/篇/部/集`, `卷N`, `数字. 标题`, `…纪/传/志/载记/表/书`).

**Index and caches**: `manifest.json` stores sha256 and document metadata; `chunks.jsonl` stores text and line ranges; `sync-state.json` / `sync-log.jsonl` record sync state. Chunk lists, token caches and BM25 postings are cached in-process and invalidated by `chunks.jsonl` `(mtime_ns, size)` and `root::doc_id`. `top_k` is exact (no more `max(top_k, 24)`).

**Layering**: `<kb_root>/<workspace>/_shared` for shared documents, `<kb_root>/<workspace>/sessions/<session>` for session-private ones; session first, workspace fallback, scores never mixed, `fell_back` / `fallback_reason` reported. Without `workspace`, the name comes from the session working directory (DSH 0.2.1: `session.header.cwd`).

## Benchmarks

Windows machine, Chinese corpora:

| Metric | Result |
|---|---|
| 7 docs / 259 KB / 376 chunks, 7 natural-language questions, top-3 | **7 / 7** |
| Single query (warm process, cached index) | median **2.7 ms**, p95 6.6 ms |
| 10,000-chunk synthetic corpus, single query | median **45 ms** (upstream 1,077 ms) |
| Ingest 8 docs / 376 chunks | 132 ms |
| Ingest 37 docs / 2,013 chunks | 746 ms |
| 1.33M-char novel (1,472 chunks / 438 chapters) | first query 3.3 s (cache build); then **16.7 ms** |
| 591K-char *Jinshu* (695 chunks / 130 biographies) | first query 1.9 s; then **8.8 ms** |

**Accuracy** (20 real-novel questions, human-written expected chapters + anchor text):

| Question type | top-1 | top-5 |
|---|---|---|
| Literal (original wording) | **10 / 10** | 10 / 10 |
| Semantic (paraphrase) | **4 / 10** | **6 / 10** |
| Total | 14 / 20 | 16 / 20 |

Synthetic set (50 docs / 200 questions, document level): literal `doc@1` 100%, paraphrase `doc@1` 90% — optimistic (high lexical overlap), not a public claim.

Bottom line: **fast and precise for keywords, original sentences, filenames, constants and identifiers; paraphrased questions land at 4–6/10, which is BM25's ceiling.** Semantic recall needs a ~2 GB dense stack, which is off by default.

## Install

From Git (recommended during early release):

```powershell
dsh plugin --profile desktop add "git+https://github.com/silentlamb05147/dsh-pure-search.git"
```

Local development via link:

```powershell
dsh plugin --profile desktop add "link:<your-repo-path>"
```

Restart DSH afterwards. Ingest first (tool names keep the `kb_*` prefix for upstream API compatibility):

```json
{ "paths": ["<your-project>/docs"], "workspace": "my-project" }
```

## Eight tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `kb_ingest` | Ingest documents | `paths`, `workspace`, `session`, `force`, `prune`, `max_files`, `chunk_chars`, `chunk_overlap`, `max_file_mb`, `with_embeddings` |
| `kb_search` | Search passages | `query`, `workspace`, `session`, `fallback`, `top_k`, `mode`, `weights`, `include_superseded`, `context` |
| `kb_ask` | Verbatim evidence with citations | same, plus `max_chars` |
| `kb_outline` | List documents and heading tree | `query` (path/title filter), `workspace`, `session`, `limit` |
| `kb_get` | Read text by `path` or `chunk_id`; `path + chapter` returns a whole chapter | `path`, `chunk_id`, `chapter`, `start_line`, `end_line`, `max_chars` |
| `kb_stats` | Index stats and health | `workspace`, `session` |
| `kb_sync` | Incremental sync | `max_files`, `prune` |
| `kb_clear` | Clear index | `scope`: `session` / `workspace` / `all` |

`kb_ask` returns verbatim passages and citations only — no rewriting, summarizing or polishing. Every 30 seconds the plugin lazily scans ingested directories: changes and additions are ingested, deletions are marked `missing`.

## Known limitations

- First query after a cold start loads the index (~12 ms; process start ~130 ms); very large single files build caches on first query (1.33M chars ≈ 3.3 s);
- Paraphrase recall is 4–6/10; dense retrieval is off by default and needs extra dependencies;
- Scanned PDFs have no text layer and need OCR first;
- DOCX text only — no tables, images or comments; md/docx heading styles are not treated as chapters (chapters are plain-text line rules only);
- JSON is flattened, nested values beyond depth 8 are truncated;
- Fork point and merge strategy: see [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md).

## Open source and release

- **License**: MIT, upstream copyright and LICENSE preserved;
- **Versioning**: independent from `1.0.0`;
- **Upstream merges**: not automatic; `git fetch upstream && git merge` on demand — see `UPSTREAM-DIFF.md`;
- **Compatibility**: validated on DSH 0.2.1-rc.2 / 0.2.2-rc.1, Node.js 18+, Python 3.9+;
- **Development and tests**: see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. Derived from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT); original copyright remains with its author.
