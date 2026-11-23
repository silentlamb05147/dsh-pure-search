/**
 * dsh-pure-search — settings page.
 *
 * One job: show the files that are in the index, and let the user remove one
 * from the index. The file on disk is never touched; the host tombstones the
 * manifest entry so the watcher cannot silently re-add it 30 seconds later.
 *
 * Everything else (search, outline, chapter reads) is a tool, not a page.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-pure-search',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback } = React;

    const API = '/api/pure-search';

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 24px' },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      count: { fontSize: '12px', opacity: 0.65 },
      note: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6, margin: 0 },
      list: { display: 'flex', flexDirection: 'column', borderTop: '1px solid rgba(127,127,127,0.18)' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 2px',
        borderBottom: '1px solid rgba(127,127,127,0.12)',
        minWidth: 0,
      },
      name: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: '11px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.28)',
        opacity: 0.75,
        whiteSpace: 'nowrap',
      },
      grow: { flex: 1, minWidth: 0 },
      btn: {
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      error: { fontSize: '12px', color: '#e5484d' },
      empty: { fontSize: '13px', opacity: 0.6, padding: '18px 0' },
    };

    function layerLabel(doc) {
      if (doc.layer === 'session') return `会话 · ${doc.session || ''}`;
      return '工作区';
    }

    function Page() {
      const [docs, setDocs] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const res = await fetch(`${API}/docs`, { headers: { accept: 'application/json' } });
          const body = await res.json();
          if (!body || body.ok !== true) throw new Error((body && body.error) || '读取失败');
          setDocs(Array.isArray(body.docs) ? body.docs : []);
        } catch (err) {
          setError(`读取失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const remove = useCallback(
        async (doc) => {
          const ok = window.confirm(
            `从索引中移除「${doc.name}」？\n\n只会删除索引条目，磁盘上的原文件不受影响。`,
          );
          if (!ok) return;
          setBusy(doc.path);
          setError('');
          try {
            const res = await fetch(`${API}/delete`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                path: doc.path,
                workspace: doc.workspace,
                session: doc.session,
              }),
            });
            const body = await res.json();
            if (!body || body.ok !== true) throw new Error((body && body.error) || '删除失败');
            setDocs((prev) => prev.filter((item) => item.path !== doc.path));
          } catch (err) {
            setError(`删除失败：${err && err.message ? err.message : String(err)}`);
          } finally {
            setBusy('');
          }
        },
        [],
      );

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.head },
          h('h3', { style: styles.title }, '已索引的文件'),
          h('span', { style: styles.count }, loading ? '读取中…' : `${docs.length} 个`),
        ),
        h(
          'p',
          { style: styles.note },
          '这里只列出已经进索引的文件。删除只删索引，不删磁盘上的原文件；删除后后台扫描也不会把它自动加回来。',
        ),
        error ? h('div', { style: styles.error, role: 'alert' }, error) : null,
        docs.length === 0 && !loading
          ? h('div', { style: styles.empty }, '还没有索引任何文件。用 kb_ingest 导入 Markdown、TXT、PDF、DOCX、HTML 或 JSON。')
          : h(
              'div',
              { style: styles.list },
              docs.map((doc) =>
                h(
                  'div',
                  { key: `${doc.layer}:${doc.path}`, style: styles.row },
                  h(
                    'div',
                    { style: styles.grow },
                    h('div', { style: styles.name, title: doc.path }, doc.name),
                    h(
                      'div',
                      { style: styles.meta, title: doc.path },
                      `${doc.kind || 'file'} · ${doc.chunks} 块`,
                    ),
                  ),
                  h('span', { style: styles.badge }, layerLabel(doc)),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: styles.btn,
                      disabled: busy === doc.path,
                      onClick: () => remove(doc),
                    },
                    busy === doc.path ? '删除中…' : '删除',
                  ),
                ),
              ),
            ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'pure-search',
            order: 44,
            label: () => '纯索引',
          },
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
