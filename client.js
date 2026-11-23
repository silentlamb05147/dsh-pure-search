/**
 * dsh-pure-search — optional settings page.
 *
 * Two things only: the files currently in the index (name + real path) with a
 * "move to recycle bin" action, and the recycle bin itself (restore / purge).
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
.ps-card { border: 1px solid rgba(127,127,127,.18); border-radius: 12px; overflow: hidden; }
.ps-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid rgba(127,127,127,.1); transition: background .12s ease; }
.ps-row:first-child { border-top: none; }
.ps-row:hover { background: rgba(127,127,127,.07); }
.ps-btn { font-size: 12px; padding: 4px 11px; border-radius: 7px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; cursor: pointer; transition: background .12s ease, border-color .12s ease, opacity .12s ease; white-space: nowrap; }
.ps-btn:hover { background: rgba(127,127,127,.12); }
.ps-btn:disabled { opacity: .45; cursor: default; }
.ps-btn-danger { color: #e5484d; border-color: rgba(229,72,77,.4); }
.ps-btn-danger:hover { background: rgba(229,72,77,.1); border-color: rgba(229,72,77,.55); }
.ps-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; opacity: .55; word-break: break-all; line-height: 1.5; }
.ps-list { max-height: 46vh; overflow-y: auto; }
.ps-list::-webkit-scrollbar { width: 8px; }
.ps-list::-webkit-scrollbar-thumb { background: rgba(127,127,127,.28); border-radius: 4px; }
.ps-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ps-chip { font-size: 11px; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(127,127,127,.28); background: transparent; color: inherit; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.ps-chip:hover { background: rgba(127,127,127,.12); }
.ps-chip-active { background: rgba(127,127,127,.18); border-color: rgba(127,127,127,.5); }
.ps-toolbar { display: flex; flex-direction: column; gap: 9px; padding: 10px 12px; border: 1px solid rgba(127,127,127,.18); border-radius: 12px; background: rgba(127,127,127,.03); }
.ps-search { display: flex; align-items: center; gap: 8px; }
.ps-input { flex: 1; min-width: 0; font-size: 12.5px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.25); background: transparent; color: inherit; outline: none; transition: border-color .12s ease; }
.ps-input:focus { border-color: rgba(127,127,127,.55); }
.ps-clear { border: none; background: transparent; color: inherit; opacity: .5; cursor: pointer; font-size: 13px; padding: 0 2px; }
.ps-clear:hover { opacity: .85; }
.ps-foot { display: flex; justify-content: space-between; align-items: center; font-size: 11px; opacity: .5; padding: 0 2px; }
.ps-ext { width: 34px; height: 34px; flex-shrink: 0; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; letter-spacing: .04em; background: rgba(127,127,127,.12); }
.ps-ext-md { background: rgba(46,160,67,.16); color: #3fb950; }
.ps-ext-pdf { background: rgba(248,81,73,.14); color: #f85149; }
.ps-ext-docx, .ps-ext-doc { background: rgba(88,166,255,.15); color: #58a6ff; }
.ps-ext-html, .ps-ext-htm { background: rgba(240,136,62,.15); color: #f0883e; }
.ps-ext-json { background: rgba(210,153,34,.15); color: #d29922; }
.ps-ext-txt { background: rgba(139,148,158,.16); color: #8b949e; }
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
      const text = String(value).replace('T', ' ').replace('Z', '');
      return text.slice(0, 16);
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0 20px' },
      header: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0, letterSpacing: '.01em' },
      pill: {
        fontSize: '11px', padding: '1px 9px', borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.25)', opacity: .8,
        fontVariantNumeric: 'tabular-nums',
      },
      hint: { fontSize: '12px', opacity: .62, lineHeight: 1.7, margin: 0 },
      sectionHead: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, margin: 0, opacity: .9 },
      grow: { flex: 1, minWidth: 0 },
      name: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: '11px', opacity: .5, marginTop: '2px' },
      ext: {
        width: '34px', height: '34px', flexShrink: 0, borderRadius: '8px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '9px', fontWeight: 700, letterSpacing: '.04em',
        background: 'rgba(127,127,127,.12)', color: 'inherit', opacity: .85,
      },
      error: { fontSize: '12px', color: '#e5484d' },
      empty: { fontSize: '13px', opacity: .55, padding: '22px 14px', textAlign: 'center' },
      trashNote: { fontSize: '11px', opacity: .5, marginLeft: 'auto' },
    };

    function Page() {
      useStyles();
      const [docs, setDocs] = useState([]);
      const [trash, setTrash] = useState([]);
      const [typeFilter, setTypeFilter] = useState('');
      const [query, setQuery] = useState('');
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');

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
        h('div', { style: styles.grow },
          h('div', { style: styles.name, title: doc.name }, doc.name),
          h('div', { className: 'ps-path', title: doc.path }, doc.path)),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-danger',
          disabled: busy === doc.path,
          onClick: () => trashOne(doc),
        }, busy === doc.path ? '处理中…' : '删除'),
      ));

      const trashRows = trash.map((item) => h('div', { key: `${item.path}:${item.layer || ''}`, className: 'ps-row' },
        h('div', { style: styles.ext }, 'TRSH'),
        h('div', { style: styles.grow },
          h('div', { style: styles.name, title: item.path }, item.name || item.path),
          h('div', { className: 'ps-path', title: item.path }, item.path),
          h('div', { style: styles.meta },
            `移入回收站：${formatTime(item.trashed_at)}${item.exists === false ? ' · 原文件已不存在' : ''}`)),
        h('button', {
          type: 'button',
          className: 'ps-btn',
          disabled: busy === item.path,
          onClick: () => restore(item),
        }, busy === item.path ? '处理中…' : '恢复'),
        h('button', {
          type: 'button',
          className: 'ps-btn ps-btn-danger',
          disabled: busy === item.path,
          onClick: () => purge(item),
        }, '彻底删除'),
      ));

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('h3', { style: styles.title }, '索引文件'),
          h('span', { style: styles.pill }, loading ? '读取中…' : `${docs.length} 个`)),
        h('p', { style: styles.hint },
          '列出当前索引里的文件与真实路径。删除只是把文件移出索引、放进回收站，磁盘上的原文件始终保留。'),

        error ? h('div', { style: styles.error, role: 'alert' }, error) : null,

        h('div', { className: 'ps-toolbar' },
          h('div', { className: 'ps-search' },
            h('span', { style: { fontSize: '13px', opacity: .45 }, 'aria-hidden': true }, '⌕'),
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
        h('div', { className: 'ps-card' },
          docs.length === 0 && !loading
            ? h('div', { style: styles.empty }, '索引是空的。用 kb_ingest 导入文件后会出现在这里。')
            : visibleDocs.length === 0
              ? h('div', { style: styles.empty }, query
                ? `没有匹配「${query.trim()}」的文件。`
                : '这个类型下没有文件。')
              : h('div', { className: 'ps-list' }, ...docRows)),
        h('div', { className: 'ps-foot' },
          h('span', null, `显示 ${visibleDocs.length} / ${docs.length} 个文件`),
          h('span', null, '删除只移出索引，原文件保留')),

        h('div', { style: styles.sectionHead },
          h('h4', { style: styles.sectionTitle }, '回收站'),
          h('span', { style: styles.pill }, `${trash.length}`),
          h('button', {
            type: 'button',
            className: 'ps-btn ps-btn-danger',
            style: { marginLeft: 'auto' },
            disabled: trash.length === 0 || busy === '*',
            onClick: emptyTrash,
          }, busy === '*' ? '清空中…' : '清空回收站')),
        h('div', { className: 'ps-card' },
          trash.length === 0 && !loading
            ? h('div', { style: styles.empty }, '回收站是空的。')
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
