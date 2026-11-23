/**
 * dsh-pure-search — settings page.
 *
 * Two jobs, one page:
 *   1. list the files that are in the index and let the user move one to the
 *      recycle bin (search stops finding it; the file on disk is untouched);
 *   2. show the recycle bin, where a file can be restored or purged for good.
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
      subTitle: { fontSize: '14px', fontWeight: 600, margin: '10px 0 0' },
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
      btnDanger: { color: '#e5484d', borderColor: 'rgba(229,72,77,0.45)' },
      error: { fontSize: '12px', color: '#e5484d' },
      empty: { fontSize: '13px', opacity: 0.6, padding: '18px 0' },
      divider: { height: '1px', background: 'rgba(127,127,127,0.18)', margin: '6px 0 0' },
    };

    function layerLabel(doc) {
      const layers = Array.isArray(doc.layers) ? doc.layers : [];
      const hasWorkspace = layers.some((item) => item.layer === 'workspace');
      const sessions = layers.filter((item) => item.layer === 'session');
      if (!hasWorkspace && sessions.length === 0) return '未知';
      if (!hasWorkspace) {
        const names = [...new Set(sessions.map((item) => item.session).filter(Boolean))];
        return names.length > 1 ? `会话 × ${names.length}` : `会话 · ${names[0] || ''}`;
      }
      if (sessions.length === 0) return '工作区';
      return `工作区 + 会话${sessions.length > 1 ? ` × ${sessions.length}` : ''}`;
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

    function Page() {
      const [docs, setDocs] = useState([]);
      const [trash, setTrash] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const [docsRes, trashRes] = await Promise.all([
            fetch(`${API}/docs`, { headers: { accept: 'application/json' } }),
            fetch(`${API}/trash`, { headers: { accept: 'application/json' } }),
          ]);
          const docsBody = await docsRes.json();
          if (!docsBody || docsBody.ok !== true) throw new Error((docsBody && docsBody.error) || '读取失败');
          setDocs(Array.isArray(docsBody.docs) ? docsBody.docs : []);
          const trashBody = await trashRes.json();
          if (!trashBody || trashBody.ok !== true) throw new Error((trashBody && trashBody.error) || '读取失败');
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

      const moveToTrash = useCallback(async (doc) => {
        const ok = window.confirm(
          `把「${doc.name}」移到回收站？\n\n搜索与列表都不再显示它，磁盘上的原文件不受影响；之后可以在回收站恢复或彻底删除。`,
        );
        if (!ok) return;
        setBusy(doc.path);
        setError('');
        try {
          await postJson('/delete', { path: doc.path });
          setDocs((prev) => prev.filter((item) => item.path !== doc.path));
          await load();
        } catch (err) {
          setError(`移到回收站失败：${err && err.message ? err.message : String(err)}`);
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
          `彻底删除「${item.name || item.path}」？\n\n会清掉回收站里的索引块与条目，之后只能重新入库才能找回；磁盘上的原文件不受影响。`,
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
        const ok = window.confirm(`清空回收站？\n\n共 ${trash.length} 个文件，索引块与条目会被删除，磁盘上的原文件不受影响。`);
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
          '这里只列出已经进索引的文件。删除会把它移到回收站：搜索与列表都不再显示，磁盘上的原文件不受影响，后台扫描也不会把它自动加回来。',
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
                  { key: doc.path, style: styles.row },
                  h(
                    'div',
                    { style: styles.grow },
                    h('div', { style: styles.name, title: doc.path }, doc.name),
                    h('div', { style: styles.meta, title: doc.path }, `${doc.kind || 'file'} · ${doc.chunks} 块`),
                  ),
                  h('span', { style: styles.badge }, layerLabel(doc)),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: styles.btn,
                      disabled: busy === doc.path,
                      onClick: () => moveToTrash(doc),
                    },
                    busy === doc.path ? '移除中…' : '移到回收站',
                  ),
                ),
              ),
            ),
        h('div', { style: styles.divider }),
        h(
          'div',
          { style: styles.head },
          h('h4', { style: styles.subTitle }, '回收站'),
          h('span', { style: styles.count }, loading ? '读取中…' : `${trash.length} 个`),
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.btn, ...styles.btnDanger, marginLeft: 'auto' },
              disabled: trash.length === 0 || busy === '*',
              onClick: emptyTrash,
            },
            busy === '*' ? '清空中…' : '清空回收站',
          ),
        ),
        trash.length === 0 && !loading
          ? h('div', { style: styles.empty }, '回收站是空的。')
          : h(
              'div',
              { style: styles.list },
              trash.map((item) =>
                h(
                  'div',
                  { key: `${item.path}:${item.layer || ''}`, style: styles.row },
                  h(
                    'div',
                    { style: styles.grow },
                    h('div', { style: styles.name, title: item.path }, item.name || item.path),
                    h(
                      'div',
                      { style: styles.meta, title: item.path },
                      `${item.chunks || 0} 块 · 移到回收站 ${item.trashed_at ? item.trashed_at.replace('T', ' ').replace('Z', '') : ''}${item.exists === false ? ' · 原文件已不存在' : ''}`,
                    ),
                  ),
                  h(
                    'button',
                    { type: 'button', style: styles.btn, disabled: busy === item.path, onClick: () => restore(item) },
                    busy === item.path ? '处理中…' : '恢复',
                  ),
                  h(
                    'button',
                    { type: 'button', style: { ...styles.btn, ...styles.btnDanger }, disabled: busy === item.path, onClick: () => purge(item) },
                    '彻底删除',
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
