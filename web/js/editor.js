/* editor.js — 即时渲染编辑器内核
 *
 * 与 Typora 同构的做法：
 *   - 每个 Markdown 块是 #write 下的一个可编辑元素，语法符号默认隐藏；
 *   - 光标进入某内联元素 → 该元素 .md-expand（显示它自己的符号）；块获焦 → .md-focus（显示块级符号）；
 *   - 任何输入 → 读回整块源码 → 重新解析该块 → 重建 DOM → 按字符偏移恢复光标。
 * 因为「DOM 中字符与源码一一对应」，读回/恢复都只是字符偏移算术，不需要富文本 diff。
 */
(function (g) {
  'use strict';

  const MD = g.MD;
  let ROOT = null;
  let undoStack = [], redoStack = [], lastSnap = 0, lastSnapText = '';
  let listeners = {};

  /* ---------- 基础工具 ---------- */

  const isNoraw = (el) => el.nodeType === 1 && el.hasAttribute && el.hasAttribute('data-noraw');
  const blocks = () => ROOT ? [...ROOT.children].filter(el => el.dataset && el.dataset.type) : [];

  function textNodesOf(el) {
    const arr = [];
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) arr.push(c);
        else if (c.nodeType === 1) {
          if (c.hasAttribute('data-noraw')) continue;
          walk(c);
        }
      }
    })(el);
    return arr;
  }

  function blockOf(node) {
    let n = node;
    while (n && n !== ROOT) {
      if (n.parentNode === ROOT && n.dataset && n.dataset.type) return n;
      n = n.parentNode;
    }
    return null;
  }

  function caretOffsetIn(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return -1;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return -1;
    const nodes = textNodesOf(el);
    let acc = 0;
    for (const n of nodes) {
      if (n === range.startContainer) return acc + Math.min(range.startOffset, n.length);
      const nr = document.createRange();
      nr.selectNodeContents(n);
      if (nr.compareBoundaryPoints(Range.END_TO_START, range) <= 0) acc += n.length;
      else break;
    }
    return acc;
  }

  function ensureVisible(node, block) {
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n !== block) {
      if (n.classList && (n.classList.contains('md-inline') || n.classList.contains('md-meta'))) n.classList.add('md-expand');
      n = n.parentNode;
    }
    if (block) block.classList.add('md-focus');
  }

  function setCaret(el, offset, alsoExpand) {
    if (ROOT && document.activeElement !== ROOT) {
      try { ROOT.focus({ preventScroll: true }); } catch (e) { ROOT.focus(); }
    }
    const nodes = textNodesOf(el);
    let acc = 0, target = null, off = 0;
    for (const n of nodes) {
      if (offset <= acc + n.length) { target = n; off = Math.max(0, Math.min(n.length, offset - acc)); break; }
      acc += n.length;
    }
    const sel = window.getSelection();
    const r = document.createRange();
    if (target) {
      if (alsoExpand) ensureVisible(target, el);
      r.setStart(target, off); r.collapse(true);
    } else {
      r.selectNodeContents(el); r.collapse(false);
    }
    sel.removeAllRanges(); sel.addRange(r);
  }

  function updateExpand() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const node = sel.getRangeAt(0).startContainer;
    const blk = blockOf(node);
    ROOT.querySelectorAll('.md-focus').forEach(e => { if (e !== blk) e.classList.remove('md-focus'); });
    ROOT.querySelectorAll('.md-expand').forEach(e => e.classList.remove('md-expand'));
    if (!blk) return;
    blk.classList.add('md-focus');
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n !== blk) {
      if (n.classList && n.classList.contains('md-inline')) n.classList.add('md-expand');
      n = n.parentNode;
    }
    // 光标落在隐藏的标记里 → 展开它的父内联元素
    if (n === blk && node.nodeType === 1 && node.classList.contains('md-meta')) node.classList.add('md-expand');
    const t = node.nodeType === 1 ? node : node.parentNode;
    if (t && t.classList && t.classList.contains('md-meta')) t.classList.add('md-expand');
  }

  /* ---------- 渲染 ---------- */

  function renderAll(text, caret) {
    const chunks = MD.split(text);
    ROOT.innerHTML = chunks.length ? chunks.map(c => MD.renderBlock(c.raw)).join('')
      : '<p class="md-block md-para md-end-block" data-type="para"><br></p>';
    const els = blocks();
    els.forEach((el, i) => {
      if (chunks[i]) el.dataset.nl = String(chunks[i].nl);
      el.setAttribute('spellcheck', 'false');
      el.contentEditable = 'true';
    });
    ROOT.querySelectorAll('[data-noraw]').forEach(e => e.setAttribute('contenteditable', 'false'));
    fillToc();
    if (caret) focusAt(caret.index, caret.offset);
    emit('afterRender');
  }

  function text() {
    let out = '';
    blocks().forEach(b => {
      out += MD.rawText(b) + '\n'.repeat(parseInt(b.dataset.nl || '0', 10));
    });
    return out;
  }

  function focusAt(index, offset) {
    const els = blocks();
    if (!els.length) return;
    const el = els[Math.max(0, Math.min(index, els.length - 1))] || els[0];
    el.classList.add('md-focus');
    setCaret(el, offset || 0, true);
    el.scrollIntoView({ block: 'nearest' });
  }

  // 重新渲染单个块（可能因为输入而变成多个块）
  function refresh(block, caretOffset) {
    const raw = MD.rawText(block);
    const nl = parseInt(block.dataset.nl || '1', 10);
    const chunks = MD.split(raw);
    if (!chunks.length) {
      const empty = document.createElement('p');
      empty.className = 'md-block md-para md-end-block';
      empty.dataset.type = 'para';
      empty.dataset.nl = String(nl);
      empty.innerHTML = '<br>';
      empty.contentEditable = 'true';
      block.replaceWith(empty);
      setCaret(empty, 0);
      return;
    }
    const frag = document.createDocumentFragment();
    const made = [];
    chunks.forEach((c, i) => {
      const holder = document.createElement('div');
      holder.innerHTML = MD.renderBlock(c.raw);
      const el = holder.firstElementChild;
      if (!el) return;
      el.dataset.nl = String(i === chunks.length - 1 ? nl : c.nl);
      el.contentEditable = 'true';
      el.setAttribute('spellcheck', 'false');
      frag.appendChild(el);
      made.push(el);
    });

    // 光标在块尾空白（例如刚按下回车）→ 补一个空段落
    let endPos = 0;
    chunks.forEach((c, i) => { endPos += MD.rawText(made[i] || document.createElement('p')).length + (i === chunks.length - 1 ? nl : c.nl); });
    let trailing = null;
    if (caretOffset >= endPos && /\n\s*$/.test(raw)) {
      trailing = document.createElement('p');
      trailing.className = 'md-block md-para md-end-block';
      trailing.dataset.type = 'para';
      trailing.dataset.nl = '0';
      trailing.innerHTML = '<br>';
      trailing.contentEditable = 'true';
      frag.appendChild(trailing);
      made.push(trailing);
    }

    block.replaceWith(frag);

    // nl 归属：最后一个 chunk 保留「到下一个块的间隔」，前面 chunk 用 raw 内部间隔
    made.forEach((el, i) => {
      const c = chunks[i];
      if (!c) return;
      el.dataset.nl = String(i === made.length - 1 && !trailing ? c.nl + nl : c.nl);
    });
    if (trailing) trailing.dataset.nl = String(nl);

    // 定位光标
    let acc = 0;
    for (let i = 0; i < made.length; i++) {
      const len = MD.rawText(made[i]).length;
      if (caretOffset <= acc + len || i === made.length - 1) {
        made[i].classList.add('md-focus');
        setCaret(made[i], Math.max(0, caretOffset - acc), true);
        break;
      }
      acc += len + (parseInt(made[i].dataset.nl || '1', 10));
    }
    fillToc();
    emit('afterRender');
  }

  function fillToc() {
    ROOT.querySelectorAll('.md-toc').forEach(toc => {
      const list = toc.querySelector('.md-toc-list');
      if (!list) return;
      const hs = blocks().filter(b => b.dataset.type === 'heading');
      list.innerHTML = hs.map(h => {
        const lv = parseInt(h.dataset.level || '1', 10);
        const txt = h.querySelector('.md-content') ? h.querySelector('.md-content').textContent : h.textContent;
        return '<li class="md-toc-item md-toc-h' + lv + '"><a class="md-toc-inner" data-hid="' + h.id + '">' + MD.esc(txt) + '</a></li>';
      }).join('') || '<li class="md-toc-empty">（暂无标题）</li>';
    });
  }

  /* ---------- 编辑操作 ---------- */

  function snapshot(force) {
    const t = text();
    if (!force && t === lastSnapText && Date.now() - lastSnap < 400) return;
    const b = blockOf(window.getSelection().anchorNode || ROOT);
    const caret = b ? { index: blocks().indexOf(b), offset: caretOffsetIn(b) } : null;
    undoStack.push({ text: t, caret });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    lastSnap = Date.now();
    lastSnapText = t;
  }

  function undo() {
    if (!undoStack.length) return;
    const cur = { text: text(), caret: null };
    const s = undoStack.pop();
    redoStack.push(cur);
    renderAll(s.text, s.caret && s.caret.index >= 0 ? s.caret : null);
    lastSnapText = s.text;
  }

  function redo() {
    if (!redoStack.length) return;
    const s = redoStack.pop();
    undoStack.push({ text: text(), caret: null });
    renderAll(s.text, null);
    lastSnapText = s.text;
  }

  function insertText(str, block) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const tn = document.createTextNode(str);
    r.insertNode(tn);
    r.setStartAfter(tn); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }

  function wrapSelection(before, after) {
    const b = blockOf(window.getSelection().anchorNode);
    if (!b) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const start = caretOffsetIn(b);
    if (start < 0) return;
    const selText = range.toString();
    const raw = MD.rawText(b);
    const end = start + selText.length;
    // 已有包裹则去掉
    const beforeSlice = raw.slice(Math.max(0, start - before.length), start);
    const afterSlice = raw.slice(end, end + after.length);
    let next, caret;
    if (beforeSlice === before && afterSlice === after) {
      next = raw.slice(0, start - before.length) + raw.slice(start, end) + raw.slice(end + after.length);
      caret = start - before.length + selText.length;
    } else {
      next = raw.slice(0, start) + before + raw.slice(start, end) + after + raw.slice(end);
      caret = end + before.length + after.length;
    }
    snapshot(true);
    replaceRaw(b, next, caret);
  }

  function replaceRaw(block, raw, caretOffset) {
    // 直接改内容：用一段文本代表新源码，再走 refresh 统一重解析
    block.textContent = raw;
    refresh(block, caretOffset);
  }

  function blockIndex(el) { return blocks().indexOf(el); }

  function mergeBackward(block) {
    const idx = blockIndex(block);
    if (idx <= 0) return;
    const prev = blocks()[idx - 1];
    const prevRaw = MD.rawText(prev);
    const curRaw = MD.rawText(block);
    snapshot(true);
    prev.dataset.nl = block.dataset.nl || prev.dataset.nl;
    prev.textContent = prevRaw + curRaw;
    const caret = prevRaw.length;
    block.remove();
    refresh(prev, caret);
  }

  function mergeForward(block) {
    const idx = blockIndex(block);
    const all = blocks();
    if (idx < 0 || idx >= all.length - 1) return;
    const next = all[idx + 1];
    const raw = MD.rawText(block) + MD.rawText(next);
    snapshot(true);
    block.dataset.nl = next.dataset.nl || block.dataset.nl;
    next.remove();
    block.textContent = raw;
    refresh(block, raw.length);
  }

  /* ---------- 键盘 ---------- */

  function keydown(e) {
    const meta = e.metaKey || e.ctrlKey;
    const sel = window.getSelection();
    const block = blockOf(sel.anchorNode);
    const offset = block ? caretOffsetIn(block) : -1;
    const raw = block ? MD.rawText(block) : '';
    const mod = /^(input|paste|cut|delete|drop)$/;

    if (meta) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === 'b') { e.preventDefault(); wrapSelection('**', '**'); return; }
      if (k === 'i') { e.preventDefault(); wrapSelection('*', '*'); return; }
      if (k === 'k') { e.preventDefault(); wrapSelection('[', '](url)'); return; }
      if (k === 'a') return; // 交给浏览器
      return;
    }

    if (e.key === 'Enter') {
      if (!block) return;
      e.preventDefault();
      snapshot(true);
      if (block.dataset.type === 'table') return;
      if (e.shiftKey) { insertText('\n'); refresh(block, offset + 1); return; }
      if (block.dataset.type === 'fence' || block.dataset.type === 'meta') { insertText('\n'); refresh(block, offset + 1); return; }

      const lineStart = raw.lastIndexOf('\n', offset - 1) + 1;
      const lineEnd = raw.indexOf('\n', offset) < 0 ? raw.length : raw.indexOf('\n', offset);
      const line = raw.slice(lineStart, lineEnd);
      const listM = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(line);
      const quote = /^\s*>\s?/.test(line);
      const atEndOfLine = offset >= lineEnd;
      const lineHasContent = line.replace(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/^\s*>\s?/, '').trim();

      if (listM && e.shiftKey === false) {
        if (!lineHasContent) {
          // 空列表项：退出列表
          const repl = raw.slice(0, lineStart) + raw.slice(lineEnd + 1);
          block.textContent = repl;
          refresh(block, lineStart);
          return;
        }
        let mark = listM[2];
        if (/^\d/.test(mark)) mark = (parseInt(mark, 10) + 1) + mark.slice(-1);
        const prefix = '\n' + listM[1] + mark + ' ' + (listM[3] || '');
        insertText(prefix);
        refresh(block, offset + prefix.length);
        return;
      }
      if (quote) {
        insertText('\n> ');
        refresh(block, offset + 3);
        return;
      }
      const ins = atEndOfLine ? '\n\n' : '\n\n';
      insertText(ins);
      refresh(block, offset + ins.length);
      return;
    }

    if (e.key === 'Backspace') {
      if (!block) return;
      if (offset === 0) {
        if (block.dataset.type === 'heading' && offset === 0) { /* 允许合并 */ }
        e.preventDefault(); mergeBackward(block); return;
      }
      // 列表项行首退格 → 去掉标记
      const lineStart = raw.lastIndexOf('\n', offset - 1) + 1;
      if (offset === lineStart) {
        const line = raw.slice(lineStart);
        const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
        if (m) {
          e.preventDefault(); snapshot(true);
          const next = raw.slice(0, lineStart) + line.slice(m[0].length);
          block.textContent = next;
          refresh(block, lineStart);
          return;
        }
      }
      return; // 普通退格交给浏览器
    }

    if (e.key === 'Tab') {
      if (!block) return;
      e.preventDefault(); snapshot(true);
      if (block.dataset.type === 'table') {
        const anchor = window.getSelection().anchorNode;
        const cell = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        const td = cell && cell.closest ? cell.closest('.md-td') : null;
        if (td) {
          const cells = [...block.querySelectorAll('.md-td')];
          const nx = cells[cells.indexOf(td) + 1];
          block.classList.add('md-focus');
          if (nx) setCaret(nx, 0, true);
        }
        return;
      }
      if (e.shiftKey) {
        // 去掉行首两个空格
        const lineStart = raw.lastIndexOf('\n', offset - 1) + 1;
        const line = raw.slice(lineStart);
        const n = Math.min(2, (line.match(/^\s*/) || [''])[0].length);
        if (n) { const next = raw.slice(0, lineStart) + line.slice(n); block.textContent = next; refresh(block, Math.max(0, offset - n)); }
      } else {
        insertText('  ');
        refresh(block, offset + 2);
      }
      return;
    }

    if (e.key === 'Delete' && offset >= raw.length) {
      e.preventDefault(); mergeForward(block); return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // 跨块移动：在块首/块尾时用坐标取行
      const sel0 = window.getSelection();
      if (!sel0.rangeCount || !block) return;
      const rr = sel0.getRangeAt(0).getBoundingClientRect();
      const x = rr.left || 100, y = rr.top + (e.key === 'ArrowDown' ? 22 : -22);
      const el = document.elementFromPoint(x, Math.max(1, y));
      if (el && ROOT.contains(el)) {
        const target = blockOf(el);
        if (target && target !== block) {
          e.preventDefault();
          const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, Math.max(1, y)) : null;
          target.classList.add('md-focus');
          if (pos) {
            const s = window.getSelection();
            s.removeAllRanges(); s.addRange(pos);
          } else setCaret(target, 0, true);
        }
      }
      return;
    }
  }

  /* ---------- 事件绑定 ---------- */

  function onInput(e) {
    const sel = window.getSelection();
    const block = blockOf(sel.anchorNode) || blockOf(e.target);
    if (!block) return;
    const off = caretOffsetIn(block);
    if (off < 0) return;
    refresh(block, off);
  }

  function onPaste(e) {
    const block = blockOf(window.getSelection().anchorNode);
    if (!block) return;
    // 剪贴板里是图片 → 交给原生落盘，再插入相对路径
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            emit('pasteImage', f);
            return;
          }
        }
      }
    }
    const textData = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (textData == null) return;
    e.preventDefault();
    snapshot(true);
    const off = caretOffsetIn(block);
    insertText(textData.replace(/\r\n/g, '\n'));
    refresh(block, off + textData.length);
  }

  function onClick(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('md-task-checkbox')) {
      const li = t.closest('li');
      if (!li) return;
      const block = blockOf(li);
      const off = caretOffsetIn(block);
      const raw = MD.rawText(block);
      const idx = raw.indexOf('[ ]');
      if (idx > -1) {
        const next = raw.slice(0, idx) + '[x]' + raw.slice(idx + 3);
        snapshot(true); block.textContent = next; refresh(block, Math.min(off < 0 ? 0 : off, next.length));
      } else {
        const idx2 = raw.search(/\[[xX]\]/);
        if (idx2 > -1) {
          const next = raw.slice(0, idx2) + '[ ]' + raw.slice(idx2 + 3);
          snapshot(true); block.textContent = next; refresh(block, Math.min(off < 0 ? 0 : off, next.length));
        }
      }
      e.preventDefault();
      return;
    }
    if (t.tagName === 'A') {
      const href = t.getAttribute('data-href') || t.getAttribute('href');
      const hid = t.getAttribute('data-hid');
      if (hid) { const h = ROOT.querySelector('#' + CSS.escape(hid)); if (h) { h.scrollIntoView({ block: 'start', behavior: 'smooth' }); e.preventDefault(); return; } }
      if (href && /^https?:|^mailto:|^file:|^#/.test(href)) {
        if (href.startsWith('#')) { const el = ROOT.querySelector(CSS.escape(href.slice(1))); if (el) el.scrollIntoView(); }
        else emit('openLink', href);
        e.preventDefault();
      }
    }
  }

  function onKeyUp(e) {
    updateExpand();
  }

  /* ---------- 对外接口 ---------- */

  const Ed = {
    init(rootEl) {
      ROOT = rootEl;
      ROOT.setAttribute('contenteditable', 'true');
      ROOT.setAttribute('spellcheck', 'false');
      ROOT.addEventListener('input', onInput);
      ROOT.addEventListener('beforeinput', (e) => {
        const t = e.inputType || '';
        if (/^(insert|delete|format)/.test(t)) snapshot(true);
      });
      ROOT.addEventListener('keydown', keydown);
      ROOT.addEventListener('paste', onPaste);
      ROOT.addEventListener('click', onClick);
      ROOT.addEventListener('keyup', onKeyUp);
      ROOT.addEventListener('mouseup', () => setTimeout(updateExpand, 0));
      document.addEventListener('selectionchange', () => { if (ROOT && ROOT.contains(document.activeElement)) updateExpand(); });
      return this;
    },
    load(text, caret) { undoStack = []; redoStack = []; lastSnapText = text; renderAll(text || '', caret); },
    text,
    blocks,
    serialize: text,
    focusAt,
    undo, redo,
    insertText: (s) => { const b = blockOf(window.getSelection().anchorNode); if (!b) return; const o = caretOffsetIn(b); snapshot(true); insertText(s); refresh(b, o + s.length); },
    bold() { wrapSelection('**', '**'); },
    italic() { wrapSelection('*', '*'); },
    strike() { wrapSelection('~~', '~~'); },
    code() { wrapSelection('`', '`'); },
    link() { wrapSelection('[', '](https://)'); },
    // 用新源码替换整块并重渲染（查找替换、插入表格用）
    setBlockRaw(el, raw, caret) {
      if (!el || !el.parentNode) return;
      el.textContent = raw;
      refresh(el, caret == null ? 0 : caret);
    },
    // 在当前块之后插入一个新块
    insertBlockAfter(el, raw) {
      const tmp = document.createElement('div');
      tmp.innerHTML = MD.renderBlock(raw);
      const nb = tmp.firstElementChild;
      if (!nb) return;
      nb.dataset.nl = '2';
      nb.contentEditable = 'true';
      nb.setAttribute('spellcheck', 'false');
      el.dataset.nl = '2';
      el.after(nb);
      fillToc();
      emit('afterRender');
      nb.classList.add('md-focus');
      setCaret(nb, MD.rawText(nb).length, true);
      nb.scrollIntoView({ block: 'nearest' });
    },
    caretBlock() { return blockOf(window.getSelection().anchorNode); },
    currentCaret() {
      const b = blockOf(window.getSelection().anchorNode);
      if (!b) return null;
      return { index: blocks().indexOf(b), offset: caretOffsetIn(b) };
    },
    insertAt(c, str) {
      const els = blocks();
      const b = els[c && c.index >= 0 ? c.index : els.length - 1];
      if (!b) return;
      const raw = MD.rawText(b);
      const off = Math.max(0, Math.min(raw.length, c ? c.offset : raw.length));
      b.textContent = raw.slice(0, off) + str + raw.slice(off);
      refresh(b, off + str.length);
    },
    outline() {
      return blocks().filter(b => b.dataset.type === 'heading').map((h, i) => ({
        index: i,
        level: parseInt(h.dataset.level || '1', 10),
        text: (h.querySelector('.md-content') || h).textContent.trim(),
        el: h,
      }));
    },
    stats() {
      const t = text();
      const chars = t.replace(/\s/g, '').length;
      const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      const words = (t.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length + cjk;
      return { chars, words, lines: t.split('\n').length, minutes: Math.max(1, Math.round(words / 300)) };
    },
    off(evt, fn) {
      listeners[evt] = (listeners[evt] || []).concat(fn);
    },
    on(evt, fn) { this.off(evt, fn); },
    emit,
    selectRange(el, start, end) {
      const nodes = textNodesOf(el);
      let acc = 0, sN = null, sO = 0, eN = null, eO = 0;
      for (const n of nodes) {
        if (!sN && start <= acc + n.length) { sN = n; sO = Math.max(0, Math.min(n.length, start - acc)); }
        if (!eN && end <= acc + n.length) { eN = n; eO = Math.max(0, Math.min(n.length, end - acc)); break; }
        acc += n.length;
      }
      if (!sN) return;
      const r = document.createRange();
      r.setStart(sN, sO);
      if (eN) r.setEnd(eN, eO); else r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      updateExpand();
    },
  };

  function emit(evt, data) {
    (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (err) { console.error(err); } });
  }

  g.Ed = Ed;
})(window);
