/* parser.js — Markdown → DOM(HTML 字符串)
 *
 * 核心不变量（复刻 Typora 的关键）：
 *   渲染后的 DOM 中，恰好按顺序包含源码的每一个字符。
 *   语法符号包装为 <span class="md-meta"> / <span class="md-blockmeta">，默认 display:none，
 *   光标进入时加 .md-expand / .md-focus 才显示。
 *   因此 rawText(el) === 源码，源码 → DOM → 源码无损往返（可直接保存）。
 */
(function (g) {
  'use strict';

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');
  const meta = s => '<span class="md-meta">' + esc(s) + '</span>';
  const bmeta = s => '<span class="md-blockmeta">' + esc(s) + '</span>';

  const RE = {
    fence: /^(\s*)(`{3,}|~{3,})(.*)$/,
    atx: /^(#{1,6})(\s+)(.*)$/,
    hr: /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/,
    quote: /^ {0,3}>(.*)$/,
    list: /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/,
    tableDelim: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    html: /^\s{0,3}<(?:[a-zA-Z][\w-]*|\/[a-zA-Z]|!--)/,
    setext: /^ {0,3}(=+|-+)\s*$/,
  };
  const isBlank = l => /^\s*$/.test(l);
  const isTableRow = l => l.indexOf('|') > -1 && !RE.fence.test(l);
  const lines = raw => raw.split('\n');

  /* ---------------- 块切分：精确记录块间空行 ---------------- */

  function nextBlock(ls, i) {
    const line = ls[i];
    if (i === 0 && /^---\s*$/.test(line)) {
      let j = 1;
      while (j < ls.length && !/^(---|\.\.\.)\s*$/.test(ls[j])) j++;
      if (j < ls.length) return j + 1;
    }
    if (isBlank(line)) return i + 1;

    const fm = RE.fence.exec(line);
    if (fm) {
      const ch = fm[2][0], len = fm[2].length;
      const rx = new RegExp('^\\s*' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
      let j = i + 1;
      while (j < ls.length && !rx.test(ls[j])) j++;
      return Math.min(j + 1, ls.length);
    }
    if (RE.atx.test(line)) return i + 1;
    if (i + 1 < ls.length && RE.setext.test(ls[i + 1]) && !RE.hr.test(line) && !RE.list.test(line)) return i + 2;
    if (RE.hr.test(line)) return i + 1;
    if (i + 1 < ls.length && isTableRow(line) && RE.tableDelim.test(ls[i + 1])) {
      let j = i + 2;
      while (j < ls.length && isTableRow(ls[j])) j++;
      return j;
    }
    if (RE.quote.test(line)) {
      let j = i + 1;
      while (j < ls.length && !isBlank(ls[j]) && (RE.quote.test(ls[j]) || !this) && !/^(#{1,6}\s|```|~~~|\s*\|)/.test(ls[j])) j++;
      return j;
    }
    if (RE.list.test(line)) {
      let j = i + 1;
      while (j < ls.length) {
        const l = ls[j];
        if (isBlank(l)) {
          let k = j + 1;
          while (k < ls.length && isBlank(ls[k])) k++;
          if (k < ls.length && (RE.list.test(ls[k]) || /^\s{2,}\S/.test(ls[k]))) { j = k; continue; }
          break;
        }
        if (RE.list.test(l) || /^\s+\S/.test(l)) { j++; continue; }
        break;
      }
      return j;
    }
    if (RE.html.test(line)) {
      let j = i + 1;
      while (j < ls.length && !isBlank(ls[j])) j++;
      return j;
    }
    let j = i + 1;
    while (j < ls.length) {
      const l = ls[j];
      if (isBlank(l)) break;
      if (RE.fence.test(l) || RE.atx.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.list.test(l)) break;
      if (isTableRow(l) && j + 1 < ls.length && RE.tableDelim.test(ls[j + 1])) break;
      j++;
    }
    return j;
  }

  // → [{raw, nl}]，nl 为该块之后（含块尾空行）到下一个块之间的换行符数
  function split(text) {
    const ls = text.split('\n');
    const chunks = [];
    let i = 0;
    while (i < ls.length) {
      if (isBlank(ls[i])) { i++; continue; }
      const start = i;
      let end = nextBlock(ls, i);
      if (end <= start) end = start + 1;
      while (end > start + 1 && isBlank(ls[end - 1])) end--;
      chunks.push({ start, end });
      i = end;
    }
    return chunks.map((c, k) => {
      const next = chunks[k + 1];
      return {
        raw: ls.slice(c.start, c.end).join('\n'),
        nl: next ? next.start - c.end + 1 : (ls.length - c.end),
      };
    });
  }

  /* ---------------- 轻量代码高亮（字符不变） ---------------- */

  const HL_ALIAS = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', python3: 'python', sh: 'bash', shell: 'bash', zsh: 'bash',
    yml: 'yaml', md: 'markdown', c: 'c', 'c++': 'cpp', cs: 'csharp',
    golang: 'go', rs: 'rust', kt: 'kotlin', ps1: 'powershell', vb: 'vbnet',
    html: 'xml', vue: 'xml', text: 'plaintext',
  };

  const KW = new Set(('abstract as async await break case catch class const continue def default delete do else elif ' +
    'end enum except export extends false finally fn for from func function global go if import in instanceof ' +
    'int interface is lambda let loop match mod mut new nil None not null of or package pass private ' +
    'protected public raise readonly ref return self static struct super switch this throw throws trait ' +
    'true try type typeof undefined union unsafe use var void while with yield impl where pub crate ' +
    'string number boolean any unknown never void console').split(/\s+/));

  function highlight(code, lang) {
    const l = (lang || '').toLowerCase();
    // 优先用 highlight.js（从 MdStorm 包里带出来的 11.x），失败回落自写规则
    if (g.hljs && l && !/^(text|plain|none)$/.test(l)) {
      try {
        const id = HL_ALIAS[l] || l;
        if (g.hljs.getLanguage(id)) {
          return g.hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
        }
      } catch (e) { /* fall through */ }
    }
    if (/^(text|plain|none|)$/.test(l)) return esc(code);
    const rules = [
      [/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)/, 'cm-comment'],
      [/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/, 'cm-string'],
      [/\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/, 'cm-number'],
      [/\b[A-Za-z_$][\w$]*\b/, 'cm-word'],
    ];
    let out = '', i = 0;
    while (i < code.length) {
      let hit = null;
      const rest = code.slice(i);
      for (const [rx, cls] of rules) {
        const m = rx.exec(rest);
        if (m && m.index === 0) { hit = { text: m[0], cls }; break; }
      }
      if (!hit) { out += esc(code[i]); i++; continue; }
      if (hit.cls === 'cm-word' && !KW.has(hit.text)) out += esc(hit.text);
      else out += '<span class="' + hit.cls + '">' + esc(hit.text) + '</span>';
      i += hit.text.length;
    }
    return out;
  }

  /* ---------------- 内联 ---------------- */

  const EMOJI = { smile: '😄', laugh: '😆', grin: '😁', wink: '😉', heart: '❤️', '+1': '👍', '-1': '👎', fire: '🔥', tada: '🎉', rocket: '🚀', warning: '⚠️', bug: '🐛', bulb: '💡', check: '✅', x: '❌', star: '⭐', eyes: '👀', coffee: '☕', book: '📖', lock: '🔒', key: '🔑' };

  const DELIMS = [
    ['***', ['md-strong', 'md-em']], ['___', ['md-strong', 'md-em']],
    ['**', ['md-strong']], ['__', ['md-strong']],
    ['~~', ['md-del']], ['==', ['md-mark']],
    ['*', ['md-em']], ['_', ['md-em']],
  ];

  function findClose(src, from, d) {
    let i = from;
    while (i < src.length) {
      const k = src.indexOf(d, i);
      if (k < 0) return -1;
      let bs = 0, p = k - 1;
      while (p >= 0 && src[p] === '\\') { bs++; p--; }
      if (bs % 2 === 1) { i = k + 1; continue; }
      if (k > from && !/\s/.test(src[k - 1])) return k;
      i = k + d.length;
    }
    return -1;
  }

  function matchBracket(src, i) {
    let depth = 0;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (c === '\\') { k++; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  function parseDest(src, i) {
    if (src[i] !== '(') return null;
    let depth = 0, k = i;
    for (; k < src.length; k++) {
      const c = src[k];
      if (c === '\\') { k++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    if (k >= src.length) return null;
    return { inner: src.slice(i + 1, k), end: k + 1 };
  }

  function destUrl(inner) {
    const t = inner.trim();
    if (t.startsWith('<')) { const e = t.indexOf('>'); return e > 0 ? t.slice(1, e) : t.slice(1); }
    return t.split(/\s+/)[0] || '';
  }

  function inline(src) {
    let out = '', i = 0;
    while (i < src.length) {
      const c = src[i];

      if (c === '\\' && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!>~=$|^]/.test(src[i + 1])) {
        out += bmeta('\\') + esc(src[i + 1]); i += 2; continue;
      }

      if (c === '`') {
        let run = 1; while (src[i + run] === '`') run++;
        const f = '`'.repeat(run);
        const end = src.indexOf(f, i + run);
        if (end > -1) {
          out += '<code class="md-inline md-inline-code">' + meta(f) + esc(src.slice(i + run, end)) + meta(f) + '</code>';
          i = end + run; continue;
        }
      }

      if (c === '!' && src[i + 1] === '[') {
        const rb = matchBracket(src, i + 1);
        if (rb > 0) {
          const d = parseDest(src, rb + 1);
          if (d) {
            const alt = src.slice(i + 2, rb);
            const url = destUrl(d.inner);
            out += '<span class="md-inline md-image"><img class="md-img" data-noraw src="' + escAttr(url) + '" alt="' + escAttr(alt) + '">' +
              meta('![') + '<span class="md-content">' + inline(alt) + '</span>' + meta('](') +
              '<span class="md-url">' + esc(d.inner) + '</span>' + meta(')') + '</span>';
            i = d.end; continue;
          }
        }
      }

      if (c === '[' && src[i + 1] === '^') {
        const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
        if (m) {
          out += '<sup class="md-footnote"><a class="md-inline md-fn-ref" href="#fn-' + escAttr(m[1]) + '">' +
            meta('[') + meta('^') + esc(m[1]) + meta(']') + '</a></sup>';
          i += m[0].length; continue;
        }
      }

      if (c === '[') {
        const rb = matchBracket(src, i);
        if (rb > 0) {
          const text = src.slice(i + 1, rb);
          const d = parseDest(src, rb + 1);
          if (d) {
            out += '<a class="md-inline md-link" data-href="' + escAttr(destUrl(d.inner)) + '" href="' + escAttr(destUrl(d.inner)) + '">' +
              meta('[') + '<span class="md-content">' + inline(text) + '</span>' + meta('](') +
              '<span class="md-url">' + esc(d.inner) + '</span>' + meta(')') + '</a>';
            i = d.end; continue;
          }
          const rr = /^\[([^\]]*)\]/.exec(src.slice(rb + 1));
          const ref = ((rr && rr[1]) || text || '').toLowerCase();
          out += '<a class="md-inline md-link md-ref-link" data-ref="' + escAttr(ref) + '">' +
            meta('[') + '<span class="md-content">' + inline(text) + '</span>' + meta(']') +
            (rr ? meta('[' + rr[1] + ']') : '') + '</a>';
          i = rr ? rb + 1 + rr[0].length : rb + 1; continue;
        }
      }

      if (c === '<') {
        const m = /^<((?:https?|mailto|ftp):[^>\s]+)>/.exec(src.slice(i));
        if (m) {
          out += '<a class="md-inline md-link md-autolink" href="' + escAttr(m[1]) + '">' + meta('<') + esc(m[1]) + meta('>') + '</a>';
          i += m[0].length; continue;
        }
      }

      if (c === '$') {
        const m = /^\$(?!\s)((?:\\\$|[^$\n])+?)\$(?!\d)/.exec(src.slice(i));
        if (m) {
          out += '<span class="md-inline md-inline-math" data-tex="' + escAttr(m[1]) + '">' + meta('$') +
            '<span class="md-math-src">' + esc(m[1]) + '</span>' + meta('$') +
            '<span class="md-math-out" data-noraw></span></span>';
          i += m[0].length; continue;
        }
      }

      if (c === ':') {
        const m = /^:([a-z0-9_+-]+):/.exec(src.slice(i));
        if (m && EMOJI[m[1]]) {
          out += '<span class="md-inline md-emoji">' + esc(m[0]) + '<span class="md-emoji-glyph" data-noraw>' + EMOJI[m[1]] + '</span></span>';
          i += m[0].length; continue;
        }
      }

      let done = false;
      for (const [d, cls] of DELIMS) {
        if (!src.startsWith(d, i)) continue;
        if (d.length === 1 && src[i + 1] === d) continue;
        const end = findClose(src, i + d.length, d);
        if (end < 0) continue;
        const inner = src.slice(i + d.length, end);
        if (!inner.trim()) continue;
        out += '<span class="md-inline ' + cls.join(' ') + '">' + meta(d) +
          '<span class="md-content">' + inline(inner) + '</span>' + meta(d) + '</span>';
        i = end + d.length; done = true; break;
      }
      if (done) continue;

      out += esc(c); i++;
    }
    return out;
  }

  /* ---------------- 块渲染 ---------------- */

  function slug(s) {
    return (s || '').toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  }

  function renderHeading(raw) {
    const ls = lines(raw);
    const m = RE.atx.exec(ls[0]);
    let level, prefix, text, tail = '';
    if (m) {
      level = m[1].length;
      prefix = m[0].slice(0, level + m[2].length);
      text = m[3];
    } else {
      level = /^=/.test(ls[1] || '') ? 1 : 2;
      prefix = '';
      text = ls[0];
      tail = '\n' + ls[1];
    }
    const plain = text.replace(/[*_`~=\[\]]/g, '');
    return '<h' + level + ' class="md-block md-heading md-end-block" data-type="heading" data-level="' + level + '" id="h-' + slug(plain) + '">' +
      bmeta(prefix) + '<span class="md-content">' + inline(text) + '</span>' + (tail ? bmeta(tail) : '') + '</h' + level + '>';
  }

  function renderPara(raw) {
    const parts = raw.split('\n');
    let html = '';
    parts.forEach((p, k) => {
      html += inline(p);
      if (k < parts.length - 1) html += '\n';
    });
    return '<p class="md-block md-para md-end-block" data-type="para">' + html + '</p>';
  }

  function renderHr(raw) {
    return '<div class="md-block md-hr md-end-block" data-type="hr">' + bmeta(raw) + '<hr/></div>';
  }

  function renderFence(raw) {
    const ls = lines(raw);
    const m = RE.fence.exec(ls[0]);
    const info = m ? m[3].trim() : '';
    const lang = (info.split(/\s+/)[0] || '').replace(/^\{?\.?/, '').replace(/\}$/, '');
    const closed = ls.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(ls[ls.length - 1]);
    const body = (closed ? ls.slice(1, -1) : ls.slice(1)).join('\n');
    return '<pre class="md-block md-fences md-end-block" data-type="fence" data-lang="' + escAttr(lang) + '" lang="' + escAttr(lang) + '">' +
      bmeta(ls[0] + '\n') + '<code class="md-code">' + highlight(body, lang) + '</code>' +
      (closed ? bmeta('\n' + ls[ls.length - 1]) : '') + '</pre>';
  }

  function renderQuote(raw) {
    const ls = lines(raw);
    const alert = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(ls[0] || '');
    let html = '<blockquote class="md-block md-blockquote' +
      (alert ? ' md-alert md-alert-' + alert[1].toLowerCase() : '') + '" data-type="quote">';
    ls.forEach((l, k) => {
      const m = RE.quote.exec(l);
      const prefix = m ? l.slice(0, l.length - m[1].length) : '';
      let text = m ? m[1] : l;
      if (k === 0 && alert) {
        const am = /^(\s*\[![A-Za-z]+\])/.exec(text);
        if (am) { prefix; html += '<p class="md-quote-line">' + bmeta(prefix + am[1]) + inline(text.slice(am[1].length)); }
        else html += '<p class="md-quote-line">' + bmeta(prefix) + inline(text);
      } else {
        html += '<p class="md-quote-line">' + bmeta(prefix) + inline(text);
      }
      if (k < ls.length - 1) html += bmeta('\n');
      html += '</p>';
    });
    return html + '</blockquote>';
  }

  function renderList(raw) {
    const ls = lines(raw);
    const items = [];
    ls.forEach((l, k) => {
      const m = RE.list.exec(l);
      if (m) {
        items.push({ indent: m[1].length, mark: m[2], gap: m[3], text: m[4], nl: k < ls.length - 1 ? '\n' : '', cont: '' });
      } else if (items.length) {
        const last = items[items.length - 1];
        last.cont += '\n' + l;
        last.nl = k < ls.length - 1 ? '\n' : '';
      }
    });
    if (!items.length) return renderPara(raw);

    let html = '';
    const stack = [];
    items.forEach(it => {
      const ordered = /^\d/.test(it.mark);
      const tag = ordered ? 'ol' : 'ul';
      let text = it.text, taskMark = '';
      const task = /^\[( |x|X)\](\s|$)/.test(text);
      if (task) { taskMark = text.slice(0, 3) + (text[3] === ' ' ? ' ' : ''); text = text.slice(taskMark.length); }

      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';

      if (!stack.length) {
        html += '<' + tag + ' class="md-list ' + (ordered ? 'ol-list' : 'ul-list') + '" data-type="list"' +
          (ordered ? '' : ' data-mark="' + escAttr(it.mark) + '"') + '>';
        stack.push({ indent: it.indent, tag });
      } else if (it.indent > stack[stack.length - 1].indent) {
        html += '<' + tag + ' class="md-list ' + (ordered ? 'ol-list' : 'ul-list') + '"' +
          (ordered ? '' : ' data-mark="' + escAttr(it.mark) + '"') + '>';
        stack.push({ indent: it.indent, tag });
      } else {
        html += '</li>';
      }

      const lead = ' '.repeat(it.indent);
      html += '<li class="md-list-item' + (task ? ' md-task-list-item' : '') + '">' +
        bmeta(lead + it.mark + it.gap) +
        (task ? '<input type="checkbox" class="md-task-checkbox" data-noraw' + (/x/i.test(taskMark) ? ' checked' : '') + '>' + bmeta(taskMark) : '') +
        '<span class="md-li-content">' + inline(text) + (it.cont ? bmeta(it.cont) : '') + '</span>' +
        bmeta(it.nl);
    });
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return html;
  }

  function splitRow(line) {
    const parts = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && line[i + 1] === '|') { cur += '\\|'; i++; continue; }
      if (line[i] === '|') { parts.push(cur); cur = ''; continue; }
      cur += line[i];
    }
    parts.push(cur);
    return parts;
  }

  function cellAlign(t) {
    const s = t.trim();
    if (/^:-{1,}:$/.test(s)) return 'center';
    if (/^-{1,}:$/.test(s)) return 'right';
    if (/^:-{1,}$/.test(s)) return 'left';
    return '';
  }

  function renderTable(raw) {
    const ls = lines(raw);
    const headParts = splitRow(ls[0]);
    const delimParts = splitRow(ls[1] || '');
    const aligns = delimParts.map(cellAlign);
    const hasLead = /^\s*\|/.test(ls[0]);
    const hasTrail = /\|\s*$/.test(ls[0]);

    const emitRow = (parts, tag, isLastLine) => {
      let r = '<tr class="md-table-row">';
      const startK = hasLead ? 1 : 0;
      const endK = parts.length - (hasTrail ? 1 : 0);
      for (let k = startK; k < endK; k++) {
        const align = aligns[k - startK] ? ' style="text-align:' + aligns[k - startK] + '"' : '';
        let cell = '';
        if (k === startK && hasLead) cell += bmeta('|');
        cell += inline(parts[k]);
        const isLastCell = k === endK - 1;
        if (!isLastCell || hasTrail) cell += bmeta('|');
        if (isLastCell && !isLastLine) cell += bmeta('\n');
        r += '<' + tag + ' class="md-td"' + align + '>' + cell + '</' + tag + '>';
      }
      return r + '</tr>';
    };

    let html = '<figure class="md-block md-table-fig" data-type="table"><table class="md-table"><thead>';
    html += emitRow(headParts, 'th', false);
    html += '</thead>';
    // 分隔行：隐藏但保留字符
    const delimLine = delimParts.map((p, k) => inline(p) + (k < delimParts.length - 1 ? bmeta('|') : '')).join('') + bmeta('\n');
    html += '<tbody class="md-delim-body" style="display:none"><tr class="md-table-delim"><td>' + delimLine + '</td></tr></tbody>';
    html += '<tbody>';
    for (let k = 2; k < ls.length; k++) html += emitRow(splitRow(ls[k]), 'td', k === ls.length - 1);
    html += '</tbody></table></figure>';
    return html;
  }

  function renderMeta(raw) {
    return '<pre class="md-block md-meta-block md-end-block" data-type="meta">' + esc(raw) + '</pre>';
  }

  function renderHtml(raw) {
    return '<div class="md-block md-htmlblock md-end-block" data-type="html"><pre class="md-html-raw">' + esc(raw) + '</pre></div>';
  }

  function renderToc(raw) {
    return '<div class="md-block md-toc md-end-block" data-type="toc">' + bmeta(raw) +
      '<div class="md-toc-body" data-noraw><div class="md-toc-title">CONTENTS</div><ul class="md-toc-list"></ul></div></div>';
  }

  function renderDef(raw) {
    return '<div class="md-block md-def md-end-block" data-type="def"><pre class="md-def-raw">' + esc(raw) + '</pre></div>';
  }

  function renderMathBlock(raw) {
    const openM = /^\$\$[ \t]*\n?/.exec(raw) || /^\$\$/.exec(raw);
    const open = openM ? openM[0] : '$$';
    const closeM = /\n?[ \t]*\$\$$/.exec(raw);
    const close = closeM ? closeM[0] : '$$';
    const tex = raw.slice(open.length, raw.length - close.length);
    return '<div class="md-block md-math-block md-end-block" data-type="math">' +
      bmeta(open) + '<span class="md-math-src">' + esc(tex) + '</span>' + bmeta(close) +
      '<span class="md-math-out" data-noraw></span></div>';
  }

  function renderBlock(raw) {
    const ls = lines(raw);
    if (ls.length >= 2 && /^---\s*$/.test(ls[0])) return renderMeta(raw);
    if (RE.fence.test(ls[0])) return renderFence(raw);
    if (/^\$\$/.test(ls[0]) && /\$\$[ \t]*$/.test(ls[ls.length - 1]) && (ls.length > 1 || raw.length > 4)) return renderMathBlock(raw);
    if (RE.atx.test(ls[0])) return renderHeading(raw);
    if (ls.length === 2 && RE.setext.test(ls[1]) && !RE.hr.test(raw)) return renderHeading(raw);
    if (RE.hr.test(raw)) return renderHr(raw);
    if (ls.length >= 2 && isTableRow(ls[0]) && RE.tableDelim.test(ls[1])) return renderTable(raw);
    if (/^\[toc\]\s*$/i.test(raw.trim())) return renderToc(raw);
    if (/^\[\^?[^\]]+\]:/.test(raw.trim())) return renderDef(raw);
    if (RE.quote.test(ls[0])) return renderQuote(raw);
    if (RE.list.test(ls[0])) return renderList(raw);
    if (RE.html.test(ls[0])) return renderHtml(raw);
    return renderPara(raw);
  }

  /* ---------------- DOM → 源码 ---------------- */

  function rawText(el) {
    let s = '';
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeType === 1) {
          if (c.hasAttribute('data-noraw')) continue;
          if (c.tagName === 'BR') continue;
          walk(c);
        }
      }
    })(el);
    return s;
  }

  g.MD = { split, renderBlock, inline, rawText, highlight, slug, esc, escAttr, meta, bmeta, RE, isBlank };
})(window);
