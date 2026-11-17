# Security model

This describes version 1.0.0 of `dsh-pure-search`: one host-only DSH plugin, eight tools, one long-lived Python engine process, and two timers inside the host process (a 300 ms warmup and a 30 s watch). Every claim below is written so you can check it against the files in this repository; the commands to do that are at the end.

Nothing here is a request for trust. If a line in this document and a line in the code disagree, the code is what runs.

## Execution model

`dsh-pure-search` is loaded by DSH as a host plugin. It has no browser UI, no client bundle, and no `dsh.client` field in `package.json` — it contributes nothing to the DSH web or desktop client and cannot interfere with it. There is no HTTP server and no listening socket.

When the plugin is applied it registers eight tools and stays idle until the first tool call. That call resolves a Python interpreter, checks it with a short probe process, and starts one engine process for the lifetime of the plugin instance. Two DSH instances that load the plugin have two engines, one each; there is no daemon and no shared service.

Two `setInterval` timers exist in the host process, both `unref()`ed so they never keep the process alive:

| Timer | Interval | What it does |
| --- | --- | --- |
| warmup | 300 ms after registration | Sends `ping`, then a background `warmup` (loads caches). |
| watch | 30 s | Calls the engine's `watch` op: re-stats indexed files, ingests changed/new supported files, marks deleted ones `missing`. |

Disable watch with `watch: false` in the plugin config. Both timers are cleared on `dispose()`.

## The engine process

Its spawn call is in `lib/rpc.js`:

```js
const child = spawnFn(argv[0], argv.slice(1), {
  cwd,
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...(env && typeof env === 'object' ? env : {}),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
```

| Part | Value |
| --- | --- |
| `argv[0]` | `cachedPython`: the first candidate that passed the probe — `KB_LITE_PYTHON` if set, otherwise `python`, then `python3`, then `py`. |
| `argv[1]` | `enginePath`: absolute path to `engine/kb_engine.py` inside the installed package. |
| Further arguments | None. No file paths, no queries, no flags. |
| Shell | None. `spawn` is called with an argument vector and without `shell: true`. |
| `cwd` | The plugin's `cwd` option, otherwise the DSH process's working directory. Document paths are always absolute, so the child's cwd is not used to resolve them. |
| `stdio` | All three piped; requests on stdin, responses on stdout, logs on stderr. |
| `env` | Parent environment, then `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, then any plugin-configured environment. |
| `windowsHide` | No console window on Windows. |

The transport is NDJSON: one JSON object per line, UTF-8, LF, no BOM. Every response echoes the request `id`; an unhandled exception becomes an `ok: false` line rather than a crash.

## The interpreter probe

Before the engine starts, the candidate interpreter is checked with a one-shot `spawnSync`:

```js
const result = spawnSync(
  candidate,
  ['-c', 'import sys; sys.stdout.write("ok")'],
  { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
)
```

The argument is a fixed string; nothing from your documents, query or configuration is placed in it. It runs as your user, exits immediately, and its output decides whether that interpreter is used.

## Lifetime and restarts

- The engine starts lazily, on the first tool call.
- If it exits unexpectedly, in-flight requests are rejected with `engine_restarted` and a replacement starts, up to 3 times with 150–500 ms backoff; then state is `engine_dead` until DSH restarts.
- At most one engine process per plugin instance is alive.
- On dispose, stdin is closed, then `SIGTERM`, then `SIGKILL` if still alive after one second.

## What it reads

- **Files you pass to `kb_ingest`.** Paths must be absolute. A file is read only if its extension is `.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, `.html`, `.htm` or `.json`. Directory walks skip hidden directories and `.git`, `.hg`, `.svn`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.tox`, `.idea`, `.vscode`; unsupported files are not read.
- **Its own index roots.** `manifest.json`, `chunks.jsonl`, `sync-state.json`, `sync-log.jsonl`, `engine.log`, and vector files if present.
- **Its own package files.** `engine/kb_engine.py`.

Nothing else. It does not read DSH configuration, credentials, browser data, shell history, or your home directory at large. The `paths` argument is the entire input surface and is checked for absoluteness before anything is opened.

## What it writes

Only inside the resolved index root (default `~/.kb-lite`, or the layered `<root>/<workspace>/_shared` and `<root>/<workspace>/sessions/<session>`):

| File | Contents |
| --- | --- |
| `manifest.json` | Per-document metadata: path, `sha256`, mtime, size, title, kind, page count, chunk count, headings. |
| `chunks.jsonl` | One JSON object per chunk, including the chunk's **full text**. |
| `sync-state.json` | Last successful sync timestamp and paths. |
| `sync-log.jsonl` | Append-only sync audit lines. |
| `vectors.npy` / `vectors.json` / `vectors.meta.json` | Optional embeddings, when the dense stack is available. |
| `engine.log` | Engine log lines; engine stderr is mirrored here. |

Writes are atomic: the engine writes `<name>.tmp.<pid>` inside the root and renames it into place. Index paths go through `_child(root, name)`, which resolves the real path and raises `path_escape` if a file would land outside the root. `kb_clear` deletes index files only; source documents are never touched.

Two consequences worth stating plainly:

- **The index contains your documents' text in plain text, unencrypted.** Protect the index directory the way you protect the sources.
- **It runs with your privileges.** There is no sandbox and no privilege drop. If your user can read a path and you pass it to `kb_ingest`, the engine can read it too.

## What it downloads

**Nothing.** No installer download, no model fetch on the BM25 path, no update check, no telemetry, no remote index.

If you install the optional dense stack, `sentence-transformers` (your own third-party install) downloads `BAAI/bge-small-zh-v1.5` from Hugging Face the first time it loads the model. That connection belongs to that library, not to this plugin, and it does not occur on a BM25-only install.

## Network

The engine imports no `socket`, `http`, `urllib`, `requests` or equivalent, and it neither listens on nor connects to a port. Its file descriptors are stdin, stdout, stderr, the index files, and the document paths you named.

## Credentials

None. No API key, token, cookie, account or login. No environment variable carrying a secret is read.

It inherits your environment (`...process.env`), as any child process does; that is inheritance, not use.

## Install-time behaviour

`package.json` declares no `preinstall`, `install` or `postinstall` script and has no `dependencies` — only `peerDependencies` on `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`, which DSH provides. Installing the plugin therefore does not execute plugin code and does not pull third-party npm code into the profile.

The Python side has no `pip install` step. On the BM25 path the engine imports only the standard library; `fitz` (pymupdf) is optional for PDF, `numpy` + `sentence_transformers` optional for dense.

## Verify it yourself

Run these from the repository root.

**1. List every process-creation site in the host half.**

```sh
node -e "require('fs').readFileSync('lib/rpc.js','utf8').split('\n').forEach((l,i)=>{if(/spawn/i.test(l))console.log((i+1)+': '+l)})"
```

Expect the `node:child_process` import, the probe `spawnSync(...)`, the engine start `spawnFn(argv[0], argv.slice(1), ...)`. There should be no `shell: true`.

**2. Confirm there are no network primitives in the engine.**

```powershell
Select-String -Path engine\kb_engine.py -Pattern 'socket|urllib|requests|http\.client|urlopen|socketserver'
```

Expect no output.

**3. Confirm there is no network code in the host half.**

```powershell
Select-String -Path lib\index.js,lib\plugin.js,lib\rpc.js -Pattern 'node:http|node:https|node:net|fetch\('
```

Expect no output.

**4. List every import in the engine.**

```powershell
Select-String -Path engine\kb_engine.py -Pattern '^\s*(import|from) '
```

Every module named should be from the Python standard library, or one of the optional third-party ones: `fitz`, `numpy`, `sentence_transformers`.

**5. Confirm the engine is a local stdin/stdout program.**

```sh
echo '{"id":"1","op":"ping","params":{}}' | python engine/kb_engine.py
```

Expect a `ready` line, then `{"id":"1","ok":true,"result":{"pong":true,"version":"...","python":"..."}}`.

**6. Confirm the write guard exists.**

```powershell
Select-String -Path engine\kb_engine.py -Pattern 'def _child' -Context 0,8
```

Expect a function that joins a fixed file name onto the root, resolves the real path, and raises `path_escape` when the result would not be a direct child of the root.

**7. Watch the processes at runtime.** With DSH running and the plugin loaded, after any `kb_stats` call:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*kb_engine.py*' } |
  Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
```

Expect **one** long-lived row per DSH instance, with a command line of `"<python>" "<...>/engine/kb_engine.py"` and nothing else.

**8. Watch its sockets.** Take the engine `ProcessId` from step 7:

```powershell
Get-NetTCPConnection -OwningProcess <ProcessId> -ErrorAction SilentlyContinue
```

Expect no rows while queries and ingests run.

**9. Confirm the write boundary.** `kb_stats` returns the `kb_root` in use; list it:

```powershell
Get-ChildItem -Force (Join-Path $env:USERPROFILE '.kb-lite')
```

Expect only index files (and workspace subdirectories, if layered).

**10. Confirm there is no install script and no runtime dependency.**

```powershell
node -e "const p=require('./package.json');console.log(JSON.stringify({scripts:p.scripts,dependencies:p.dependencies||{},files:p.files},null,2))"
```

Expect `scripts` to contain only `test`, and `dependencies` to be `{}`.

## Reporting

If you find behaviour that contradicts this document, that is a security-relevant bug: open an issue with the version, platform and the command you ran. Do not include document contents or paths you consider private.
