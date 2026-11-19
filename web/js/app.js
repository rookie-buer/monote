/* app.js — 外壳逻辑：文档生命周期、侧栏、查找、主题、原生桥 */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const S = {
    path: null,
    name: '未命名.md',
    saved: '',
    folder: null,
    tree: [],
    dirty: false,
    sourceMode: false,
    saveTimer: null,
    theme: 'light',
  };

  /* ---------------- 原生桥 ---------------- */
  const native = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.monote);

  function post(cmd, data) {
    if (native) { window.webkit.messageHandlers.monote.postMessage(Object.assign({ cmd }, data || {})); return; }
    mock(cmd, data || {});
  }

  /* 浏览器中调试用的假后端 */
  function mock(cmd, d) {
    const key = 'monote:' + (d.path || S.path || 'untitled');
    switch (cmd) {
      case 'save':
        try { localStorage.setItem(key, d.content); } catch (e) {}
        window.MoNote.saveResult({ path: d.path, ok: true });
        break;
      case 'readFile':
        try { window.MoNote.openDoc({ path: d.path, name: d.path.split('/').pop(), content: localStorage.getItem('monote:' + d.path) || '' }); } catch (e) {}
        break;
      case 'listDir':
        window.MoNote.tree({ path: d.path, entries: mockDir(d.path) });
        break;
      case 'open':
        window.MoNote.openDoc({ path: '/demo/示例.md', name: '示例.md', content: DEMO });
        break;
      case 'pickFolder':
        window.MoNote.tree({ path: '/demo', entries: mockDir('/demo') });
        break;
      case 'exportHTML':
        exportInBrowser();
        break;
      case 'saveImage':
        window.MoNote.imageSaved({ ok: true, rel: 'assets/pasted-mock.' + (d.ext || 'png') });
        break;
      case 'setTitle':
        document.title = d.title + ' — MoNote';
        break;
      default: break;
    }
  }

  function mockDir(p) {
    if (p === '/demo') return [
      { name: '读书笔记', dir: true },
      { name: '示例.md', dir: false, path: '/demo/示例.md' },
      { name: '另一篇.md', dir: false, path: '/demo/另一篇.md' },
    ];
    return [{ name: '子文档.md', dir: false, path: p + '/子文档.md' }];
  }

  /* ---------------- 文档生命周期 ---------------- */
  function setTitle() {
    const t = S.name + (S.dirty ? ' •' : '');
    $('#doc-title').innerHTML = '<b>' + MD.esc(S.name) + '</b>' + (S.dirty ? ' ·未保存' : '');
    $('#save-state').textContent = S.dirty ? '未保存' : (S.path ? '已保存' : '草稿');
    $('#save-state').classList.toggle('dirty', S.dirty);
    post('setTitle', { title: t, path: S.path || '' });
  }

  function openDocFile(path, name, content) {
    S.path = path || null;
    S.name = name || (path ? path.split('/').pop() : '未命名.md');
    S.saved = content || '';
    S.dirty = false;
    S.docDir = path ? path.replace(/\/[^/]*$/, '') : null;
    Ed.load(content || '');
    resolveImages();
    setTitle();
    renderOutline();
    updateStats();
    $('#editor-scroll').scrollTop = 0;
    highlightTree();
  }

  // 文档里的相对图片路径要相对文档目录解析（页面本身在 App 包内）
  function resolveImages() {
    if (!S.docDir) return;
    document.querySelectorAll('#write img.md-img').forEach(img => {
      let src = img.getAttribute('src') || '';
      if (!src || /^(https?:|file:|data:)/i.test(src)) return;
      if (src.startsWith('/')) src = 'file://' + encodeURI(src);
      else src = 'file://' + encodeURI(S.docDir + '/' + src);
      img.setAttribute('src', src);
      img.addEventListener('error', () => {
        img.style.display = 'none';
        img.insertAdjacentHTML('afterend', '<span class="md-img-missing">[图片: ' + MD.esc(img.getAttribute('src')) + ']</span>');
      }, { once: true });
    });
  }

  function markDirty() {
    S.dirty = Ed.text() !== S.saved;
    setTitle();
    updateStats();
    if (S.path) {
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(autoSave, 1200);
    }
  }

  function autoSave() {
    if (!S.path) return;
    const content = Ed.text();
    post('save', { path: S.path, content, silent: true });
    S.saved = content;
    S.dirty = false;
    setTitle();
  }

  function saveNow() {
    const content = Ed.text();
    if (!S.path) { post('saveAs', { content, suggested: S.name }); return; }
    post('save', { path: S.path, content });
    S.saved = content;
    S.dirty = false;
    setTitle();
  }

  function newDoc() {
    if (S.dirty && !confirm('当前文档尚未保存，确定新建？')) return;
    S.path = null; S.name = '未命名.md'; S.saved = ''; S.dirty = false;
    Ed.load('');
    setTitle(); renderOutline(); updateStats();
    Ed.focusAt(0, 0);
  }

  /* ---------------- 大纲 ---------------- */
  let outlineTimer = null;
  function renderOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      const items = Ed.outline();
      const box = $('#outline-pane');
      if (!items.length) { box.innerHTML = '<div class="outline-empty">用 # 写标题后，这里会出现大纲。</div>'; return; }
      box.innerHTML = items.map(h =>
        '<a class="outline-item" data-level="' + h.level + '" data-id="' + h.el.id + '">' + MD.esc(h.text || '（空标题）') + '</a>'
      ).join('');
      box.querySelectorAll('.outline-item').forEach(a => {
        a.addEventListener('click', () => {
          const el = document.getElementById(a.dataset.id);
          if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      });
      spy();
    }, 120);
  }

  function spy() {
    const sc = $('#editor-scroll');
    const items = Ed.outline();
    if (!items.length) return;
    let active = null;
    for (const h of items) {
      if (h.el.getBoundingClientRect().top <= 140) active = h.el.id;
      else break;
    }
    document.querySelectorAll('#outline-pane .outline-item').forEach(a => {
      a.classList.toggle('active', a.dataset.id === active);
    });
  }

  /* ---------------- 字数 ---------------- */
  function updateStats() {
    const st = Ed.stats();
    $('#stat-chars').textContent = st.chars + ' 字 · ' + st.lines + ' 行';
    $('#stat-read').textContent = '约 ' + st.minutes + ' 分钟';
  }

  /* ---------------- 文件树 ---------------- */
  function activateTab(name) {
    document.querySelectorAll('.side-tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === name + '-pane'));
  }

  function requestTree(path) {
    post('listDir', { path });
  }

  function renderTree(path, entries) {
    S.folder = path;
    $('#file-tree').innerHTML = '';
    $('#file-tree').appendChild(treeLevel(path, entries || [], 0));
    highlightTree();
  }

  function treeLevel(base, entries, depth) {
    const box = document.createElement('div');
    if (depth) box.className = 'tree-children';
    entries
      .slice()
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'))
      .forEach(e => {
        const full = e.path || (base.replace(/\/$/, '') + '/' + e.name);
        const row = document.createElement('div');
        row.className = 'tree-node';
        row.dataset.path = full;
        row.dataset.dir = e.dir ? '1' : '0';
        row.innerHTML = '<span class="tw">' + (e.dir ? '▸' : '') + '</span><span class="nm">' + MD.esc(e.name) + '</span>';
        box.appendChild(row);
        if (e.dir) {
          let childBox = null;
          row.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!childBox) { post('listDir', { path: full }); childBox = document.createElement('div'); childBox.className = 'tree-children'; childBox.dataset.pending = full; row.after(childBox); return; }
            childBox.hidden = !childBox.hidden;
            row.querySelector('.tw').textContent = childBox.hidden ? '▸' : '▾';
          });
        } else if (/\.(md|markdown|mmd|mdown|mkd|mdx|txt)$/i.test(e.name)) {
          row.addEventListener('click', () => post('readFile', { path: full }));
        } else {
          row.style.opacity = '.45';
        }
      });
    return box;
  }

  function highlightTree() {
    document.querySelectorAll('.tree-node').forEach(n => {
      n.classList.toggle('active', n.dataset.path === S.path);
    });
  }

  /* ---------------- 查找 ---------------- */
  const F = { matches: [], idx: -1, q: '' };

  function findMatches(q) {
    F.q = q; F.matches = []; F.idx = -1;
    if (!q) { $('#find-count').textContent = ''; return; }
    Ed.blocks().forEach((b, bi) => {
      const raw = MD.rawText(b);
      let i = raw.indexOf(q);
      while (i > -1) { F.matches.push({ bi, start: i, len: q.length }); i = raw.indexOf(q, i + 1); }
    });
    $('#find-count').textContent = F.matches.length ? '1/' + F.matches.length : '无结果';
    if (F.matches.length) gotoMatch(0);
  }

  function gotoMatch(k) {
    if (!F.matches.length) return;
    F.idx = (k + F.matches.length) % F.matches.length;
    const m = F.matches[F.idx];
    const b = Ed.blocks()[m.bi];
    if (!b) return;
    b.classList.add('md-focus');
    Ed.selectRange(b, m.start, m.start + m.len);
    b.scrollIntoView({ block: 'center' });
    $('#find-count').textContent = (F.idx + 1) + '/' + F.matches.length;
  }

  function replaceCurrent() {
    const q = $('#find-input').value, rep = $('#replace-input').value;
    if (!q || !F.matches.length) return;
    const m = F.matches[Math.max(0, F.idx)];
    const b = Ed.blocks()[m.bi];
    if (!b) return;
    const raw = MD.rawText(b);
    const next = raw.slice(0, m.start) + rep + raw.slice(m.start + m.len);
    Ed.setBlockRaw(b, next, m.start + rep.length);
    findMatches(q);
    if (F.matches.length) gotoMatch(Math.min(F.idx, F.matches.length - 1));
  }

  function replaceAllMatches() {
    const q = $('#find-input').value, rep = $('#replace-input').value;
    if (!q) return;
    const text = Ed.text();
    const parts = text.split(q);
    if (parts.length < 2) return;
    Ed.load(parts.join(rep));
    markDirty();
    findMatches(q);
    toast('已替换 ' + (parts.length - 1) + ' 处');
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);background:var(--fg);color:var(--bg);' +
      'padding:7px 14px;border-radius:16px;font-size:12px;z-index:80;opacity:.94';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  function openFind() {
    const bar = $('#find-bar');
    bar.hidden = false;
    $('#find-input').focus();
    $('#find-input').select();
  }

  /* ---------------- 表格插入 / 模态框 / 数学排版 ---------------- */

  let modalOk = null;
  function openModal(title, bodyHTML, onOk) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHTML;
    $('#modal-mask').hidden = false;
    modalOk = onOk;
    $('#modal-ok').style.display = onOk ? '' : 'none';
    $('#modal-cancel').textContent = onOk ? '取消' : '关闭';
    const first = $('#modal-body input, #modal-body select');
    if (first) first.focus();
  }
  function closeModal() {
    $('#modal-mask').hidden = true;
    modalOk = null;
    $('#modal-ok').style.display = '';
    $('#modal-cancel').textContent = '取消';
  }

  const CHEATSHEET = (() => {
    const F = '`'.repeat(3);
    return [
      '# 语法速查',
      '',
      '## 标题',
      '`# 一级`　`## 二级`　`### 三级`（到六级）',
      '',
      '## 强调',
      '`**粗体**`　`*斜体*`　`~~删除线~~`　`==高亮==`　行内代码用反引号包起来',
      '',
      '## 列表',
      '- 无序项（行首 - * + 都行）',
      '1. 有序项',
      '- [ ] 待办　- [x] 已完成',
      '',
      '## 引用与提示框',
      '> 引用一行',
      '> [!TIP]',
      '> NOTE / TIP / IMPORTANT / WARNING / CAUTION',
      '',
      '## 表格',
      '| 左对齐 | 居中 | 右对齐 |',
      '|:---|:---:|---:|',
      '| a | b | c |',
      '',
      '## 代码块',
      F + 'js',
      'const a = 1;',
      F,
      '',
      '## 数学',
      '行内公式 $a^2 + b^2 = c^2$',
      '行间公式：',
      '$$',
      '\\int_0^1 x\\,dx = \\frac{1}{2}',
      '$$',
      '',
      '## 其他',
      '[链接](https://example.com)　![图片](assets/a.png)　脚注[^1]',
      '[TOC]　---（分割线）',
      '',
      '[^1]: 脚注内容',
    ].join('\n');
  })();

  function showCheatsheet() {
    const html = MD.split(CHEATSHEET).map(c => MD.renderBlock(c.raw)).join('');
    openModal('语法速查', '<div class="cheat">' + html + '</div>', null);
    if (window.katex) {
      document.querySelectorAll('#modal-body .md-inline-math').forEach(el => {
        const out = el.querySelector('.md-math-out');
        if (out && el.dataset.tex) { try { katex.render(el.dataset.tex, out, { throwOnError: false }); } catch (e) {} }
      });
    }
  }

  function buildTable(rows, cols, align) {
    const a = align === 'center' ? ':---:' : align === 'right' ? '---:' : ':---';
    const head = '| ' + Array.from({ length: cols }, (_, i) => '列' + (i + 1)).join(' | ') + ' |';
    const delim = '| ' + Array.from({ length: cols }, () => a).join(' | ') + ' |';
    const body = Array.from({ length: Math.max(0, rows - 1) },
      () => '| ' + Array.from({ length: cols }, () => '  ').join(' | ') + ' |');
    return [head, delim].concat(body).join('\n');
  }

  function tableDialog() {
    openModal('插入表格',
      '<div class="field"><label>行数</label><input id="tbl-rows" type="number" min="1" max="50" value="3"></div>' +
      '<div class="field"><label>列数</label><input id="tbl-cols" type="number" min="1" max="12" value="3"></div>' +
      '<div class="field"><label>对齐</label><select id="tbl-align">' +
      '<option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></div>',
      () => {
        const rows = Math.max(1, Math.min(50, parseInt($('#tbl-rows').value, 10) || 3));
        const cols = Math.max(1, Math.min(12, parseInt($('#tbl-cols').value, 10) || 3));
        const align = $('#tbl-align').value;
        const raw = buildTable(rows, cols, align);
        const els = Ed.blocks();
        const cur = Ed.caretBlock() || els[els.length - 1];
        if (cur) Ed.insertBlockAfter(cur, raw);
        else Ed.load(raw);
        markDirty();
      });
  }

  // KaTeX：只渲染 data-noraw 的 out 节点，源码始终留在 DOM 里供 rawText 取回
  function typesetMath() {
    if (!window.katex) return;
    const root = document.getElementById('write');
    root.querySelectorAll('.md-inline-math').forEach(el => {
      const out = el.querySelector('.md-math-out');
      const tex = el.dataset.tex;
      if (!out || !tex || out.dataset.tex === tex) return;
      try {
        katex.render(tex, out, { throwOnError: false, displayMode: false });
        out.dataset.tex = tex;
      } catch (e) { /* 保持源码可见 */ }
    });
    root.querySelectorAll('.md-math-block').forEach(el => {
      const src = el.querySelector('.md-math-src');
      const out = el.querySelector('.md-math-out');
      if (!src || !out) return;
      const tex = src.textContent.trim();
      if (out.dataset.tex === tex) return;
      try {
        katex.render(tex, out, { throwOnError: false, displayMode: true });
        out.dataset.tex = tex;
      } catch (e) {}
    });
  }

  /* ---------------- 源码模式 ---------------- */
  function toggleSource(force) {
    const on = force == null ? !S.sourceMode : force;
    S.sourceMode = on;
    $('#source-pane').hidden = !on;
    $('#editor-scroll').hidden = on;
    $('#btn-source').classList.toggle('on', on);
    if (on) {
      $('#source-area').value = Ed.text();
      $('#source-area').focus();
    } else {
      Ed.load($('#source-area').value);
      markDirty(); renderOutline();
    }
  }

  /* ---------------- 导出 ---------------- */
  function exportHTML() {
    const clone = document.getElementById('write').cloneNode(true);
    clone.querySelectorAll('.md-meta, .md-blockmeta').forEach(e => e.remove());
    clone.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
    const css = [...document.styleSheets].map(s => {
      try { return [...s.cssRules].map(r => r.cssText).join('\n'); } catch (e) { return ''; }
    }).join('\n');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + MD.esc(S.name) + '</title><style>' +
      css + '\n#write{max-width:780px;margin:0 auto;padding:40px 20px}</style></head><body data-theme="' + S.theme +
      '"><div id="write">' + clone.innerHTML + '</div></body></html>';
    post('exportHTML', { html, suggested: S.name.replace(/\.[^.]+$/, '') + '.html' });
  }

  function exportInBrowser() {
    const blob = new Blob([arguments.length ? '' : ''], { type: 'text/html' });
    void blob;
  }

  /* ---------------- 主题 ---------------- */
  const THEMES = ['light', 'dark', 'sepia'];
  function setTheme(t) {
    S.theme = t;
    document.body.dataset.theme = t;
    try { localStorage.setItem('monote.theme', t); } catch (e) {}
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('#btn-sidebar').onclick = () => document.body.classList.toggle('side-hidden');
    $('#btn-theme').onclick = () => setTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]);
    $('#btn-source').onclick = () => toggleSource();
    $('#btn-export').onclick = exportHTML;
    $('#btn-table').onclick = tableDialog;
    $('#btn-open-folder').onclick = () => post('pickFolder', {});

    // 模态框
    $('#modal-cancel').onclick = closeModal;
    $('#modal-ok').onclick = () => { const fn = modalOk; closeModal(); if (fn) fn(); };
    $('#modal-mask').addEventListener('mousedown', e => { if (e.target.id === 'modal-mask') closeModal(); });
    $('#modal-mask').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); $('#modal-ok').click(); }
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    });

    document.querySelectorAll('.side-tabs button').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.side-tabs button').forEach(x => x.classList.toggle('active', x === b));
        document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === b.dataset.tab + '-pane'));
      };
    });

    $('#editor-scroll').addEventListener('scroll', () => { spy(); }, { passive: true });

    $('#source-area').addEventListener('input', () => { markDirty(); });

    // 查找
    $('#find-input').addEventListener('input', e => findMatches(e.target.value));
    $('#find-next').onclick = () => gotoMatch(F.idx + 1);
    $('#find-prev').onclick = () => gotoMatch(F.idx - 1);
    $('#find-close').onclick = () => { $('#find-bar').hidden = true; $('#find-input').value = ''; F.matches = []; };
    $('#replace-one').onclick = () => replaceCurrent();
    $('#replace-all').onclick = () => replaceAllMatches();
    $('#replace-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.metaKey || e.ctrlKey ? replaceAllMatches() : replaceCurrent(); }
    });

    document.addEventListener('keydown', e => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        if (e.key === 'Escape' && !$('#find-bar').hidden) { $('#find-close').click(); return; }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); e.shiftKey ? post('saveAs', { content: Ed.text(), suggested: S.name }) : saveNow(); }
      else if (k === 'o') { e.preventDefault(); post('open', {}); }
      else if (k === 'n') { e.preventDefault(); newDoc(); }
      else if (k === 'f') { e.preventDefault(); openFind(); }
      else if (k === '\\') { e.preventDefault(); document.body.classList.toggle('side-hidden'); }
      else if (k === '/') { e.preventDefault(); toggleSource(); }
      else if (k === 'e') { e.preventDefault(); exportHTML(); }
    });

    // 拖放打开
    window.addEventListener('dragover', e => { e.preventDefault(); });
    window.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => openDocFile(null, f.name, r.result);
      r.readAsText(f);
    });

    window.addEventListener('beforeunload', () => { if (S.dirty && S.path) post('save', { path: S.path, content: Ed.text(), silent: true }); });
  }

  /* ---------------- 原生回调 ---------------- */
  window.MoNote = {
    openDoc(d) { openDocFile(d.path, d.name, d.content); },
    tree(d) {
      window.__treeInfo = { path: d.path, count: (d.entries || []).length };
      if (d.focus) activateTab('files');
      const pending = [...document.querySelectorAll('.tree-children[data-pending]')]
        .find(x => x.dataset.pending === d.path);
      if (pending) {
        pending.removeAttribute('data-pending');
        pending.innerHTML = '';
        [...treeLevel(d.path, d.entries || [], 1).children].forEach(c => pending.appendChild(c));
        pending.hidden = false;
        const row = pending.previousElementSibling;
        if (row) row.querySelector('.tw').textContent = '▾';
      } else if (!S.folder || d.path === S.folder) {
        renderTree(d.path, d.entries || []);
      } else {
        renderTree(d.path, d.entries || []);
      }
      highlightTree();
    },
    saveResult(d) {
      if (d.ok && d.path) { S.path = d.path; S.saved = Ed.text(); S.dirty = false; setTitle(); }
      if (d.error) alert('保存失败：' + d.error);
    },
    command(cmd) { run(cmd); },
    imageSaved(d) {
      if (!d || !d.ok) { if (d && d.error) alert('图片保存失败：' + d.error); return; }
      Ed.insertAt(S.pendingCaret, '![](' + d.rel + ')');
      S.pendingCaret = null;
      markDirty();
    },
    setTreeRoot(d) { requestTree(d && d.path ? d.path : d); },
  };

  function run(cmd) {
    switch (cmd) {
      case 'save': saveNow(); break;
      case 'saveAs': post('saveAs', { content: Ed.text(), suggested: S.name }); break;
      case 'open': post('open', {}); break;
      case 'new': newDoc(); break;
      case 'find': openFind(); break;
      case 'source': toggleSource(); break;
      case 'theme': $('#btn-theme').click(); break;
      case 'sidebar': document.body.classList.toggle('side-hidden'); break;
      case 'export': exportHTML(); break;
      case 'print': post('print', {}); break;
      case 'undo': Ed.undo(); break;
      case 'redo': Ed.redo(); break;
      case 'bold': Ed.bold(); break;
      case 'italic': Ed.italic(); break;
      case 'strike': Ed.strike(); break;
      case 'code': Ed.code(); break;
      case 'link': Ed.link(); break;
      case 'openFolder': post('pickFolder', {}); break;
      case 'table': tableDialog(); break;
      case 'replace': openFind(); $('#replace-input').focus(); break;
      case 'help': showCheatsheet(); break;
      default: break;
    }
  }

  /* ---------------- 启动 ---------------- */
  const DEMO = `# MoNote 使用说明

这是**即时渲染**编辑器的示例文档：光标离开后语法符号会隐藏，只看内容；点进哪一段，哪一段的 \`源码标记\` 就出现。

## 基本操作

- 直接打字即可，输入 \`# \` + 空格会变成标题
- **⌘S** 保存，**⌘⇧S** 另存为，**⌘N** 新建，**⌘O** 打开
- **⌘F** 查找，**⌘/** 切换源码模式，**⌘\\\\** 收起侧栏

## 支持的语法

| 语法 | 例子 |
|---|---|
| 粗体/斜体 | **粗**、*斜*、~~删除~~、==高亮== |
| 行内代码 | \`const a = 1\` |
| 链接 | [示例链接](https://example.com) |
| 任务 | 见下方清单 |

- [x] 块级即时渲染
- [x] 数学公式排版（KaTeX）

> 引用与提示块
> [!TIP]
> 代码块、表格、目录（[TOC]）、front matter、脚注都已支持。

\`\`\`js
// 代码块用 highlight.js 高亮
function hello(name) {
  return \`hi, \${name}\`;
}
\`\`\`

[TOC]
`;

  function boot() {
    Ed.init(document.getElementById('write'));
    Ed.on('afterRender', () => { renderOutline(); updateStats(); resolveImages(); typesetMath(); markDirty(); });
    Ed.on('pasteImage', file => {
      const caret = Ed.currentCaret();
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1];
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        S.pendingCaret = caret;
        post('saveImage', { base64: b64, ext });
      };
      reader.readAsDataURL(file);
    });
    bind();
    if (native) document.body.classList.add('native');
    try { const t = localStorage.getItem('monote.theme'); if (t) setTheme(t); } catch (e) {}
    if (native) post('ready', {});
    else openDocFile('/demo/示例.md', '示例.md', DEMO);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
