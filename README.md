# dsh-pure-search

**Pure local search for DeepSeek Harness: ingest Markdown, TXT, PDF, Word, HTML and JSON into a workspace/session layered index, then retrieve the exact passage with a citation you can check.**

English | [简体中文](README.zh.md)

> Derived from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT) and rebranded as an independent project: **DOCX / HTML / JSON parsing**, **workspace/session layered indexes with fallback**, **retrieval performance work**, and **CI + regression tests**. Fully offline: no network, no model calls, no sockets.

---

## The problem

Handing documents to a model runs into four familiar problems: the context fills up, files get re-read every turn, documents from different projects blur together, and citations are hard to verify.

This plugin lifts "find the passage" out of the conversation and gives it to a local index:

- ingest once, then query the index instead of re-reading files;
- Chinese text is tokenised into character bigrams for BM25, so paraphrased questions still hit; optional dense vectors can be mixed in;
- every hit carries `path`, `title`, `heading`, `start_line/end_line` or `page` — verifiable as-is;
- indexes are split per workspace and, optionally, per session, so projects do not contaminate each other.

## Supported documents

| Format | Parser | Citation | Notes |
|---|---|---|---|
| `.md` / `.markdown` | heading-aware chunking, front-matter aware | title, heading, line numbers | `status: superseded` is down-weighted |
| `.txt` | plain-text chunking | line numbers | — |
| `.pdf` | PyMuPDF text extraction | page numbers | no OCR for scanned PDFs |
| `.docx` | stdlib `zipfile` + `word/document.xml` | `dc:title` or first paragraph | text only; no tables/images/styles |
| `.html` / `.htm` | `HTMLParser`, skipping script/style/noscript/template/svg/canvas | `<title>` | block-level tags become line breaks |
| `.json` | recursive flattening to `a.b[0] = value` | key path | depth 8, 2,000 chars per value, 2 MB total |

Directories are walked recursively, skipping hidden directories, `.git`, `node_modules`, `.venv` and `__pycache__`. Other extensions are ignored during a walk and reported as `unsupported_extension` when named explicitly.

## How it works

**Plugin layer (Node.js, ESM)**: registers eight host-only tools. `package.json` deliberately has no `dsh.client` field — no client-side injection, so a DSH client API change cannot break it (DSH starts all-or-nothing, which matters here).

**Engine layer (Python 3.9+)**: a child process runs `engine/kb_engine.py`, speaking NDJSON over stdin/stdout, one JSON response per request. BM25 uses only the standard library; `pymupdf` is needed only for PDF; `numpy` + `sentence-transformers` only for dense retrieval.

**Retrieval**: BM25 over character bigrams for Chinese, plus optional dense vectors (`BAAI/bge-small-zh-v1.5`); hybrid mode fuses the two rankings with RRF. Weights, `top_k` and `include_superseded` are per-call. Phrase boosts reward exact-phrase, title and path matches.

**Index**: `manifest.json` stores a content sha256 per file, so unchanged files are skipped, changed ones re-parsed, `force` re-parses everything; `vectors.meta`, `sync-state.json` and `sync-log.jsonl` record vector metadata, sync times and history. Chunks and the BM25 index are cached in-process and invalidated by the `(mtime, size)` of `chunks.jsonl`.

**Layering**: `<kb_root>/<workspace>/_shared` holds shared workspace documents; `<kb_root>/<workspace>/sessions/<session>` holds session-private ones. Queries look at the session layer first and fall back to the workspace layer only when nothing matches; scores are never mixed across layers, and the fallback is reported as `fell_back` with a reason (`session_empty` / `no_hits`). Without an explicit `workspace`, the current session's working directory determines the workspace name.

## Measured

Seven Chinese documents (259 KB, 376 chunks), seven natural-language questions, on an ordinary Windows machine:

| Metric | Result |
|---|---|
| Top-3 hit rate on Chinese NL questions | **7 / 7** |
| Query latency (engine reused, index cached) | median **2.7 ms**, p95 6.6 ms |
| Query latency (first query / cold start) | ~12 ms / 134 ms (process startup dominates) |
| Query latency on a 10,000-chunk synthetic corpus | median **45 ms** (same corpus, upstream implementation: ~1,077 ms) |
| Index build, 8 docs / 376 chunks | 132 ms |
| Index build, 37 docs / 2,013 chunks | 746 ms |
| Baseline: literal substring scan | 0.1 ms, 2 / 7 hits |
| Baseline: PowerShell `Select-String` | ~780 ms, 2 / 7 hits |

So: **use grep for filenames, constants and function names; use the knowledge base for "which document covered this"** — literal matching fails on paraphrased questions, and one extra model round trip costs seconds.

## Install

From the Git repository (recommended before the first npm release):

```powershell
dsh plugin --profile desktop add "git+https://github.com/silentlamb05147/dsh-pure-search.git"
```

For local development, link the checkout so edits apply immediately:

```powershell
dsh plugin --profile desktop add "link:<path-to-this-repo>"
```

Restart DSH after installing. Build an index on first use (tool names keep the `kb_*` prefix for upstream API compatibility):

```json
{ "paths": ["<your-project>/docs"], "workspace": "my-project" }
```

## The eight tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `kb_ingest` | Ingest files or directories | `paths`, `workspace`, `session`, `force`, `prune`, `max_files`, `chunk_chars`, `chunk_overlap`, `with_embeddings` |
| `kb_search` | Retrieve matching passages | `query`, `workspace`, `session`, `fallback`, `top_k`, `mode`, `weights`, `include_superseded`, `context` |
| `kb_ask` | Evidence passages with citations | same as search, plus `max_chars` |
| `kb_outline` | List indexed documents and their headings | `query` (path/title filter), `workspace`, `session`, `limit` |
| `kb_get` | Read a document by path or a chunk by id | `path`, `chunk_id`, `start_line`, `end_line`, `max_chars` |
| `kb_stats` | Index statistics | `workspace`, `session` |
| `kb_sync` | Incremental sync | `max_files`, `prune` |
| `kb_clear` | Clear an index layer | `scope`: `session` / `workspace` / `all` |

`kb_ask` returns passages only — no rewriting, no summarising, no polishing; citation fidelity comes first. `kb_outline` reads only `manifest.json`; `kb_get` parses the original file and can expand a chunk by its `chunk_id`.

Every 30 seconds the plugin lazily scans indexed directories: changed and newly added supported files are ingested incrementally, deleted ones are marked `missing`. No manual `kb_sync` is required.

## Known limitations

- the first query after a cold start loads the index (~12 ms on top of ~130 ms process startup); afterwards it is served from memory;
- scanned PDFs have no text layer and need OCR first;
- DOCX keeps text only — no table structure, images or comments;
- JSON is flattened; nesting beyond depth 8 is truncated;
- dense retrieval needs ~2 GB of dependencies and is off by default;
- the fork point against upstream 0.4.x and the merge strategy live in [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md).

## Open source and releases

- **License**: MIT, retaining the upstream copyright and LICENSE;
- **Versioning**: independent `1.0.0` onwards, no longer the `-local.N` suffix;
- **Upstream**: not tracked automatically; merge on demand with `git fetch upstream && git merge`, see `UPSTREAM-DIFF.md`;
- **Compatibility**: verified on DSH 0.2.1-rc.2 / 0.2.2-rc.1, Node.js 18+, Python 3.9+;
- **Development and tests**: see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. Derived from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT); original copyright remains with its authors.
