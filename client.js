/**
 * dsh-pure-search — optional settings page.
 *
 * Index management only: the files currently in the index (name + real path,
 * searchable and filterable by type) and the recycle bin (restore / purge).
 * Every operation edits the index; files on disk are never touched.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-pure-search',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React;

    const API = '/api/pure-search';
    const STYLE_ID = 'dsh-pure-search-style';

    const CSS = `
.ps-root {
  --ps-border: rgba(127,127,127,.18);
  --ps-border-soft: rgba(127,127,127,.1);
  --ps-surface: rgba(127,127,127,.035);
  --ps-hover: rgba(127,127,127,.07);
  --ps-field: rgba(127,127,127,.06);
  --ps-accent: rgba(127,127,127,.5);
  --ps-ring: rgba(127,127,127,.16);
  --ps-chip-bg: rgba(127,127,127,.16);
  --ps-chip-border: rgba(127,127,127,.4);
  --ps-danger: #e5484d;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 2px 0 24px;
  font-size: 13px;
  line-height: 1.5;
}
.ps-head { display: flex; align-items: center; gap: 10px; }
.ps-title { font-size: 16px; font-weight: 650; margin: 0; letter-spacing: .01em; }
.ps-pill {
  font-size: 11px; padding: 1px 9px; border-radius: 999px;
  border: 1px solid var(--ps-border); opacity: .75;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.ps-spacer { flex: 1; }
.ps-hint { font-size: 12px; opacity: .55; line-height: 1.7; margin: -8px 0 0; }
.ps-error {
  font-size: 12px; color: var(--ps-danger); padding: 8px 12px;
  border: 1px solid rgba(229,72,77,.35); border-radius: 10px;
  background: rgba(229,72,77,.06);
}
.ps-card {
  border: 1px solid var(--ps-border); border-radius: 14px;
  background: var(--ps-surface); overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.ps-toolbar {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-bottom: 1px solid var(--ps-border-soft);
}
.ps-search { position: relative; display: flex; align-items: center; }
.ps-search-icon {
  position: absolute; left: 11px; font-size: 13px; opacity: .4;
  pointer-events: none; line-height: 1;
}
.ps-input {
  width: 100%; font-size: 13px; padding: 8px 34px 8px 32px;
  border-radius: 10px; border: 1px solid var(--ps-border);
  background: var(--ps-field); color: inherit; outline: none;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.ps-input::placeholder { color: inherit; opacity: .38; }
.ps-input:hover { border-color: var(--ps-accent); }
.ps-input:focus {
  border-color: var(--ps-accent);
  box-shadow: 0 0 0 3px var(--ps-ring);
  background: transparent;
}
.ps-clear {
  position: absolute; right: 8px; width: 20px; height: 20px;
  border: none; border-radius: 6px; background: transparent;
  color: inherit; opacity: .45; cursor: pointer; font-size: 11px;
  display: flex; align-items: center; justify-content: center;
}
.ps-clear:hover { opacity: .85; background: var(--ps-hover); }
.ps-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ps-chip {
  font-size: 11px; padding: 3px 10px; border-radius: 8px;
  border: 1px solid var(--ps-border); background: transparent;
  color: inherit; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
  font-variant-numeric: tabular-nums;
}
.ps-chip:hover { background: var(--ps-hover); }
.ps-chip-active {
  background: var(--ps-chip-bg); border-color: var(--ps-chip-border);
  font-weight: 600;
}
.ps-list { max-height: 46vh; overflow-y: auto; }
.ps-list::-webkit-scrollbar { width: 9px; }
.ps-list::-webkit-scrollbar-thumb {
  background: rgba(127,127,127,.26); border-radius: 5px;
  border: 2px solid transparent; background-clip: content-box;
}
.ps-row {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-top: 1px solid var(--ps-border-soft);
  transition: background .12s ease;
}
.ps-row:first-child { border-top: none; }
.ps-row:hover { background: var(--ps-hover); }
.ps-grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ps-name {
  font-size: 13px; font-weight: 550; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.ps-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; opacity: .48; line-height: 1.45;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ps-miss {
  margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  color: var(--ps-danger); border: 1px solid rgba(229,72,77,.35);
  vertical-align: 1px; font-weight: 500;
}
.ps-meta { font-size: 11px; opacity: .45; }
.ps-ext {
  width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; letter-spacing: .04em;
  background: rgba(127,127,127,.12); user-select: none;
}
.ps-ext-md { background: rgba(46,160,67,.16); color: #3fb950; }
.ps-ext-pdf { background: rgba(248,81,73,.14); color: #f85149; }
.ps-ext-docx, .ps-ext-doc { background: rgba(88,166,255,.15); color: #58a6ff; }
.ps-ext-html, .ps-ext-htm { background: rgba(240,136,62,.15); color: #f0883e; }
.ps-ext-json { background: rgba(210,153,34,.15); color: #d29922; }
.ps-ext-txt { background: rgba(139,148,158,.16); color: #8b949e; }
.ps-ext-trash { background: rgba(139,148,158,.12); color: #8b949e; }
.ps-btn {
  font-size: 12px; padding: 4px 12px; border-radius: 8px;
  border: 1px solid var(--ps-border); background: transparent;
  color: inherit; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.ps-btn:hover { background: var(--ps-hover); border-color: var(--ps-accent); }
.ps-btn:disabled { opacity: .4; cursor: default; }
.ps-btn-sm { font-size: 11px; padding: 3px 8px; min-width: 56px; text-align: center; }
.ps-btn-danger { color: var(--ps-danger); border-color: rgba(229,72,77,.35); }
.ps-btn-danger:hover {
  background: rgba(229,72,77,.08); border-color: rgba(229,72,77,.5);
}
.ps-btn-quiet { border-color: transparent; opacity: .6; }
.ps-btn-quiet:hover { opacity: 1; }
.ps-icon-btn {
  width: 28px; height: 28px; border-radius: 8px;
  border: 1px solid var(--ps-border); background: transparent;
  color: inherit; cursor: pointer; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  opacity: .65; transition: background .12s ease, opacity .12s ease;
}
.ps-icon-btn:hover { opacity: 1; background: var(--ps-hover); }
.ps-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 8px 14px; font-size: 11px; opacity: .5;
  border-top: 1px solid var(--ps-border-soft);
}
.ps-empty { padding: 28px 16px; text-align: center; font-size: 12.5px; opacity: .5; line-height: 1.8; }
.ps-empty strong { font-weight: 600; opacity: .85; }
.ps-section { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.ps-section-title { font-size: 13px; font-weight: 600; margin: 0; opacity: .88; }
.ps-kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; padding: 1px 5px; border-radius: 5px;
  border: 1px solid var(--ps-border); opacity: .55;
}
`;

    function useStyles() {
      useEffect(() => {
        if (document.getElementById(STYLE_ID)) return;
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }, []);
    }

    async function getJson(path) {
      const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error((body && body.error) || '请求失败');
      return body;
    }

    async function postJson(path, payload) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error((body && body.error) || '请求失败');
      return body;
    }

    function extOf(doc) {
      const fromKind = String(doc.kind || '').trim();
      if (fromKind) return fromKind.slice(0, 4).toUpperCase();
      const name = String(doc.name || '');
      const dot = name.lastIndexOf('.');
      return dot >= 0 ? name.slice(dot + 1).slice(0, 4).toUpperCase() : 'FILE';
    }

    function kindClass(kind) {
      const key = String(kind || '').trim().toLowerCase();
      return `ps-ext ps-ext-${key || 'file'}`;
    }

    function formatTime(value) {
      if (!value) return '';
      return String(value).replace('T', ' ').replace('Z', '').slice(0, 16);
    }

    function Page() {
      useStyles();
      const [docs, setDocs] = useState([]);
      const [trash, setTrash] = useState([]);
      const [typeFilter, setTypeFilter] = useState('');
      const [query, setQuery] = useState('');
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [copied, setCopied] = useState('');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const [docsBody, trashBody] = await Promise.all([getJson('/docs'), getJson('/trash')]);
          setDocs(Array.isArray(docsBody.docs) ? docsBody.docs : []);
          setTrash(Array.isArray(trashBody.items) ? trashBody.items : []);
        } catch (err) {
          setError(`读取失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const openFolder = useCallback(async (doc) => {
        setBusy(doc.path);
        setError('');
        try {
          const res = await fetch(`${API}/reveal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: doc.path }),
          });
          const body = await res.json();
          if (!body || body.ok !== true) {
            const code = body && body.error;
            if (code === 'file_missing') throw new Error('原文件已不存在（可能已被移动或删除）');
            if (code === 'unknown_path') throw new Error('该路径不在索引中');
            throw new Error(code || '打开失败');
          }
        } catch (err) {
          setError(`打开文件夹失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, []);

      const copyPath = useCallback(async (doc) => {
        try {
          await navigator.clipboard.writeText(String(doc.path || ''));
          setCopied(doc.path);
          window.setTimeout(() => setCopied(''), 1600);
        } catch {
          setError('复制失败：浏览器不允许写剪贴板，请手动选中路径复制');
        }
      }, []);

      const trashOne = useCallback(async (doc) => {
        const ok = window.confirm(
          `把「${doc.name}」移入回收站？\n\n只删除索引，磁盘上的原文件不会被删除。`,
        );
        if (!ok) return;
        setBusy(doc.path);
        setError('');
        try {
          await postJson('/delete', { path: doc.path });
          await load();
        } catch (err) {
          setError(`移入回收站失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load]);

      const restore = useCallback(async (item) => {
        setBusy(item.path);
        setError('');
        try {
          await postJson('/restore', { path: item.path });
          await load();
        } catch (err) {
          setError(`恢复失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load]);

      const purge = useCallback(async (item) => {
        const ok = window.confirm(
          `彻底删除「${item.name || item.path}」？\n\n会从索引中清掉它的全部内容块；磁盘上的原文件不会被删除。`,
        );
        if (!ok) return;
        setBusy(item.path);
        setError('');
        try {
          await postJson('/purge', { path: item.path });
          await load();
        } catch (err) {
          setError(`彻底删除失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load]);

      const emptyTrash = useCallback(async () => {
        if (trash.length === 0) return;
        const ok = window.confirm(
          `清空回收站？\n\n共 ${trash.length} 个文件；磁盘上的原文件不会被删除。`,
        );
        if (!ok) return;
        setBusy('*');
        setError('');
        try {
          await postJson('/purge', { all: true });
          await load();
        } catch (err) {
          setError(`清空回收站失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load, trash.length]);

      const typeCounts = useMemo(() => {
        const counts = new Map();
        for (const doc of docs) {
          const key = extOf(doc);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      }, [docs]);

      useEffect(() => {
        if (typeFilter && !typeCounts.some(([key]) => key === typeFilter)) setTypeFilter('');
      }, [typeFilter, typeCounts]);

      const visibleDocs = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return docs.filter((doc) => {
          if (typeFilter && extOf(doc) !== typeFilter) return false;
          if (!needle) return true;
          return String(doc.name || '').toLowerCase().includes(needle)
            || String(doc.path || '').toLowerCase().includes(needle);
        });
      }, [docs, typeFilter, query]);

      const docRows = visibleDocs.map((doc) => h('div', { key: doc.path, className: 'ps-row' },
        h('div', { className: kindClass(doc.kind) }, extOf(doc)),
        h('div', { className: 'ps-grow' },
          h('div', { className: 'ps-name', title: doc.name },
            doc.name,
            doc.status === 'missing'
              ? h('span', { className: 'ps-miss', title: '原文件已被移动或删除，索引内容仍在' }, '缺失')
              : null),
          h('div', { className: 'ps-path', title: doc.path }, doc.path)),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-sm',
          disabled: busy === doc.path || doc.status === 'missing',
          title: doc.status === 'missing' ? '原文件已不存在' : '在系统文件管理器中显示该文件',
          onClick: () => openFolder(doc),
        }, '打开'),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-sm',
          title: copied === doc.path ? '已复制' : '复制真实路径',
          onClick: () => copyPath(doc),
        }, copied === doc.path ? '已复制' : '复制'),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-sm ps-btn-danger',
          disabled: busy === doc.path,
          title: '移出索引，放进回收站',
          onClick: () => trashOne(doc),
        }, '删除'),
      ));

      const trashRows = trash.map((item) => h('div', { key: `${item.path}:${item.layer || ''}`, className: 'ps-row' },
        h('div', { className: 'ps-ext ps-ext-trash' }, '♻'),
        h('div', { className: 'ps-grow' },
          h('div', { className: 'ps-name', title: item.path }, item.name || item.path),
          h('div', { className: 'ps-path', title: item.path }, item.path),
          h('div', { className: 'ps-meta' },
            `移入回收站：${formatTime(item.trashed_at)}${item.exists === false ? ' · 原文件已不存在' : ''}`)),
        h('button', {
          type: 'button',
          className: 'ps-btn',
          disabled: busy === item.path,
          onClick: () => restore(item),
        }, '恢复'),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-danger',
          disabled: busy === item.path,
          onClick: () => purge(item),
        }, '彻底删除'),
      ));

      return h('div', { className: 'ps-root' },
        h('div', { className: 'ps-head' },
          h('h3', { className: 'ps-title' }, '索引文件'),
          h('span', { className: 'ps-pill' }, loading ? '读取中…' : `${docs.length} 个`),
          h('span', { className: 'ps-spacer' }),
          h('button', {
            type: 'button',
            className: 'ps-icon-btn',
            title: '刷新',
            disabled: loading,
            onClick: load,
          }, '↻')),
        h('p', { className: 'ps-hint' },
          '这里管理的是索引本身：文件来自入库存档，删除只会把它移进回收站；磁盘上的原文件始终保留。'),
        error ? h('div', { className: 'ps-error', role: 'alert' }, error) : null,

        h('div', { className: 'ps-card' },
          h('div', { className: 'ps-toolbar' },
            h('div', { className: 'ps-search' },
              h('span', { className: 'ps-search-icon', 'aria-hidden': true }, '⌕'),
              h('input', {
                className: 'ps-input',
                type: 'search',
                placeholder: '搜索文件名或路径…',
                value: query,
                'aria-label': '搜索文件名或路径',
                onChange: (event) => setQuery(event.target.value),
              }),
              query ? h('button', {
                type: 'button',
                className: 'ps-clear',
                title: '清空搜索',
                onClick: () => setQuery(''),
              }, '✕') : null),
            typeCounts.length > 1 ? h('div', { className: 'ps-chips' },
              h('button', {
                type: 'button',
                className: `ps-chip${typeFilter === '' ? ' ps-chip-active' : ''}`,
                onClick: () => setTypeFilter(''),
              }, `全部 ${docs.length}`),
              ...typeCounts.map(([key, count]) => h('button', {
                key,
                type: 'button',
                className: `ps-chip${typeFilter === key ? ' ps-chip-active' : ''}`,
                onClick: () => setTypeFilter(key),
                title: `只看 ${key} 类型`,
              }, `${key} ${count}`)),
            ) : null),
          docs.length === 0 && !loading
            ? h('div', { className: 'ps-empty' },
              h('div', null, '索引还是空的'),
              h('div', null, '用 kb_ingest 导入文件后，它们会出现在这里'))
            : visibleDocs.length === 0
              ? h('div', { className: 'ps-empty' },
                query ? h('div', null, `没有匹配「${query.trim()}」的文件`) : h('div', null, '这个类型下没有文件'))
              : h('div', { className: 'ps-list' }, ...docRows),
          h('div', { className: 'ps-foot' },
            h('span', null, `显示 ${visibleDocs.length} / ${docs.length} 个文件`),
            h('span', null, '删除只移出索引，原文件保留'))),

        h('div', { className: 'ps-section' },
          h('h4', { className: 'ps-section-title' }, '回收站'),
          h('span', { className: 'ps-pill' }, `${trash.length}`),
          h('span', { className: 'ps-spacer' }),
          h('button', {
            type: 'button',
            className: 'ps-btn ps-btn-danger',
            disabled: trash.length === 0 || busy === '*',
            onClick: emptyTrash,
          }, busy === '*' ? '清空中…' : '清空回收站')),
        h('div', { className: 'ps-card' },
          trash.length === 0 && !loading
            ? h('div', { className: 'ps-empty' },
              h('div', null, '回收站是空的'),
              h('div', null, '删除的文件会先来到这里，可随时恢复'))
            : h('div', { className: 'ps-list' }, ...trashRows)),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'pure-search', order: 44, label: () => '纯索引' },
          () => h(Page),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.name = 'dsh-pure-search';
    return module.exports;
  },
});
