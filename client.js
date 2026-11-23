/**
 * dsh-pure-search — optional settings page.
 *
 * Shows the files currently in the index, lets the user group them into
 * virtual folders, and keeps removed files in a recycle bin. Every operation
 * only edits the index (manifest / chunks / trash / folder registry); the
 * files on disk are never moved or deleted.
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
    const UNCATEGORIZED = '__uncategorized';

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0 24px' },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      subTitle: { fontSize: '14px', fontWeight: 600, margin: '10px 0 0' },
      count: { fontSize: '12px', opacity: 0.65 },
      note: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6, margin: 0 },
      body: { display: 'flex', gap: '16px', minHeight: '260px' },
      treePane: { width: '240px', flexShrink: 0, borderRight: '1px solid rgba(127,127,127,0.18)', paddingRight: '12px' },
      listPane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
      treeRow: {
        display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 4px',
        borderRadius: '5px', cursor: 'pointer', fontSize: '12.5px', minWidth: 0,
      },
      treeRowActive: { background: 'rgba(127,127,127,0.16)' },
      treeName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      treeCount: { fontSize: '11px', opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
      caret: { width: '14px', textAlign: 'center', opacity: 0.6, fontSize: '10px' },
      miniBtn: {
        fontSize: '10px', padding: '0 4px', borderRadius: '4px', border: 'none',
        background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.55,
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: {
        flex: 1, minWidth: '140px', fontSize: '12px', padding: '5px 8px',
        borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent', color: 'inherit',
      },
      list: { display: 'flex', flexDirection: 'column', borderTop: '1px solid rgba(127,127,127,0.18)' },
      row: {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 2px',
        borderBottom: '1px solid rgba(127,127,127,0.12)', minWidth: 0,
      },
      name: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: '11px', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.28)', opacity: 0.75, whiteSpace: 'nowrap',
      },
      grow: { flex: 1, minWidth: 0 },
      btn: {
        fontSize: '12px', padding: '3px 10px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent',
        color: 'inherit', cursor: 'pointer',
      },
      btnDanger: { color: '#e5484d', borderColor: 'rgba(229,72,77,0.45)' },
      error: { fontSize: '12px', color: '#e5484d' },
      empty: { fontSize: '13px', opacity: 0.6, padding: '18px 0' },
      divider: { height: '1px', background: 'rgba(127,127,127,0.18)', margin: '6px 0 0' },
      select: {
        fontSize: '12px', padding: '3px 6px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      },
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

    async function readJson(path) {
      const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      const body = await res.json();
      if (!body || body.ok !== true) throw new Error((body && body.error) || '请求失败');
      return body;
    }

    function buildChildren(folders) {
      const map = new Map();
      for (const folder of folders) {
        const key = folder.parent || '';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(folder);
      }
      for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
      return map;
    }

    function renderTree(props) {
      const { node, depth, childrenMap, expanded, toggle, selected, onSelect, onAction } = props;
      const children = childrenMap.get(node.path) || [];
      const isOpen = expanded.has(node.path);
      const rowStyle = { ...styles.treeRow, paddingLeft: `${4 + depth * 12}px` };
      if (selected === node.path) Object.assign(rowStyle, styles.treeRowActive);
      const caret = children.length > 0
        ? h('span', { style: styles.caret, onClick: (event) => { event.stopPropagation(); toggle(node.path); } }, isOpen ? '▼' : '▶')
        : h('span', { style: styles.caret }, '·');
      const actions = h('span', { style: { display: 'flex', gap: '2px' } },
        h('button', { type: 'button', style: styles.miniBtn, title: '新建子文件夹', onClick: (e) => { e.stopPropagation(); onAction('create-child', node.path); } }, '+'),
        h('button', { type: 'button', style: styles.miniBtn, title: '重命名', onClick: (e) => { e.stopPropagation(); onAction('rename', node.path); } }, '✎'),
        h('button', { type: 'button', style: styles.miniBtn, title: '删除', onClick: (e) => { e.stopPropagation(); onAction('delete', node.path); } }, '×'),
      );
      const row = h('div', { style: rowStyle, onClick: () => onSelect(node.path), title: node.path },
        caret,
        h('span', { style: styles.treeName }, node.name),
        h('span', { style: styles.treeCount }, node.count),
        actions,
      );
      if (!isOpen || children.length === 0) return h('div', null, row);
      return h('div', null, row, children.map((child) => h('div', { key: child.path },
        renderTree({
          node: child,
          depth: depth + 1,
          childrenMap,
          expanded,
          toggle,
          selected,
          onSelect,
          onAction,
        }))));
    }

    function moveOptions(folders) {
      return [
        h('option', { key: '__none', value: '' }, '移动到…'),
        h('option', { key: '__uncat', value: UNCATEGORIZED }, '未分类'),
        ...folders.map((item) => h('option', { key: item, value: item }, item)),
      ];
    }

    function Page() {
      const [docs, setDocs] = useState([]);
      const [folders, setFolders] = useState([]);
      const [trash, setTrash] = useState([]);
      const [uncategorized, setUncategorized] = useState(0);
      const [selected, setSelected] = useState('');
      const [query, setQuery] = useState('');
      const [checked, setChecked] = useState(() => new Set());
      const [expanded, setExpanded] = useState(() => new Set());
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const [docsBody, foldersBody, trashBody] = await Promise.all([
            readJson('/docs'),
            readJson('/folders'),
            readJson('/trash'),
          ]);
          setDocs(Array.isArray(docsBody.docs) ? docsBody.docs : []);
          setFolders(Array.isArray(foldersBody.folders) ? foldersBody.folders : []);
          setUncategorized(Number(foldersBody.uncategorized) || 0);
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

      const childrenMap = useMemo(() => buildChildren(folders), [folders]);
      const roots = childrenMap.get('') || [];
      const folderPaths = useMemo(() => folders.map((item) => item.path), [folders]);

      const visibleDocs = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return docs.filter((doc) => {
          const category = String(doc.category || '');
          if (selected === UNCATEGORIZED && category) return false;
          if (selected && selected !== UNCATEGORIZED
            && category !== selected && !category.startsWith(`${selected}/`)) return false;
          if (needle && !doc.name.toLowerCase().includes(needle) && !doc.path.toLowerCase().includes(needle)) return false;
          return true;
        });
      }, [docs, selected, query]);

      const toggleExpanded = useCallback((key) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      const toggleChecked = useCallback((key) => {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      const folderAction = useCallback(async (action, folderPath) => {
        setError('');
        try {
          if (action === 'create-root') {
            const name = window.prompt('新建文件夹（可用 / 创建多层，例如：小说/两界）');
            if (!name || !name.trim()) return;
            await postJson('/folder', { action: 'create', path: name.trim() });
            await load();
            return;
          }
          if (action === 'create-child') {
            const name = window.prompt(`在「${folderPath}」下新建文件夹`);
            if (!name || !name.trim()) return;
            await postJson('/folder', { action: 'create', path: `${folderPath}/${name.trim()}` });
            setExpanded((prev) => new Set(prev).add(folderPath));
            await load();
            return;
          }
          if (action === 'rename') {
            const node = folders.find((item) => item.path === folderPath);
            const current = node ? node.name : folderPath.split('/').pop();
            const name = window.prompt('新的文件夹名', current);
            if (!name || !name.trim() || name.trim() === current) return;
            const parent = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
            const target = parent ? `${parent}/${name.trim()}` : name.trim();
            await postJson('/folder', { action: 'rename', path: folderPath, newPath: target });
            await load();
            return;
          }
          if (action === 'delete') {
            const ok = window.confirm(`删除文件夹「${folderPath}」？\n\n只有空文件夹可以删除；里面的文件不会受影响。`);
            if (!ok) return;
            await postJson('/folder', { action: 'delete', path: folderPath });
            if (selected === folderPath) setSelected('');
            await load();
          }
        } catch (err) {
          setError(`文件夹操作失败：${err && err.message ? err.message : String(err)}`);
        }
      }, [folders, load, selected]);

      const moveChecked = useCallback(async (category) => {
        const paths = [...checked];
        const list = paths.length > 0 ? paths : visibleDocs.map((doc) => doc.path);
        if (list.length === 0) return;
        setBusy('move');
        setError('');
        try {
          await postJson('/move', { paths: list, category });
          setChecked(new Set());
          await load();
        } catch (err) {
          setError(`移动失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [checked, visibleDocs, load]);

      const moveOne = useCallback(async (doc, category) => {
        setBusy(doc.path);
        setError('');
        try {
          await postJson('/move', { paths: [doc.path], category });
          await load();
        } catch (err) {
          setError(`移动失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load]);

      const trashOne = useCallback(async (doc) => {
        const ok = window.confirm(`把「${doc.name}」移到回收站？\n\n搜索与列表都不再显示，磁盘上的原文件不受影响。`);
        if (!ok) return;
        setBusy(doc.path);
        setError('');
        try {
          await postJson('/delete', { path: doc.path });
          await load();
        } catch (err) {
          setError(`移到回收站失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [load]);

      const trashChecked = useCallback(async () => {
        const list = [...checked];
        if (list.length === 0) return;
        const ok = window.confirm(`把选中的 ${list.length} 个文件移到回收站？\n\n搜索与列表都不再显示，磁盘上的原文件不受影响。`);
        if (!ok) return;
        setBusy('trash');
        setError('');
        try {
          for (const targetPath of list) await postJson('/delete', { path: targetPath });
          setChecked(new Set());
          await load();
        } catch (err) {
          setError(`移到回收站失败：${err && err.message ? err.message : String(err)}`);
        } finally {
          setBusy('');
        }
      }, [checked, load]);

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
        const ok = window.confirm(`彻底删除「${item.name || item.path}」？\n\n会清掉回收站里的索引块与条目；磁盘上的原文件不受影响。`);
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
        const ok = window.confirm(`清空回收站？\n\n共 ${trash.length} 个文件；磁盘上的原文件不受影响。`);
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

      const allChecked = visibleDocs.length > 0 && visibleDocs.every((doc) => checked.has(doc.path));

      const treeEl = h('div', { style: styles.treePane },
        h('div', {
          style: selected === '' ? { ...styles.treeRow, ...styles.treeRowActive } : styles.treeRow,
          onClick: () => setSelected(''),
        },
        h('span', { style: styles.caret }, '≡'),
        h('span', { style: styles.treeName }, '全部'),
        h('span', { style: styles.treeCount }, docs.length)),
        h('div', {
          style: selected === UNCATEGORIZED ? { ...styles.treeRow, ...styles.treeRowActive } : styles.treeRow,
          onClick: () => setSelected(UNCATEGORIZED),
        },
        h('span', { style: styles.caret }, '·'),
        h('span', { style: styles.treeName }, '未分类'),
        h('span', { style: styles.treeCount }, uncategorized)),
        roots.map((node) => h('div', { key: node.path }, renderTree({
          node,
          depth: 0,
          childrenMap,
          expanded,
          toggle: toggleExpanded,
          selected,
          onSelect: setSelected,
          onAction: folderAction,
        }))),
        h('button', { type: 'button', style: { ...styles.btn, marginTop: '8px', width: '100%' }, onClick: () => folderAction('create-root') }, '+ 新建文件夹'),
      );

      const toolbarEl = h('div', { style: styles.toolbar },
        h('input', {
          style: styles.input,
          placeholder: '按文件名或路径过滤…',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h('label', { style: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' } },
          h('input', {
            type: 'checkbox',
            checked: allChecked,
            onChange: () => setChecked((prev) => {
              const next = new Set(prev);
              if (allChecked) visibleDocs.forEach((doc) => next.delete(doc.path));
              else visibleDocs.forEach((doc) => next.add(doc.path));
              return next;
            }),
          }),
          '全选'),
        h('select', {
          style: styles.select,
          value: '',
          disabled: busy === 'move' || visibleDocs.length === 0,
          onChange: (event) => {
            const value = event.target.value;
            if (!value) return;
            moveChecked(value === UNCATEGORIZED ? '' : value);
          },
        }, moveOptions(folderPaths)),
        h('button', {
          type: 'button',
          style: { ...styles.btn, ...styles.btnDanger },
          disabled: checked.size === 0 || busy === 'trash',
          onClick: trashChecked,
        }, `移到回收站${checked.size > 0 ? ` (${checked.size})` : ''}`),
      );

      const rows = visibleDocs.map((doc) => h('div', { key: doc.path, style: styles.row },
        h('input', {
          type: 'checkbox',
          checked: checked.has(doc.path),
          onChange: () => toggleChecked(doc.path),
        }),
        h('div', { style: styles.grow },
          h('div', { style: styles.name, title: doc.path }, doc.name),
          h('div', { style: styles.meta, title: doc.path },
            `${doc.kind || 'file'} · ${doc.chunks} 块 · ${doc.category || '未分类'}`)),
        h('span', { style: styles.badge }, layerLabel(doc)),
        h('select', {
          style: styles.select,
          value: '',
          disabled: busy === doc.path,
          onChange: (event) => {
            const value = event.target.value;
            if (!value) return;
            moveOne(doc, value === UNCATEGORIZED ? '' : value);
          },
        }, moveOptions(folderPaths)),
        h('button', {
          type: 'button',
          style: styles.btn,
          disabled: busy === doc.path,
          onClick: () => trashOne(doc),
        }, '移到回收站'),
      ));

      const listEl = h('div', { style: styles.listPane },
        toolbarEl,
        visibleDocs.length === 0 && !loading
          ? h('div', { style: styles.empty }, '这个文件夹里还没有文件。用 kb_ingest 导入后，可以在右侧选择文件并“移动到”这里。')
          : h('div', { style: styles.list }, ...rows),
      );

      const bodyEl = h('div', { style: styles.body }, treeEl, listEl);

      const trashRows = trash.map((item) => h('div', { key: `${item.path}:${item.layer || ''}`, style: styles.row },
        h('div', { style: styles.grow },
          h('div', { style: styles.name, title: item.path }, item.name || item.path),
          h('div', { style: styles.meta, title: item.path },
            `${item.chunks || 0} 块 · 移到回收站 ${item.trashed_at ? item.trashed_at.replace('T', ' ').replace('Z', '') : ''}${item.exists === false ? ' · 原文件已不存在' : ''}`)),
        h('button', { type: 'button', style: styles.btn, disabled: busy === item.path, onClick: () => restore(item) },
          busy === item.path ? '处理中…' : '恢复'),
        h('button', { type: 'button', style: { ...styles.btn, ...styles.btnDanger }, disabled: busy === item.path, onClick: () => purge(item) }, '彻底删除'),
      ));

      const trashEl = trash.length === 0 && !loading
        ? h('div', { style: styles.empty }, '回收站是空的。')
        : h('div', { style: styles.list }, ...trashRows);

      const trashHead = h('div', { style: styles.head },
        h('h4', { style: styles.subTitle }, '回收站'),
        h('span', { style: styles.count }, loading ? '读取中…' : `${trash.length} 个`),
        h('button', {
          type: 'button',
          style: { ...styles.btn, ...styles.btnDanger, marginLeft: 'auto' },
          disabled: trash.length === 0 || busy === '*',
          onClick: emptyTrash,
        }, busy === '*' ? '清空中…' : '清空回收站'),
      );

      return h('div', { style: styles.root },
        h('div', { style: styles.head },
          h('h3', { style: styles.title }, '索引里的文件'),
          h('span', { style: styles.count }, loading ? '读取中…' : `${docs.length} 个文件`)),
        h('p', { style: styles.note },
          '这里管理的是索引：文件夹是虚拟分类，移动只改索引归属，不会移动或删除磁盘上的文件；删除会把文件移入回收站。'),
        error ? h('div', { style: styles.error, role: 'alert' }, error) : null,
        bodyEl,
        h('div', { style: styles.divider }),
        trashHead,
        trashEl,
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
