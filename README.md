# dsh-pure-search

[![ci](https://github.com/silentlamb05147/dsh-pure-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/silentlamb05147/dsh-pure-search/actions/workflows/ci.yml)

**A local document search plugin for DeepSeek Harness: index Markdown, TXT, PDF, DOCX, HTML and JSON into a workspace- and session-scoped local index, and return every hit with a verifiable source location.**

English | [简体中文](README.zh.md)

| Version | License | Runtime |
|---|---|---|
| 1.0.0 (2026-11-17) | MIT | DSH 0.2.1-rc.2 / 0.2.2-rc.1; Node.js ≥ 18; Python ≥ 3.9 |

Rebuilt from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT) at 0.4.x. The tool interface and on-disk index format are preserved; DOCX/HTML/JSON parsing, workspace/session layers, chapter detection and reading, section-level reranking, and retrieval-path performance are new. The plugin runs fully offline: no network requests, no model calls, no listening sockets.

---

## What it solves

| Problem | Approach | Verifiable result |
|---|---|---|
| The full document does not fit in context | Return only matching passages with line ranges; expand with `kb_get`, or read a whole chapter | 2.7 ms per lookup; every hit carries `path`, `heading`, `start_line` / `end_line` |
| The same files are re-read every turn | Ingest once; the index stays resident and invalidates on `(mtime, size)` change | 2.7 ms at 395 chunks; 45 ms at 10,000 chunks |
| Documents from different projects bleed together | Separate workspace-shared and session-private layers; query session first, fall back explicitly | Scores are never mixed; responses include `layer`, `fell_back`, `fallback_reason` |
| Citations cannot be checked | Every hit includes document path, title, chapter title and 1-based line range | Jump directly to the source lines |
| The right document, the wrong passage | Two-stage reranking: order documents first, then rescore passages inside each document without the identifying tokens | Answer-bearing passages in results: 24% → 95% on 100 synthetic questions |
| Long novels or histories have no structure | Detect chapter lines (`第N章/卷/节/回`, `卷N`, `…纪/传/志`), attach chunks to chapters, read a whole chapter | 438 chapters in 1.33M characters; 130 biographies in the 590k-character *Jinshu* |
| Do not want a plugin that calls out or calls models | Parsing, indexing and retrieval are entirely local | No network, no sockets, no model calls |
| Worried a DSH upgrade breaks the plugin | Register host-side tools only; no client injection | Not affected by client API changes |

### Suitable / not suitable

**Suitable**: locating exact keywords, quotations, file names, function names and identifiers; building a citable search layer for project docs, specs and notes; chapter lookup in long novels, histories and scripts; isolating documents across projects on one machine; offline and air-gapped environments.

**Not suitable**: fuzzy search dominated by paraphrase (current recall 4–6 / 10); answer generation, summarisation or rewriting; scanned PDFs (OCR first); semantic recall without accepting ~2 GB of vector dependencies.

## Facts at a glance

| Metric | Value | Condition |
|---|---|---|
| Per-query latency | median **2.7 ms**, p95 6.6 ms | 395-chunk Chinese corpus, engine reused, index warm |
| 10k-chunk latency | median **45 ms** | synthetic corpus; upstream implementation 1,077 ms under the same conditions |
| Literal retrieval | top-1 **10 / 10** | literal questions in a 20-question real-novel set |
| Semantic retrieval | top-1 **4 / 10**, top-5 **6 / 10** | paraphrase questions in the same set |
| Passage hit rate | **24% → 95%** | 100 synthetic questions over 50 documents, answer passage in results |
| Chapter detection | 438 chapters / 130 biographies | 1.33M-character novel; 590k-character *Jinshu* |
| Ingest time | 132 ms / 746 ms | 8 docs / 376 chunks; 37 docs / 2,013 chunks |

## Core features

| Feature | Description |
|---|---|
| Lightweight | 133 KB engine, 48 KB plugin, Python standard library only; no runtime dependencies; install and removal touch a single directory |
| Low latency | In-process caching; no repeated tokenisation or index rebuilds on the query path |
| Passage-level ordering | Documents first, passages second, reducing "right document, wrong passage" |
| Chapter support | Plain-text chapter detection; `kb_get path + chapter` returns a whole chapter with line ranges |
| Faithful citations | Returns original text and location; no rewriting, summarising or polishing |
| Layer isolation | Workspace-shared and session-private layers with explicit fallback markers |
| Host compatibility | No `dsh.client` entry; host tools only |
| Maintainable | Upstream git history and tags preserved; four test suites and CI |

## Design principles

1. **Offline by default** — retrieval, parsing and indexing make no network calls; optional dense retrieval is off by default.
2. **Citations over answers** — return source text and location; never generate answers.
3. **Minimal dependencies** — BM25, tokenisation and DOCX/HTML/JSON parsing use the standard library; only PDF requires PyMuPDF.
4. **Non-invasive** — no client entry point, no DSH UI changes.
5. **Predictable behaviour** — layers, fallback, cache invalidation and index state are explicit fields.

## How it works

**Plugin layer (Node.js, ESM)** — registers eight host tools and performs argument validation, layer-path resolution and tool description. No client code.

**Engine layer (Python ≥ 3.9)** — `engine/kb_engine.py` runs as a separate subprocess and speaks NDJSON over stdin/stdout, one JSON response per request.

**Retrieval** — BM25 over Chinese bigrams; optional dense vectors (`BAAI/bge-small-zh-v1.5`) fused with RRF in hybrid mode; per-call weight overrides, `top_k` and `include_superseded`.

**Section reranking** — after retrieval, documents are ordered by their best passage; inside each document the tokens used to identify it (title, path) are removed from the query, the remaining terms are rescored against that document's passages, and passages matching the chapter heading receive a boost. A chapter named directly in the query (for example `第140章` or `谢安传`) receives additional weight.

**Index and cache** — `manifest.json` stores file digests and document metadata; `chunks.jsonl` stores text, chapter titles and line ranges; `sync-state.json` and `sync-log.jsonl` record sync state. Chunk lists, tokenisations and the BM25 inverted index are cached in-process and invalidated by the `(mtime_ns, size)` of `chunks.jsonl` and by `root::doc_id`.

**Layers** — `<kb_root>/<workspace>/_shared` holds workspace-shared documents; `<kb_root>/<workspace>/sessions/<session>` holds session-private ones. Queries hit the session layer first, fall back to the workspace layer, and report `layer`, `fell_back` and `fallback_reason`. Without an explicit `workspace`, the workspace name is derived from the current session's working directory.

## Supported formats

| Format | Parsing | Citation info | Notes |
|---|---|---|---|
| `.md` / `.markdown` | Heading-aware chunking; front matter recognised | Title, chapter heading, line range | `status: superseded` documents are down-weighted |
| `.txt` | Plain-text chunking; chapter lines detected | Line range, chapter title | Paragraph chunking when no chapter lines exist |
| `.pdf` | Text extraction via PyMuPDF | Page number | Scanned files have no text layer; OCR first |
| `.docx` | `word/document.xml` parsed with `zipfile` | Title (`dc:title`; first paragraph as fallback) | Tables and images are treated as plain text |
| `.html` / `.htm` | `HTMLParser`; script/style nodes skipped | `<title>` | Block-level tags become newlines |
| `.json` | Flattened recursively to `a.b[0] = value` | Key path | Depth limit 8, 2,000 characters per value, 2 MB total |

Recursive ingestion skips hidden directories, `.git`, `node_modules`, `.venv` and `__pycache__`; other extensions are ignored during directory walks and return `unsupported_extension` when named explicitly.

## Tool reference

| Tool | Purpose | Main arguments |
|---|---|---|
| `kb_ingest` | Ingest documents | `paths`, `workspace`, `session`, `force`, `prune`, `max_files`, `chunk_chars`, `chunk_overlap`, `max_file_mb`, `with_embeddings` |
| `kb_search` | Search passages | `query`, `workspace`, `session`, `fallback`, `top_k`, `mode`, `weights`, `include_superseded`, `context` |
| `kb_ask` | Return evidence and sources | As `kb_search`, plus `max_chars` |
| `kb_outline` | List documents and headings | `query` (path or title filter), `workspace`, `session`, `limit` |
| `kb_get` | Read source text by path or chunk ID; read a whole chapter with `path + chapter` | `path`, `chunk_id`, `chapter`, `start_line`, `end_line`, `max_chars` |
| `kb_stats` | Index statistics and health | `workspace`, `session` |
| `kb_sync` | Incremental sync | `max_files`, `prune` |
| `kb_clear` | Clear indexes | `scope`: `session` / `workspace` / `all` |

`kb_ask` returns source passages and locations only; no rewriting, summarising or polishing. Every 30 seconds the plugin lazily scans ingested directories: new and changed files are ingested, deleted files are marked `missing`.

## Performance and accuracy

Measured on a standard Windows desktop with Chinese corpora, warm index and a reused engine process:

| Metric | Result |
|---|---|
| 7 docs / 259 KB / 376 chunks, 7 natural-language questions, top-3 | 7 / 7 |
| Per-query latency | median 2.7 ms, p95 6.6 ms |
| 10,000-chunk synthetic corpus | median 45 ms (upstream 1,077 ms under the same conditions) |
| Ingest 8 docs / 376 chunks | 132 ms |
| Ingest 37 docs / 2,013 chunks | 746 ms |
| 1.33M-character novel (1,472 chunks / 438 chapters) | first query 3.3 s (cache build); median 16.7 ms afterwards |
| 590k-character *Jinshu* (695 chunks / 130 biographies) | first query 1.9 s; median 8.8 ms afterwards |

Accuracy is measured on 20 real-novel questions with human-labelled expected chapters and anchor passages:

| Question type | top-1 | top-5 |
|---|---|---|
| Literal (exact phrase or term) | 10 / 10 | 10 / 10 |
| Semantic (paraphrase) | 4 / 10 | 6 / 10 |
| Overall | 14 / 20 | 16 / 20 |

A synthetic set (50 documents / 200 questions, document level) also measured literal `doc@1` at 100% and paraphrase `doc@1` at 90%; question wording overlaps document text heavily, so those numbers are optimistic and are not presented as public claims.

## Installation and upgrade

From the git repository:

```powershell
dsh plugin --profile desktop add "git+https://github.com/silentlamb05147/dsh-pure-search.git"
```

For local development, install via link:

```powershell
dsh plugin --profile desktop add "link:<repo path>"
```

Restart DSH after installation. Build an index before first use (tool names keep the `kb_*` prefix for upstream compatibility):

```json
{ "paths": ["<project>/docs"], "workspace": "my-project" }
```

To upgrade, run `add` again and restart DSH; the index format is backward compatible and needs no rebuild.

## Known limitations

- The first query after a cold start loads the index (about 12 ms; process start about 130 ms). Very large single files build a cache on first query (about 3.3 s for 1.33M characters).
- Paraphrase recall is 4–6 / 10. Dense retrieval is off by default and requires about 2 GB of extra dependencies.
- Scanned PDFs have no text layer and require OCR first.
- DOCX extraction keeps body text only; tables, images and comments are not preserved. Markdown and DOCX heading styles are not treated as chapters; chapter detection works on plain-text line rules only.
- JSON is flattened only; nesting deeper than 8 levels is truncated.
- Divergence from upstream 0.4.x and the merge strategy are documented in [UPSTREAM-DIFF.md](UPSTREAM-DIFF.md).

## Development

- Developer notes: [DEVELOPMENT.md](DEVELOPMENT.md);
- Tests: `node test/run-all.mjs` (smoke, layers, section-rerank, chapter);
- CI: `.github/workflows/ci.yml`, Ubuntu and Windows, Node 20 and 22;
- Upstream sync: not automatic; merge on demand with `git fetch upstream && git merge`; conflict hotspots and steps are in `UPSTREAM-DIFF.md`.

## License

MIT. Derived from [imaused/dsh-kb-lite](https://github.com/imaused/dsh-kb-lite) (MIT); original copyright remains with the original author.
