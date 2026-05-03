/* --------------------------------------------------------------
 * mini — renderer. Pure vanilla JS. Zero runtime deps.
 * -------------------------------------------------------------- */

const $  = (id) => document.getElementById(id);
const app    = document.querySelector('.app');
const source = $('source');
const sourceHL = $('source-hl');
const editor = $('editor');
const dirtyDot = $('dirty-dot');
const docTitle = $('doc-title');
const lineInfo = $('line-info');
const progressBar = $('progress-bar');

const state = {
  filePath: null,
  mode: 'source',     // 'source' | 'editor'
  dirty: false,
  baseline: '',       // last saved/loaded content
};

/* ============================================================
 * Undo / Redo — custom snapshot stack, covers both native typing
 * and custom commands (header cycle, code toggle, table ops, …).
 * ============================================================ */

const UNDO_MAX = 200;
const UNDO_GROUP_MS = 500;
const undoStack = [];
const redoStack = [];
let lastUndoKind = null;
let lastUndoTime = 0;

function getEditorCaretOffset() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return 0;
  const r = document.createRange();
  r.selectNodeContents(editor);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length;
}

function setEditorCaretByOffset(offset) {
  const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let chars = 0, target = null, off = 0, n;
  while ((n = w.nextNode())) {
    const len = n.length;
    if (offset <= chars + len) { target = n; off = offset - chars; break; }
    chars += len;
  }
  if (!target) { target = editor; off = editor.childNodes.length; }
  const r = document.createRange();
  r.setStart(target, off);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function snapshotState() {
  return {
    mode: state.mode,
    source: source.value,
    sourceStart: source.selectionStart,
    sourceEnd: source.selectionEnd,
    sourceScroll: source.scrollTop,
    editor: editor.innerHTML,
    editorOffset: state.mode === 'editor' ? getEditorCaretOffset() : 0,
    editorScroll: editor.scrollTop,
  };
}

function restoreSnapshot(s) {
  if (s.mode !== state.mode) {
    if (s.mode === 'editor') {
      source.hidden = true; sourceHL.hidden = true; editor.hidden = false;
    } else {
      editor.hidden = true; source.hidden = false; sourceHL.hidden = false;
    }
    state.mode = s.mode;
    app.dataset.mode = s.mode;
  }
  source.value = s.source;
  source.selectionStart = s.sourceStart;
  source.selectionEnd = s.sourceEnd;
  source.scrollTop = s.sourceScroll;
  editor.innerHTML = s.editor;
  editor.scrollTop = s.editorScroll;
  if (state.mode === 'source') {
    highlightSource();
    sourceHL.scrollTop = s.sourceScroll;
  } else {
    ensureTrailingParagraph();
    setEditorCaretByOffset(s.editorOffset);
  }
  updateLineInfo();
  updateProgress();
}

function pushUndo(kind) {
  const now = Date.now();
  if (kind && kind === lastUndoKind && now - lastUndoTime < UNDO_GROUP_MS) {
    lastUndoTime = now;
    return;
  }
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  lastUndoTime = now;
  lastUndoKind = kind || 'change';
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotState());
  restoreSnapshot(undoStack.pop());
  lastUndoKind = null;
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotState());
  restoreSnapshot(redoStack.pop());
  lastUndoKind = null;
}

source.addEventListener('beforeinput', () => pushUndo('source-input'));
editor.addEventListener('beforeinput', () => pushUndo('editor-input'));

window.mini.onAppCmd((cmd) => {
  if (cmd === 'undo') undo();
  if (cmd === 'redo') redo();
});

/* ============================================================
 * User zoom (font size affecting only the panes)
 * ============================================================ */

const ZOOM_KEY = 'mini.userZoom';
let userZoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 1;
applyZoom();

function applyZoom() {
  document.documentElement.style.setProperty('--user-zoom', String(userZoom));
}
function adjustZoom(delta) {
  userZoom = Math.max(0.5, Math.min(3, +(userZoom + delta).toFixed(2)));
  applyZoom();
  try { localStorage.setItem(ZOOM_KEY, String(userZoom)); } catch {}
}

/* ============================================================
 * Theme loading
 * ============================================================ */

(async function loadThemes() {
  try {
    const t = await window.mini.getThemeCSS();
    $('theme-fonts').textContent      = autoFontFaces(t.fonts || []);
    $('theme-source-css').textContent = t.source ? scopeCSS(t.source, '.pane.source') : '';
    $('theme-editor-css').textContent = t.editor ? scopeCSS(t.editor, '.pane.editor') : '';
  } catch (e) {
    console.warn('theme load failed', e);
  }
})();

/* For every font file dropped into theme/, emit a global @font-face.
 * Family name = filename without extension. So `Inter.ttf` becomes
 * usable as `font-family: 'Inter'` from any CSS rule. */
function autoFontFaces(files) {
  const fmt = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
  return files.map((file) => {
    const dot = file.lastIndexOf('.');
    const family = file.slice(0, dot);
    const ext = file.slice(dot + 1).toLowerCase();
    const url = 'theme://' + encodeURIComponent(file);
    return `@font-face {
  font-family: '${family}';
  src: url('${url}') format('${fmt[ext] || 'truetype'}');
  font-display: swap;
}`;
  }).join('\n');
}

/* Naively prefix every top-level selector with a scope so the
 * theme files can use plain selectors like `h1`, `code`, `:root`. */
function scopeCSS(css, scope) {
  // Strip comments so we don't scope inside them.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return css.replace(/(^|\})\s*([^{}@][^{}]*?)\{/g, (m, brace, sel) => {
    const scoped = sel
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        if (s.startsWith(':root')) return scope + s.slice(5);
        if (s.startsWith('html') || s.startsWith('body')) return scope;
        return scope + ' ' + s;
      })
      .join(', ');
    return brace + ' ' + scoped + ' {';
  });
}

/* ============================================================
 * Markdown ⇄ HTML (minimal)
 * ============================================================ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
 * Source pane: token-coloured overlay (synced with textarea)
 * ============================================================ */

function highlightInline(escaped) {
  // Pull inline code spans out first so the emphasis regexes can't see inside them
  const codes = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\x02${codes.length - 1}\x02`;
  });
  // Bold (** or __) — wrap whole match incl. markers
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<span class="hl-em">**$1**</span>');
  s = s.replace(/__([^_\n]+)__/g,     '<span class="hl-em">__$1__</span>');
  // Italic (* or _ standalone)
  s = s.replace(/\*([^*\n]+)\*/g, '<span class="hl-em">*$1*</span>');
  s = s.replace(/(^|[^a-zA-Z0-9])_([^_\n]+)_(?=[^a-zA-Z0-9]|$)/g, '$1<span class="hl-em">_$2_</span>');
  // Underline <u>…</u> — already escaped to &lt;u&gt;…&lt;/u&gt;
  s = s.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<span class="hl-em">&lt;u&gt;$1&lt;/u&gt;</span>');
  // Re-inject code spans, marker only
  s = s.replace(/\x02(\d+)\x02/g, (_, i) =>
    `<span class="hl-c">\`</span>${codes[+i]}<span class="hl-c">\`</span>`);
  return s;
}

function highlightSource() {
  const lines = source.value.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return `<span class="hl-c">${escapeHtml(line)}</span>`;
    }
    if (inFence) return escapeHtml(line);

    // Header — colour the entire line
    if (/^#{1,6}(\s|$)/.test(line)) {
      return `<span class="hl-h">${escapeHtml(line)}</span>`;
    }
    // Blockquote marker
    let m = line.match(/^(>\s?)(.*)$/);
    if (m) {
      return `<span class="hl-q">${escapeHtml(m[1])}</span>${highlightInline(escapeHtml(m[2]))}`;
    }
    // Bullet list marker
    m = line.match(/^(\s*)([-*]\s)(.*)$/);
    if (m) {
      return `${escapeHtml(m[1])}<span class="hl-l">${escapeHtml(m[2])}</span>${highlightInline(escapeHtml(m[3]))}`;
    }
    // Numbered list marker
    m = line.match(/^(\s*)(\d+\.\s)(.*)$/);
    if (m) {
      return `${escapeHtml(m[1])}<span class="hl-l">${escapeHtml(m[2])}</span>${highlightInline(escapeHtml(m[3]))}`;
    }
    return highlightInline(escapeHtml(line));
  });
  const html = out.join('\n');
  // trailing space → keeps the empty last line at full line-height,
  // so the textarea's caret on a blank tail line lines up with the overlay
  sourceHL.innerHTML = html + '\n ';
}

function inlineMd(text) {
  // Protect code spans and raw <u>…</u> spans before HTML-escaping
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\x01C${codes.length - 1}\x01`;
  });
  const us = [];
  text = text.replace(/<u>([\s\S]*?)<\/u>/g, (_, c) => {
    us.push(c);
    return `\x01U${us.length - 1}\x01`;
  });
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/(^|[^a-zA-Z0-9])_([^_\n]+)_(?=[^a-zA-Z0-9]|$)/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\x01C(\d+)\x01/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  text = text.replace(/\x01U(\d+)\x01/g, (_, i) => `<u>${escapeHtml(us[+i])}</u>`);
  return text;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Header
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    // Table — header row + separator row + zero or more body rows
    if (/^\s*\|.*\|\s*$/.test(line)
        && i + 1 < lines.length
        && /^\s*\|[\s\-|:]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        body.push(parseRow(lines[i]));
        i++;
      }
      let html = '<table><thead><tr>';
      for (const c of header) html += `<th>${inlineMd(c)}</th>`;
      html += '</tr></thead>';
      if (body.length) {
        html += '<tbody>';
        for (const r of body) {
          html += '<tr>';
          for (const c of r) html += `<td>${inlineMd(c)}</td>`;
          html += '</tr>';
        }
        html += '</tbody>';
      }
      html += '</table>';
      out.push(html);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inlineMd(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    // UL
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // OL
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Blank
    if (line.trim() === '') { i++; continue; }

    // Paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(#{1,6}\s|>|[-*]\s|\d+\.\s|```)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMd(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

function htmlToMd(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return walk(tmp).replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '') + '\n';

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    // Skip injected decorations (e.g. floating Copy buttons inside <pre>).
    if (node.classList && node.classList.contains('code-copy')) return '';
    const tag = node.tagName.toLowerCase();
    const inner = Array.from(node.childNodes).map(walk).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3':
      case 'h4': case 'h5': case 'h6':
        return '\n' + '#'.repeat(+tag[1]) + ' ' + inner.trim() + '\n\n';
      case 'strong': case 'b': return '**' + inner + '**';
      case 'em': case 'i':     return '*'  + inner + '*';
      case 'u':                return '<u>' + inner + '</u>';
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        const cells = rows.map((row) => Array.from(row.children).map((c) =>
          c.textContent.replace(/[\n|]/g, ' ').trim()));
        const cols = Math.max(...cells.map((r) => r.length));
        for (const r of cells) while (r.length < cols) r.push('');
        const head = cells[0];
        const body = cells.slice(1);
        let md = '\n| ' + head.join(' | ') + ' |\n';
        md += '|' + new Array(cols).fill('---').join('|') + '|\n';
        for (const r of body) md += '| ' + r.join(' | ') + ' |\n';
        return md + '\n';
      }
      case 'thead': case 'tbody': case 'tr':
      case 'th': case 'td':
        // Handled atomically by 'table' above; if encountered standalone, skip.
        return '';
      case 'code':
        if (node.parentElement && node.parentElement.tagName === 'PRE') return inner;
        return '`' + inner + '`';
      case 'pre':
        return '\n```\n' + inner.replace(/\n$/, '') + '\n```\n\n';
      case 'blockquote':
        return '\n' + inner.trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
      case 'ul':
        return '\n' + Array.from(node.children)
          .map(li => '- ' + walk(li).trim().replace(/\n/g, '\n  ')).join('\n') + '\n\n';
      case 'ol':
        return '\n' + Array.from(node.children)
          .map((li, k) => `${k + 1}. ` + walk(li).trim().replace(/\n/g, '\n   ')).join('\n') + '\n\n';
      case 'li': return inner;
      case 'a':  return '[' + inner + '](' + (node.getAttribute('href') || '') + ')';
      case 'br': return '\n';
      case 'hr': return '\n---\n\n';
      case 'p':  return '\n' + inner + '\n\n';
      case 'div': return inner + '\n';
      default:    return inner;
    }
  }
}

/* ============================================================
 * View toggling
 * ============================================================ */

function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === 'editor') {
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
    source.hidden = true;
    sourceHL.hidden = true;
    editor.hidden = false;
    state.mode = 'editor';
    app.dataset.mode = 'editor';
    requestAnimationFrame(() => editor.focus());
  } else {
    source.value = htmlToMd(editor.innerHTML);
    editor.hidden = true;
    source.hidden = false;
    sourceHL.hidden = false;
    highlightSource();
    state.mode = 'source';
    app.dataset.mode = 'source';
    requestAnimationFrame(() => source.focus());
    updateMeta();
  }
  updateProgress();
  updateLineInfo();
}

/* ============================================================
 * Source-mode commands (textarea text manipulation)
 * ============================================================ */

function getSel() {
  return { start: source.selectionStart, end: source.selectionEnd, value: source.value };
}

function setRange(value, selStart, selEnd) {
  source.value = value;
  source.selectionStart = selStart;
  source.selectionEnd = selEnd;
  source.dispatchEvent(new Event('input'));
}

function toggleWrap(open, close = open) {
  const { start, end, value } = getSel();
  const sel = value.slice(start, end);

  // Already wrapped immediately outside the selection?
  const before = value.slice(Math.max(0, start - open.length), start);
  const after  = value.slice(end, end + close.length);
  if (before === open && after === close) {
    setRange(
      value.slice(0, start - open.length) + sel + value.slice(end + close.length),
      start - open.length,
      end - open.length
    );
    return;
  }

  // Selection itself is wrapped?
  if (sel.length >= open.length + close.length &&
      sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length);
    setRange(value.slice(0, start) + inner + value.slice(end), start, start + inner.length);
    return;
  }

  if (sel.length === 0) {
    const v = value.slice(0, start) + open + close + value.slice(end);
    setRange(v, start + open.length, start + open.length);
  } else {
    const v = value.slice(0, start) + open + sel + close + value.slice(end);
    setRange(v, start + open.length, start + open.length + sel.length);
  }
}

function lineBoundsAt(value, pos) {
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  let end = value.indexOf('\n', pos);
  if (end === -1) end = value.length;
  return { start, end };
}

function selectedLineRange() {
  const { start, end, value } = getSel();
  const a = lineBoundsAt(value, start).start;
  const b = lineBoundsAt(value, end > start ? end - (value[end - 1] === '\n' ? 1 : 0) : end).end;
  return { a, b, value };
}

function rewriteLines(transform) {
  const { a, b, value } = selectedLineRange();
  const block = value.slice(a, b);
  const lines = block.split('\n');
  const out = transform(lines);
  const next = out.join('\n');
  const newValue = value.slice(0, a) + next + value.slice(b);
  setRange(newValue, a, a + next.length);
}

/* ⌘H — clean level cycle. Always strips any "1.2." section number
 * that the line might have, since ⌘H is the "no numbers" path. */
function cycleHeader() {
  const stripNum = (s) => s.replace(/^(\d+(?:\.\d+)*)\.\s+/, '');
  rewriteLines((lines) => lines.map((line) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) return '# ' + line.replace(/^\s+/, '');
    if (m[1].length >= 6) return stripNum(m[2]);
    return '#'.repeat(m[1].length + 1) + ' ' + stripNum(m[2]);
  }));
}

/* Walk all headers in the source. For any that already start with a
 * dotted section number (e.g. "## 2.1. Title"), rewrite the number to
 * match the header's hierarchical position. Headers without a numeric
 * prefix are left alone — numbering is opt-in per header. */
function renumberHeaders() {
  const lines = source.value.split('\n');
  const counters = [0, 0, 0, 0, 0, 0];
  let changed = false;
  let inFence = false;
  let delta = 0;                                   // chars added/removed before cursor
  const cursor = source.selectionStart;
  let pos = 0;
  const out = lines.map((line, idx) => {
    const lineStart = pos;
    pos += line.length + (idx < lines.length - 1 ? 1 : 0); // +1 for \n
    if (/^```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (!h) return line;
    const num = h[2].match(/^(\d+(?:\.\d+)*)\.\s+(.*)$/);
    if (!num) return line;
    const lvl = h[1].length;
    counters[lvl - 1]++;
    for (let i = lvl; i < 6; i++) counters[i] = 0;
    const expected = counters.slice(0, lvl).join('.');
    if (num[1] === expected) return line;
    const newLine = h[1] + ' ' + expected + '. ' + num[2];
    if (lineStart < cursor) delta += newLine.length - line.length;
    changed = true;
    return newLine;
  });
  if (!changed) return;
  setRange(out.join('\n'), source.selectionStart + delta, source.selectionEnd + delta);
}

/* ⌘⇧H — cycle the current line's header level WITH a section number
 * computed for its new hierarchical position.
 *   plain        → "# 1. text"
 *   "# x"        → "## 1.1. text"
 *   "## x"       → "### 1.1.1. text"
 *   ... up to ###### → wraps to plain (drops both # and number)
 * Existing number prefixes are stripped and replaced with the new one. */
function cycleHeaderWithNumber() {
  const { start, value } = getSel();
  const { start: ls, end: le } = lineBoundsAt(value, start);
  const line = value.slice(ls, le);
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  let newLine;
  if (!m) {
    const content = line.replace(/^\s+/, '');
    const num = computeHeaderNumber(value, ls, 1);
    newLine = '# ' + num + '. ' + content;
  } else if (m[1].length >= 6) {
    newLine = m[2].replace(/^(\d+(?:\.\d+)*)\.\s+/, '');
  } else {
    const newLvl = m[1].length + 1;
    const content = m[2].replace(/^(\d+(?:\.\d+)*)\.\s+/, '');
    const num = computeHeaderNumber(value, ls, newLvl);
    newLine = '#'.repeat(newLvl) + ' ' + num + '. ' + content;
  }
  const c = ls + newLine.length;
  setRange(value.slice(0, ls) + newLine + value.slice(le), c, c);
}

/* Compute the section number this header should have. Honours any
 * manual reset the user has applied: instead of counting blindly, we
 * track the *last seen* number string per level. New headers continue
 * from there:
 *   – same level → increment the last seen number's last segment.
 *   – deeper level → use closest parent's number + ".1".
 *   – no context → default to "1.1.…" with `level` segments. */
function computeHeaderNumber(value, lineStart, level) {
  const lastNum = [null, null, null, null, null, null];
  const before = value.slice(0, lineStart).split('\n');
  let inFence = false;
  for (const l of before) {
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    const num = h[2].match(/^(\d+(?:\.\d+)*)\.\s+/);
    if (!num) continue;
    const lv = h[1].length;
    lastNum[lv - 1] = num[1];
    for (let i = lv; i < 6; i++) lastNum[i] = null;  // children of the new sibling reset
  }
  // Same-level continuation
  if (lastNum[level - 1]) {
    const segs = lastNum[level - 1].split('.').map(Number);
    segs[segs.length - 1]++;
    return segs.join('.');
  }
  // Closest numbered ancestor + ".1"
  for (let p = level - 2; p >= 0; p--) {
    if (lastNum[p]) return lastNum[p] + '.1';
  }
  // No context at all → default of <level> ones, e.g. "1.1.1"
  return new Array(level).fill('1').join('.');
}

function toggleQuote() {
  rewriteLines((lines) => {
    // If every non-empty line is already quoted → unquote (escape).
    const allQuoted = lines.every((l) => /^>\s?/.test(l) || l.trim() === '');
    if (allQuoted) return lines.map((l) => l.replace(/^>\s?/, ''));
    // Otherwise quote — but never nest: leave already-quoted lines alone.
    return lines.map((l) => {
      if (l.trim() === '') return l;
      if (/^>\s?/.test(l)) return l;
      return '> ' + l;
    });
  });
}

function toggleUL() {
  rewriteLines((lines) => {
    const all = lines.every(l => /^[-*]\s+/.test(l) || l.trim() === '');
    return all
      ? lines.map(l => l.replace(/^[-*]\s+/, ''))
      : lines.map(l => l.trim() === '' ? l : '- ' + l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  });
}

function toggleOL() {
  rewriteLines((lines) => {
    const all = lines.every(l => /^\d+\.\s+/.test(l) || l.trim() === '');
    if (all) return lines.map(l => l.replace(/^\d+\.\s+/, ''));
    let n = 0;
    return lines.map(l => {
      if (l.trim() === '') return l;
      n++;
      return n + '. ' + l.replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '');
    });
  });
}

/* Walk the whole text, pair up ``` lines, and return the fence that
 * contains [start, end] — wherever inside the block the cursor is. */
function findEnclosingFence(value, start, end) {
  const fenceLines = [];
  let pos = 0;
  while (pos <= value.length) {
    const nl = value.indexOf('\n', pos);
    const lineEnd = nl === -1 ? value.length : nl;
    if (/^```/.test(value.slice(pos, lineEnd))) {
      fenceLines.push({ start: pos, end: lineEnd });
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  for (let i = 0; i + 1 < fenceLines.length; i += 2) {
    const o = fenceLines[i], c = fenceLines[i + 1];
    if (start >= o.end + 1 && end <= c.start) {
      return { openStart: o.start, openEnd: o.end,
               closeStart: c.start, closeEnd: c.end };
    }
  }
  return null;
}

/* Find the inline `…` pair on the current line that contains [start, end].
 * Permissive: cursor or selection anywhere inside the pair (or coincident
 * with its boundaries) counts as "inside". */
function findEnclosingInline(value, start, end) {
  if (value.slice(start, end).includes('\n')) return null;
  const sLine = lineBoundsAt(value, start);
  if (sLine.end < end) return null;
  const lineText = value.slice(sLine.start, sLine.end);
  const sIn = start - sLine.start;
  const eIn = end - sLine.start;
  let open = -1;
  const pairs = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '`') {
      if (open < 0) open = i;
      else { pairs.push({ open, close: i }); open = -1; }
    }
  }
  for (const p of pairs) {
    if (sIn >= p.open && eIn <= p.close + 1) {
      return { openAbs: sLine.start + p.open, closeAbs: sLine.start + p.close };
    }
  }
  return null;
}

/* Three-state cycle on every ⌘F press:
 *   plain  →  inline `code`  →  fenced ```block```  →  plain
 * Multi-line plain selections jump straight to fenced.
 * Empty cursor over plain text inserts an empty `…` to start typing. */
function toggleCode() {
  const { start, end, value } = getSel();
  const text = value.slice(start, end);

  // 1) Inside a fenced block → unwrap to plain.
  const fence = findEnclosingFence(value, start, end);
  if (fence) {
    const removedBefore = (fence.openEnd - fence.openStart) + 1;
    const newValue = value.slice(0, fence.openStart)
                   + value.slice(fence.openEnd + 1, fence.closeStart - 1)
                   + value.slice(fence.closeEnd);
    setRange(newValue, start - removedBefore, end - removedBefore);
    return;
  }

  // 2) Inside an inline `…` → upgrade to fenced block.
  //    If the inline lives mid-line, break the line so the fence
  //    can sit on its own lines (valid markdown).
  const inline = findEnclosingInline(value, start, end);
  if (inline) {
    const inner = value.slice(inline.openAbs + 1, inline.closeAbs);
    const lineStart = value.lastIndexOf('\n', inline.openAbs - 1) + 1;
    const lineEndIdx = value.indexOf('\n', inline.closeAbs);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const before  = value.slice(lineStart, inline.openAbs).replace(/\s+$/, '');
    const after   = value.slice(inline.closeAbs + 1, lineEnd).replace(/^\s+/, '');
    let replacement = '```\n' + inner + '\n```';
    if (before) replacement = before + '\n' + replacement;
    if (after)  replacement = replacement + '\n' + after;
    const newValue = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
    const fenceOpenAt = lineStart + (before ? before.length + 1 : 0);
    const innerStart = fenceOpenAt + 4; // after "```\n"
    setRange(newValue, innerStart, innerStart + inner.length);
    return;
  }

  // 3) Not in code yet → wrap.
  if (text.includes('\n')) {
    const trimmed = text.replace(/^\n+|\n+$/g, '');
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const needLeadNl  = start > lineStart;
    const needTrailNl = end < value.length && value[end] !== '\n';
    const wrapped = (needLeadNl ? '\n' : '') + '```\n' + trimmed + '\n```' + (needTrailNl ? '\n' : '');
    const newValue = value.slice(0, start) + wrapped + value.slice(end);
    const innerOffset = (needLeadNl ? 1 : 0) + 4;
    setRange(newValue, start + innerOffset, start + innerOffset + trimmed.length);
    return;
  }
  if (text.length === 0) {
    setRange(value.slice(0, start) + '``' + value.slice(end), start + 1, start + 1);
    return;
  }
  const newValue = value.slice(0, start) + '`' + text + '`' + value.slice(end);
  setRange(newValue, start + 1, end + 1);
}

/* ============================================================
 * Editor-mode commands (preview pane, contentEditable)
 * uses execCommand where it still works reliably enough.
 * ============================================================ */

function execEditor(action) {
  editor.focus();
  // Operations done directly on the DOM (visual, no source roundtrip).
  if (action === 'header')       return cycleHeaderInEditor();
  if (action === 'numberHeader') return cycleHeaderWithNumberInEditor();
  if (action === 'code')         return toggleCodeInEditor();
  if (action === 'quote')        return toggleQuoteInEditor();
  switch (action) {
    case 'bold':      document.execCommand('bold');   break;
    case 'italic':    document.execCommand('italic'); break;
    case 'underline': document.execCommand('underline'); break;
    case 'ul':        document.execCommand('insertUnorderedList'); break;
    case 'ol':        document.execCommand('insertOrderedList');   break;
  }
  syncFromEditor();
}

/* ⌘R in editor: toggle blockquote on the current block. execCommand
 * 'formatBlock' wraps but never unwraps, so we do it by hand. */
function toggleQuoteInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;

  let bq = sel.anchorNode;
  while (bq && bq !== editor) {
    if (bq.nodeType === 1 && bq.tagName === 'BLOCKQUOTE') break;
    bq = bq.parentNode;
  }
  if (bq && bq !== editor && bq.tagName === 'BLOCKQUOTE') {
    // Unwrap — promote children up.
    const frag = document.createDocumentFragment();
    while (bq.firstChild) frag.appendChild(bq.firstChild);
    bq.replaceWith(frag);
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  // Wrap the current block in a blockquote.
  let block = sel.anchorNode;
  while (block && block !== editor && block.nodeType !== 1) block = block.parentNode;
  while (block && block !== editor && !BLOCK_TAGS.test(block.tagName)) block = block.parentNode;
  if (!block || block === editor) return;
  const newBq = document.createElement('blockquote');
  block.parentNode.insertBefore(newBq, block);
  newBq.appendChild(block);
  ensureTrailingParagraph();
  syncFromEditor();
}

/* ============================================================
 * Editor-mode visual operations (DOM only — no source roundtrip).
 * They preserve the cursor by computing its offset within the
 * affected block, mutating the DOM, and re-placing the caret at
 * the equivalent offset in the new structure.
 * ============================================================ */

const BLOCK_TAGS = /^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/;
const HEADER_CYCLE = { P: 'h1', DIV: 'h1', LI: 'h1', BLOCKQUOTE: 'h1',
                       H1: 'h2', H2: 'h3', H3: 'h4', H4: 'h5', H5: 'h6', H6: 'p' };

function findEditorBlock(node) {
  while (node && node !== editor) {
    if (node.nodeType === 1 && BLOCK_TAGS.test(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}

function blockCharOffset(block, container, off) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(container, off);
  return r.toString().length;
}

function placeCaretInBlock(block, offset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let chars = 0, n, target = null, targetOff = 0;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (offset <= chars + len) { target = n; targetOff = offset - chars; break; }
    chars += len;
  }
  if (!target) {
    // Empty block — place at the block itself
    target = block;
    targetOff = block.childNodes.length;
  }
  const r = document.createRange();
  r.setStart(target, targetOff);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function changeBlockTag(block, newTagLower) {
  const nb = document.createElement(newTagLower);
  while (block.firstChild) nb.appendChild(block.firstChild);
  block.replaceWith(nb);
  return nb;
}

function stripLeadingNumberFromBlock(block) {
  const m = block.textContent.match(/^(\d+(?:\.\d+)*)\.\s+/);
  if (!m) return 0;
  let toRemove = m[0].length;
  const removed = toRemove;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n;
  while (toRemove > 0 && (n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (len <= toRemove) {
      toRemove -= len;
      n.nodeValue = '';
    } else {
      n.nodeValue = n.nodeValue.slice(toRemove);
      toRemove = 0;
    }
  }
  return removed;
}

function prependPlainTextToBlock(block, txt) {
  // Insert txt as the first text node of block. Returns # chars added.
  block.insertBefore(document.createTextNode(txt), block.firstChild);
  return txt.length;
}

function computeHeaderNumberFromBlocks(targetBlock, level) {
  const lastNum = [null, null, null, null, null, null];
  // Walk all element children of editor in document order.
  const all = editor.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of all) {
    if (h === targetBlock) break;
    const m = h.textContent.match(/^(\d+(?:\.\d+)*)\.\s+/);
    if (!m) continue;
    const lv = parseInt(h.tagName[1]);
    lastNum[lv - 1] = m[1];
    for (let i = lv; i < 6; i++) lastNum[i] = null;
  }
  if (lastNum[level - 1]) {
    const segs = lastNum[level - 1].split('.').map(Number);
    segs[segs.length - 1]++;
    return segs.join('.');
  }
  for (let p = level - 2; p >= 0; p--) {
    if (lastNum[p]) return lastNum[p] + '.1';
  }
  return new Array(level).fill('1').join('.');
}

function cycleHeaderInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const block = findEditorBlock(range.startContainer);
  if (!block) return;
  const offset = blockCharOffset(block, range.startContainer, range.startOffset);

  const newTag = HEADER_CYCLE[block.tagName] || 'h1';
  const nb = changeBlockTag(block, newTag);
  const removed = stripLeadingNumberFromBlock(nb);
  const newOffset = Math.max(0, offset - removed);
  placeCaretInBlock(nb, newOffset);
  ensureTrailingParagraph();
  syncFromEditor();
}

function cycleHeaderWithNumberInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const block = findEditorBlock(range.startContainer);
  if (!block) return;
  const offset = blockCharOffset(block, range.startContainer, range.startOffset);

  const newTag = HEADER_CYCLE[block.tagName] || 'h1';
  const nb = changeBlockTag(block, newTag);
  const removed = stripLeadingNumberFromBlock(nb);
  let added = 0;
  if (newTag !== 'p') {
    const lvl = parseInt(newTag[1]);
    const num = computeHeaderNumberFromBlocks(nb, lvl);
    added = prependPlainTextToBlock(nb, num + '. ');
  }
  // Adjust caret: subtract old number length, add new number length
  const newOffset = Math.max(0, offset - removed) + added;
  placeCaretInBlock(nb, newOffset);
  ensureTrailingParagraph();
  syncFromEditor();
}

/* ---------- table operations (editor mode) ---------- */

function findCell(node) {
  while (node && node !== editor) {
    if (node.nodeType === 1 && (node.tagName === 'TD' || node.tagName === 'TH')) return node;
    node = node.parentNode;
  }
  return null;
}
function findTable(node) {
  while (node && node !== editor) {
    if (node.nodeType === 1 && node.tagName === 'TABLE') return node;
    node = node.parentNode;
  }
  return null;
}
function newCell(tag) {
  const c = document.createElement(tag);
  c.appendChild(document.createElement('br'));
  return c;
}
function buildTable(cols) {
  const t = document.createElement('table');
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (let i = 0; i < cols; i++) tr.appendChild(newCell('th'));
  thead.appendChild(tr);
  t.appendChild(thead);
  return t;
}

function tableActionInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const table = findTable(sel.anchorNode);

  if (table) {
    // Already in a table → add a new data row at the end of <tbody>.
    let tbody = table.querySelector('tbody');
    if (!tbody) { tbody = document.createElement('tbody'); table.appendChild(tbody); }
    const cols = (table.querySelector('tr') || { children: [] }).children.length || 1;
    const tr = document.createElement('tr');
    for (let i = 0; i < cols; i++) tr.appendChild(newCell('td'));
    tbody.appendChild(tr);
    const r = document.createRange();
    r.selectNodeContents(tr.firstChild);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  // Not in a table → insert a 1×1 table.
  const t = buildTable(1);
  let block = sel.anchorNode;
  while (block && block !== editor && (block.nodeType !== 1 || !BLOCK_TAGS.test(block.tagName))) {
    block = block.parentNode;
  }
  if (block && block !== editor) block.parentNode.insertBefore(t, block.nextSibling);
  else editor.appendChild(t);
  const r = document.createRange();
  r.selectNodeContents(t.querySelector('th'));
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  ensureTrailingParagraph();
  syncFromEditor();
}

function deleteTableRowInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const cell = findCell(sel.anchorNode);
  if (!cell) return;
  const tr = cell.parentNode;
  const table = findTable(tr);
  if (!tr || !table) return;
  const allRows = table.querySelectorAll('tr');
  if (allRows.length <= 1) {
    // Last remaining row → remove the whole table.
    table.remove();
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }
  // Place caret in the row that takes its place (next, then prev).
  const target = tr.nextElementSibling || tr.previousElementSibling;
  tr.remove();
  // If the parent <tbody> / <thead> is now empty, remove it too.
  const section = tr.parentNode;
  if (section && section !== table && section.children.length === 0) section.remove();

  if (target && target.firstChild) {
    const r = document.createRange();
    r.selectNodeContents(target.firstChild);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  syncFromEditor();
}

function deleteTableRowInSource() {
  const { start, value } = getSel();
  const range = tableLineRangeInSource(value, start);
  if (!range) return;
  const cur = lineBoundsAt(value, start);
  const block = value.slice(range.start, range.end);
  const lines = block.split('\n');
  // Find current line within block
  const lineIndex = (() => {
    let off = range.start;
    for (let i = 0; i < lines.length; i++) {
      const next = off + lines[i].length + (i < lines.length - 1 ? 1 : 0);
      if (cur.start >= off && cur.start < next + 1) return i;
      off = next;
    }
    return -1;
  })();
  if (lineIndex < 0) return;
  // If only header + separator left, drop the whole table.
  if (lines.length <= 2) {
    setRange(value.slice(0, range.start) + value.slice(range.end), range.start, range.start);
    return;
  }
  // Don't allow deleting the separator (line index 1) — fall back to deleting next data row if any.
  let removeIdx = lineIndex === 1 ? 2 : lineIndex;
  if (removeIdx >= lines.length) removeIdx = lines.length - 1;
  lines.splice(removeIdx, 1);
  const newBlock = lines.join('\n');
  const newValue = value.slice(0, range.start) + newBlock + value.slice(range.end);
  // Place caret at start of the line that took its place
  let caret = range.start;
  for (let i = 0; i < Math.min(removeIdx, lines.length); i++) caret += lines[i].length + 1;
  setRange(newValue, Math.min(caret, newValue.length), Math.min(caret, newValue.length));
}

function addColumnInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const table = findTable(sel.anchorNode);
  if (!table) return;
  for (const tr of table.querySelectorAll('tr')) {
    const isHeader = tr.parentNode.tagName === 'THEAD'
                  || (tr.firstElementChild && tr.firstElementChild.tagName === 'TH');
    tr.appendChild(newCell(isHeader ? 'th' : 'td'));
  }
  syncFromEditor();
}

function removeColumnInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const cell = findCell(sel.anchorNode);
  if (!cell) return;
  const tr = cell.parentNode;
  const colIdx = Array.prototype.indexOf.call(tr.children, cell);
  const table = findTable(tr);
  if (!table) return;
  const headerRow = table.querySelector('tr');
  if (!headerRow || headerRow.children.length <= 1) {
    table.remove();
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }
  for (const row of table.querySelectorAll('tr')) {
    if (row.children[colIdx]) row.removeChild(row.children[colIdx]);
  }
  // Place caret in the cell now occupying that column index (or the last one).
  const newRow = cell.isConnected ? cell.parentNode : tr;
  const target = newRow && newRow.children[Math.min(colIdx, newRow.children.length - 1)];
  if (target) {
    const r = document.createRange();
    r.selectNodeContents(target);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  syncFromEditor();
}

function colIndexInSourceLine(line, posInLine) {
  let n = -1;
  for (let i = 0; i < posInLine && i < line.length; i++) {
    if (line[i] === '|') n++;
  }
  return Math.max(0, n);
}

function addColumnInSource() {
  const { start, value } = getSel();
  const range = tableLineRangeInSource(value, start);
  if (!range) return;
  const block = value.slice(range.start, range.end);
  const lines = block.split('\n');
  const out = lines.map((l) => {
    const isSep = /^\s*\|[\s\-|:]+\|\s*$/.test(l);
    const inner = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    const cells = inner.split('|');
    cells.push(isSep ? '---' : '   ');
    return '|' + cells.join('|') + '|';
  });
  const newBlock = out.join('\n');
  setRange(value.slice(0, range.start) + newBlock + value.slice(range.end), start, start);
}

function removeColumnInSource() {
  const { start, value } = getSel();
  const range = tableLineRangeInSource(value, start);
  if (!range) return;
  const cur = lineBoundsAt(value, start);
  const curLine = value.slice(cur.start, cur.end);
  const colIdx = colIndexInSourceLine(curLine, start - cur.start);
  const block = value.slice(range.start, range.end);
  const lines = block.split('\n');
  const cellCount = (lines[0].match(/\|/g) || []).length - 1;
  if (cellCount <= 1) {
    // Only one column → remove the table entirely.
    setRange(value.slice(0, range.start) + value.slice(range.end + (range.end < value.length ? 1 : 0)),
             range.start, range.start);
    return;
  }
  const out = lines.map((l) => {
    const inner = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    const cells = inner.split('|');
    if (colIdx >= 0 && colIdx < cells.length) cells.splice(colIdx, 1);
    return '|' + cells.join('|') + '|';
  });
  const newBlock = out.join('\n');
  setRange(value.slice(0, range.start) + newBlock + value.slice(range.end), start, start);
}

function setTableColsInEditor(n) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const table = findTable(sel.anchorNode);
  if (!table) return;
  for (const tr of table.querySelectorAll('tr')) {
    const isHeader = tr.parentNode.tagName === 'THEAD'
                  || (tr.firstElementChild && tr.firstElementChild.tagName === 'TH');
    while (tr.children.length < n) tr.appendChild(newCell(isHeader ? 'th' : 'td'));
    while (tr.children.length > n) tr.removeChild(tr.lastChild);
  }
  syncFromEditor();
}

/* ---------- table operations (source mode) ---------- */

function tableLineRangeInSource(value, pos) {
  // Returns the [start, end) line-based range for the table whose
  // current line is at `pos`. Returns null if not on a table line.
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cur = lineBoundsAt(value, pos);
  const curLine = value.slice(cur.start, cur.end);
  if (!isTableLine(curLine)) return null;
  let s = cur.start;
  while (s > 0) {
    const prev = lineBoundsAt(value, s - 1);
    const pl = value.slice(prev.start, prev.end);
    if (!isTableLine(pl)) break;
    s = prev.start;
  }
  let e = cur.end;
  while (e < value.length) {
    const nx = lineBoundsAt(value, e + 1);
    const nl = value.slice(nx.start, nx.end);
    if (!isTableLine(nl)) break;
    e = nx.end;
  }
  return { start: s, end: e };
}

function tableActionInSource() {
  const { start, value } = getSel();
  const range = tableLineRangeInSource(value, start);
  if (range) {
    // Add a row at the end of the table block.
    const block = value.slice(range.start, range.end);
    const lines = block.split('\n');
    const cols = (lines[0].match(/\|/g) || []).length - 1;
    const newRow = '|' + ' | '.repeat(Math.max(cols, 1)).replace(/^ \| /, ' ') + '|';
    // Simpler: build "| | | |" pattern with cols cells
    const cells = new Array(Math.max(cols, 1)).fill('   ');
    const builtRow = '| ' + cells.join(' | ') + ' |';
    const insertAt = range.end;
    const newValue = value.slice(0, insertAt) + '\n' + builtRow + value.slice(insertAt);
    const caret = insertAt + 3; // inside first cell of new row (after "| ")
    setRange(newValue, caret, caret);
    return;
  }
  // Not in a table → insert a 1-col / 1-row table at line start.
  const ls = lineBoundsAt(value, start).start;
  const tableMd = '|   |\n|---|\n';
  const newValue = value.slice(0, ls) + tableMd + value.slice(ls);
  // Place caret inside the first header cell ("|   |" — pos = ls + 2)
  setRange(newValue, ls + 2, ls + 2);
}

function setTableColsInSource(n) {
  const { start, value } = getSel();
  const range = tableLineRangeInSource(value, start);
  if (!range) return;
  const block = value.slice(range.start, range.end);
  const lines = block.split('\n');
  const reshape = (line) => {
    const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    const cells = inner.split('|');
    while (cells.length < n) cells.push('   ');
    while (cells.length > n) cells.pop();
    return '| ' + cells.map((c) => c.replace(/^\s+|\s+$/g, '') || '  ').join(' | ') + ' |';
  };
  const reshapeSep = () => '|' + new Array(n).fill('---').join('|') + '|';
  const out = lines.map((l, i) => i === 1 && /^\s*\|[\s\-|:]+\|\s*$/.test(l) ? reshapeSep() : reshape(l));
  const newValue = value.slice(0, range.start) + out.join('\n') + value.slice(range.end);
  setRange(newValue, range.start, range.start + out.join('\n').length);
}

function toggleHrInSource() {
  const { start, value } = getSel();
  const { start: ls, end: le } = lineBoundsAt(value, start);
  const line = value.slice(ls, le);
  if (/^-{3,}\s*$/.test(line)) {
    // Remove the --- line
    const tail = le < value.length ? le + 1 : le;
    setRange(value.slice(0, ls) + value.slice(tail), ls, ls);
    return;
  }
  if (line.trim() === '') {
    // Empty line → make it ---
    setRange(value.slice(0, ls) + '---' + value.slice(le), ls + 3, ls + 3);
    return;
  }
  // Otherwise → add a fresh --- line right after the current one.
  setRange(value.slice(0, le) + '\n---' + value.slice(le), le + 4, le + 4);
}

function toggleHrInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  let n = sel.anchorNode;
  while (n && n !== editor && n.nodeType !== 1) n = n.parentNode;
  // Walk up to either an HR or a block.
  let block = n;
  while (block && block !== editor
        && block.tagName !== 'HR'
        && !BLOCK_TAGS.test(block.tagName)) block = block.parentNode;
  if (!block || block === editor) return;

  if (block.tagName === 'HR') {
    const target = block.nextElementSibling || block.previousElementSibling;
    block.remove();
    if (target) {
      const r = document.createRange();
      r.selectNodeContents(target);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  const hr = document.createElement('hr');
  // If current block is empty (e.g. the trailing safety <p>), replace it
  // with the HR rather than inserting after — avoids leaving a phantom
  // empty line above the separator.
  const blockEmpty = !block.textContent.replace(/​/g, '').trim();
  if (blockEmpty) {
    block.replaceWith(hr);
  } else {
    block.parentNode.insertBefore(hr, block.nextSibling);
  }
  // Drop a paragraph after the rule so the user has a target to type in.
  let after = hr.nextElementSibling;
  if (!after || after.tagName === 'HR') {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    hr.parentNode.insertBefore(p, hr.nextSibling);
    after = p;
  }
  const r = document.createRange();
  r.selectNodeContents(after);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  ensureTrailingParagraph();
  syncFromEditor();
}

function toggleCodeInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const selectedText = range.collapsed ? '' : range.toString();
  // Multi-line if the selected text has \n OR if the selection's start
  // and end live in different block elements (range.toString() doesn't
  // always insert \n at block boundaries in Chromium).
  const startBlock = findEditorBlock(range.startContainer);
  const endBlock   = findEditorBlock(range.endContainer);
  const crossesBlocks = startBlock && endBlock && startBlock !== endBlock;
  const isMultiLine  = !range.collapsed && (selectedText.includes('\n') || crossesBlocks);

  // Walk up to detect current state.
  let pre = null, code = null;
  for (let n = range.startContainer; n && n !== editor; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    if (!pre  && n.tagName === 'PRE')  pre  = n;
    if (!code && n.tagName === 'CODE') code = n;
  }

  // 1) BLOCK → NONE: unwrap <pre>, each \n becomes its own <p>.
  if (pre) {
    // Strip zero-width spaces — they're caret stand-ins, never user content.
    const text = pre.textContent.replace(/​/g, '');
    if (text.trim() === '') {
      // Empty fence → remove without leaving a phantom paragraph behind.
      const prev = pre.previousElementSibling;
      const next = pre.nextElementSibling;
      pre.remove();
      const target = prev || next;
      if (target) {
        const r = document.createRange();
        r.selectNodeContents(target);
        r.collapse(target === prev);   // end of prev / start of next
        sel.removeAllRanges();
        sel.addRange(r);
      }
      ensureTrailingParagraph();
      syncFromEditor();
      return;
    }
    const lines = text.split('\n');
    const frag = document.createDocumentFragment();
    let firstP = null;
    for (const line of lines) {
      const p = document.createElement('p');
      if (line === '') p.appendChild(document.createElement('br'));
      else p.appendChild(document.createTextNode(line));
      if (!firstP) firstP = p;
      frag.appendChild(p);
    }
    pre.replaceWith(frag);
    if (firstP) {
      const r = document.createRange();
      r.selectNodeContents(firstP);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  // 2) Multi-line selection (regardless of any inline <code> inside it) →
  //    skip the inline state entirely, jump straight to a fenced block.
  if (isMultiLine) {
    // Build the inner text. When the selection crosses block boundaries,
    // join each block's textContent with \n so we don't lose line breaks.
    let inner = selectedText;
    if (crossesBlocks) {
      const blocks = [];
      for (let cur = startBlock; cur; cur = cur.nextElementSibling) {
        blocks.push(cur);
        if (cur === endBlock) break;
      }
      inner = blocks.map((b) => b.textContent).join('\n');
      // Replace the whole block range cleanly.
      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      newCode.appendChild(document.createTextNode(inner));
      newPre.appendChild(newCode);
      blocks[0].parentNode.insertBefore(newPre, blocks[0]);
      blocks.forEach((b) => b.remove());
      const r = document.createRange();
      r.selectNodeContents(newCode);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      ensureTrailingParagraph();
      syncFromEditor();
      return;
    }
    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    newCode.appendChild(document.createTextNode(inner));
    newPre.appendChild(newCode);
    range.deleteContents();
    range.insertNode(newPre);
    const r = document.createRange();
    r.selectNodeContents(newCode);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  // 3) INLINE → BLOCK: split surrounding block, replace <code> with <pre><code>.
  if (code) {
    const text = code.textContent;
    let parent = code.parentNode;
    while (parent && parent !== editor && !BLOCK_TAGS.test(parent.tagName)) parent = parent.parentNode;
    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    newCode.appendChild(document.createTextNode(text));
    newPre.appendChild(newCode);
    if (!parent || parent === editor) {
      code.replaceWith(newPre);
    } else {
      const tag = parent.tagName.toLowerCase();
      const before = document.createElement(tag);
      const after  = document.createElement(tag);
      let curr = parent.firstChild;
      while (curr && curr !== code) { const nx = curr.nextSibling; before.appendChild(curr); curr = nx; }
      let aft = code.nextSibling;
      while (aft) { const nx = aft.nextSibling; after.appendChild(aft); aft = nx; }
      const frag = document.createDocumentFragment();
      if (before.childNodes.length) frag.appendChild(before);
      frag.appendChild(newPre);
      if (after.childNodes.length)  frag.appendChild(after);
      parent.replaceWith(frag);
    }
    const r = document.createRange();
    r.selectNodeContents(newCode);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    ensureTrailingParagraph();
    syncFromEditor();
    return;
  }

  // 3) NONE → INLINE (or BLOCK if multi-line selection)
  if (range.collapsed) {
    const c = document.createElement('code');
    const zwsp = document.createTextNode('​');
    c.appendChild(zwsp);
    range.insertNode(c);
    const r = document.createRange();
    r.setStart(zwsp, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    const txt = range.toString();
    if (txt.includes('\n')) {
      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      newCode.appendChild(document.createTextNode(txt));
      newPre.appendChild(newCode);
      range.deleteContents();
      range.insertNode(newPre);
      const r = document.createRange();
      r.selectNodeContents(newCode);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      const c = document.createElement('code');
      c.appendChild(range.extractContents());
      range.insertNode(c);
      const r = document.createRange();
      r.selectNodeContents(c);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  ensureTrailingParagraph();
  syncFromEditor();
}

/* Run a source-mode command from editor mode. Cursor preservation:
 * insert a unique sentinel character at the caret in the editor,
 * round-trip through source (the sentinel survives htmlToMd / mdToHtml
 * because it's plain text), find the sentinel afterwards in both the
 * source value (to seed source.selectionStart) and the rendered editor
 * (to place the visible caret). The PUA codepoint U+E000 is reserved
 * and never produced by the parser. */
const CARET_SENTINEL = '';

function runCommandThroughSource(cmd) {
  const scrollTop = editor.scrollTop;
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;

  // 1. Drop the sentinel where the editor caret is.
  const range = sel.getRangeAt(0);
  const senNode = document.createTextNode(CARET_SENTINEL);
  range.insertNode(senNode);

  // 2. Source = markdown of editor (with sentinel embedded).
  let md = htmlToMd(editor.innerHTML);
  const srcCaret = md.indexOf(CARET_SENTINEL);
  if (srcCaret >= 0) md = md.replace(CARET_SENTINEL, '');
  source.value = md;
  source.selectionStart = source.selectionEnd = srcCaret >= 0 ? srcCaret : md.length;
  if (senNode.parentNode) senNode.parentNode.removeChild(senNode);

  // 3. Run the source-mode operation. It updates source.selectionStart
  //    to wherever the new caret should sit.
  switch (cmd) {
    case 'code':         toggleCode(); break;
    case 'header':       cycleHeader(); break;
    case 'numberHeader': cycleHeaderWithNumber(); break;
  }

  // 4. Re-render the editor with the sentinel placed at the new caret,
  //    then strip it from the visible text and put the cursor there.
  const c = source.selectionStart;
  const marked = source.value.slice(0, c) + CARET_SENTINEL + source.value.slice(c);
  editor.innerHTML = mdToHtml(marked);
  ensureTrailingParagraph();

  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let placed = false, n;
  while ((n = walker.nextNode())) {
    const i = n.nodeValue.indexOf(CARET_SENTINEL);
    if (i < 0) continue;
    n.nodeValue = n.nodeValue.slice(0, i) + n.nodeValue.slice(i + CARET_SENTINEL.length);
    const r = document.createRange();
    r.setStart(n, i);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    placed = true;
    break;
  }
  if (!placed) editor.focus();

  editor.scrollTop = scrollTop;
  syncFromEditor();
}

function cycleHeaderInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let node = sel.anchorNode;
  while (node && node.nodeType !== 1) node = node.parentNode;
  while (node && node !== editor && !/^(P|H[1-6]|DIV|LI|BLOCKQUOTE)$/.test(node.tagName)) node = node.parentNode;
  if (!node || node === editor) {
    document.execCommand('formatBlock', false, 'h1');
    return;
  }
  const t = node.tagName;
  const next =
    t === 'H1' ? 'h2' :
    t === 'H2' ? 'h3' :
    t === 'H3' ? 'h4' :
    t === 'H4' ? 'h5' :
    t === 'H5' ? 'h6' :
    t === 'H6' ? 'p'  : 'h1';
  document.execCommand('formatBlock', false, next);
}

function wrapInlineCodeInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) {
    const c = document.createElement('code');
    c.appendChild(document.createTextNode('​'));
    range.insertNode(c);
    range.setStart(c.firstChild, 1);
    range.collapse(true);
  } else {
    // toggle: if entirely inside a <code>, unwrap
    const anchor = range.startContainer.parentNode;
    if (anchor && anchor.tagName === 'CODE' && anchor === range.endContainer.parentNode) {
      const text = anchor.textContent;
      anchor.replaceWith(document.createTextNode(text));
    } else {
      const c = document.createElement('code');
      c.appendChild(range.extractContents());
      range.insertNode(c);
    }
  }
}

/* ============================================================
 * Command dispatch
 * ============================================================ */

function run(cmd) {
  if (cmd === 'view') { setMode(state.mode === 'source' ? 'editor' : 'source'); return; }
  if (cmd === 'open') { openFile(); return; }
  if (cmd === 'save') { saveFile(); return; }
  // Content-modifying commands: snapshot before so they're undoable.
  const ephemeral = new Set(['fontUp', 'fontDown']);
  if (!ephemeral.has(cmd)) pushUndo('cmd:' + cmd);
  if (cmd === 'numberHeader') {
    if (state.mode === 'editor') return execEditor('numberHeader');
    cycleHeaderWithNumber();
    return;
  }
  if (cmd === 'table') {
    if (state.mode === 'editor') return tableActionInEditor();
    return tableActionInSource();
  }
  if (cmd === 'deleteRow') {
    if (state.mode === 'editor') return deleteTableRowInEditor();
    return deleteTableRowInSource();
  }
  if (cmd === 'addCol') {
    if (state.mode === 'editor') return addColumnInEditor();
    return addColumnInSource();
  }
  if (cmd === 'removeCol') {
    if (state.mode === 'editor') return removeColumnInEditor();
    return removeColumnInSource();
  }
  if (cmd === 'hr') {
    if (state.mode === 'editor') return toggleHrInEditor();
    return toggleHrInSource();
  }
  if (cmd === 'fontUp')   { adjustZoom(+0.1); return; }
  if (cmd === 'fontDown') { adjustZoom(-0.1); return; }

  if (state.mode === 'editor') return execEditor(cmd);

  switch (cmd) {
    case 'header':    cycleHeader(); break;
    case 'bold':      toggleWrap('**'); break;
    case 'italic':    toggleWrap('*'); break;
    case 'underline': toggleWrap('<u>', '</u>'); break;
    case 'quote':     toggleQuote(); break;
    case 'code':      toggleCode(); break;
    case 'ul':        toggleUL(); break;
    case 'ol':        toggleOL(); break;
  }
  source.focus();
}

/* ============================================================
 * Files
 * ============================================================ */

async function openFile() {
  const f = await window.mini.openFile();
  if (!f) return;
  state.filePath = f.path;
  source.value = f.content;
  state.baseline = f.content;
  state.dirty = false;
  app.dataset.dirty = 'false';
  docTitle.textContent = f.path.split('/').pop();
  if (state.mode === 'editor') {
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
  } else {
    highlightSource();
  }
  updateMeta();
  updateProgress();
}

/* ============================================================
 * Editor-pane helpers: keep cursor escape routes alive
 * ============================================================ */

const TRAP_BLOCKS = /^(PRE|BLOCKQUOTE|UL|OL|TABLE)$/;

function ensureTrailingParagraph() {
  const last = editor.lastElementChild;
  if (!last || TRAP_BLOCKS.test(last.tagName)) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    editor.appendChild(p);
  }
}

/* Hard guarantee: re-add the trailing paragraph immediately if anything
 * removes it. Triggers on direct childList changes only. */
const trailingObserver = new MutationObserver(() => {
  if (state.mode === 'editor') ensureTrailingParagraph();
});
trailingObserver.observe(editor, { childList: true });

/* Floating "Copy" button on each <pre> in editor mode.
 * Marked contenteditable=false and class="code-copy" — htmlToMd skips it. */
function decorateCodeBlocks() {
  for (const pre of editor.querySelectorAll('pre')) {
    if (pre.querySelector(':scope > .code-copy')) continue;
    const btn = document.createElement('div');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.contentEditable = 'false';
    btn.setAttribute('aria-hidden', 'false');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = (code ? code.textContent : pre.textContent).replace(/​/g, '');
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1200);
      }).catch(() => {});
    });
    pre.appendChild(btn);
  }
}

const codeDecorObserver = new MutationObserver(() => decorateCodeBlocks());
codeDecorObserver.observe(editor, { childList: true, subtree: true });

function inPreOrCode() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  for (let n = sel.anchorNode; n && n !== editor; n = n.parentNode) {
    if (n.nodeType === 1 && (n.tagName === 'PRE' || n.tagName === 'CODE')) {
      // walk up to the <pre> wrapper if it's a code-in-pre
      while (n.parentNode && n.parentNode !== editor && n.parentNode.tagName === 'PRE') n = n.parentNode;
      return n;
    }
  }
  return null;
}

async function saveFile(forceDialog = false) {
  // ensure source is current
  if (state.mode === 'editor') source.value = htmlToMd(editor.innerHTML);
  const result = await window.mini.saveFile({
    path: state.filePath,
    content: source.value,
    forceDialog,
  });
  if (!result) return;
  state.filePath = result;
  state.baseline = source.value;
  state.dirty = false;
  app.dataset.dirty = 'false';
  docTitle.textContent = result.split('/').pop();
}

/* ============================================================
 * Stats & progress
 * ============================================================ */

function activePane() {
  return state.mode === 'source' ? source : editor;
}

function updateMeta() { /* word/char counter removed */ }

/* Current line:column indicator — source mode only. Hidden in editor. */
function updateLineInfo() {
  if (state.mode !== 'source') {
    lineInfo.textContent = '';
    return;
  }
  const pos = source.selectionStart;
  const before = source.value.slice(0, pos);
  const line = before.split('\n').length;
  const col  = pos - (before.lastIndexOf('\n') + 1) + 1;
  lineInfo.textContent = line + ':' + col;
}

['keyup', 'click', 'input', 'mouseup', 'focus'].forEach((ev) => {
  source.addEventListener(ev, updateLineInfo);
});
document.addEventListener('selectionchange', updateLineInfo);

function updateProgress() {
  const p = activePane();
  const max = p.scrollHeight - p.clientHeight;
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, p.scrollTop / max));
  progressBar.style.width = (ratio * 100).toFixed(1) + '%';
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    app.dataset.dirty = 'true';
  }
}

function syncFromEditor() {
  source.value = htmlToMd(editor.innerHTML);
  markDirty();
  updateMeta();
}

/* ============================================================
 * Wiring
 * ============================================================ */

/* Toolbar:
 *  - Items are span.tool-btn (no native button semantics).
 *  - Container .tools scrolls horizontally when overflowing.
 *  - Drag (mousedown + move) on the container scrolls horizontally.
 *  - A click that didn't move > 4px still fires the command. */
const toolsEl = document.querySelector('.tools');
let drag = null;

toolsEl.addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, scroll: toolsEl.scrollLeft, moved: 0 };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 2) toolsEl.classList.add('dragging');
  drag.moved = Math.max(drag.moved, Math.abs(dx));
  toolsEl.scrollLeft = drag.scroll - dx;
});
window.addEventListener('mouseup', () => {
  if (drag) toolsEl.classList.remove('dragging');
  drag = null;
});

/* Convert vertical wheel into horizontal scroll for usability. */
toolsEl.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  e.preventDefault();
  toolsEl.scrollLeft += e.deltaY;
}, { passive: false });

/* Tool labels are display-only — interactivity disabled by CSS. */

source.addEventListener('input', () => {
  highlightSource();
  markDirty(); updateMeta(); updateProgress();
});

/* Tab in source — three behaviours:
 *   1. Multi-line selection      → indent / outdent every covered line.
 *   2. Caret at line start (no sel) → indent / outdent that line.
 *   3. Caret mid-line / single-line selection → insert "  " at cursor
 *      (Tab) or no-op (Shift+Tab). Standard text-editor behaviour. */
source.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const start = source.selectionStart;
  const end   = source.selectionEnd;
  const value = source.value;

  const startLineStart = value.lastIndexOf('\n', start - 1) + 1;
  const endForBounds   = (end > start && value[end - 1] === '\n') ? end - 1 : end;
  const endLineStart   = value.lastIndexOf('\n', endForBounds - 1) + 1;
  const isMultiLine    = startLineStart !== endLineStart;

  // 1) Multi-line selection — indent / outdent every covered line.
  if (isMultiLine) {
    const a = startLineStart;
    let b = value.indexOf('\n', endForBounds);
    if (b === -1) b = value.length;
    const lines = value.slice(a, b).split('\n');
    let firstDelta = 0, totalDelta = 0;
    const out = lines.map((l, i) => {
      let nl, d;
      if (e.shiftKey) {
        if (l.startsWith('\t'))      { nl = l.slice(1); d = -1; }
        else if (l.startsWith('  ')) { nl = l.slice(2); d = -2; }
        else if (l.startsWith(' '))  { nl = l.slice(1); d = -1; }
        else                         { nl = l;          d = 0; }
      } else {
        nl = '  ' + l;
        d = 2;
      }
      if (i === 0) firstDelta = d;
      totalDelta += d;
      return nl;
    });
    const newBlock = out.join('\n');
    setRange(value.slice(0, a) + newBlock + value.slice(b),
             start + firstDelta, end + totalDelta);
    return;
  }

  // 2) Caret at start of line, no selection — indent/outdent the line.
  if (start === end && start === startLineStart) {
    const line = value.slice(startLineStart);
    if (e.shiftKey) {
      const m = line.match(/^( {1,2}|\t)/);
      if (m) {
        const r = m[0].length;
        setRange(value.slice(0, startLineStart) + line.slice(r), start, end);
      }
    } else {
      setRange(value.slice(0, startLineStart) + '  ' + line, start + 2, end + 2);
    }
    return;
  }

  // 3) Mid-line / single-line selection — standard insert / no-op.
  if (e.shiftKey) {
    return;        // do nothing
  }
  setRange(value.slice(0, start) + '  ' + value.slice(end), start + 2, start + 2);
});

/* Enter in source: continue the previous line's marker (>, -, *, 1.).
 * Empty marker line (e.g. "- " with nothing after) escapes the list.
 * Inside a fenced ``` block we don't intervene — Enter just adds \n. */
source.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const start = source.selectionStart;
  const end   = source.selectionEnd;
  const value = source.value;

  if (findEnclosingFence(value, start, end)) return;

  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = (() => {
    const i = value.indexOf('\n', start);
    return i === -1 ? value.length : i;
  })();
  const line = value.slice(lineStart, lineEnd);

  let prefix = null, markerLen = 0;
  let m;
  if ((m = line.match(/^(\s*)(>\s?)/))) {
    prefix = m[0];
    markerLen = m[0].length;
  } else if ((m = line.match(/^(\s*)([-*]\s)/))) {
    prefix = m[0];
    markerLen = m[0].length;
  } else if ((m = line.match(/^(\s*)(\d+)(\.\s)/))) {
    prefix = m[1] + (parseInt(m[2], 10) + 1) + m[3];
    markerLen = m[0].length;
  }

  if (!prefix) return;

  // Empty marker → escape: clear the marker and stop the list/quote.
  if (line.slice(markerLen).trim() === '' && start === end) {
    e.preventDefault();
    setRange(value.slice(0, lineStart) + value.slice(lineEnd), lineStart, lineStart);
    return;
  }

  e.preventDefault();
  const insert = '\n' + prefix;
  setRange(value.slice(0, start) + insert + value.slice(end),
           start + insert.length, start + insert.length);
});
source.addEventListener('scroll', () => {
  sourceHL.scrollTop  = source.scrollTop;
  sourceHL.scrollLeft = source.scrollLeft;
  updateProgress();
});
editor.addEventListener('input', () => {
  ensureTrailingParagraph();
  markDirty(); updateMeta(); updateProgress();
});
editor.addEventListener('scroll', updateProgress);

/* Arrow up / down inside a table cell: jump to the same column in the
 * row above/below. If we're at the first/last row, let the default
 * behaviour take over (caret leaves the table). */
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const cell = findCell(sel.anchorNode);
  if (!cell) return;
  const tr = cell.parentNode;
  const colIdx = Array.prototype.indexOf.call(tr.children, cell);
  const goingDown = e.key === 'ArrowDown';

  let targetRow = goingDown ? tr.nextElementSibling : tr.previousElementSibling;
  if (!targetRow) {
    // Cross <thead> ↔ <tbody> boundary if needed.
    const section = tr.parentNode;
    const nextSec = goingDown ? section.nextElementSibling : section.previousElementSibling;
    if (nextSec && /^(THEAD|TBODY|TFOOT)$/.test(nextSec.tagName)) {
      targetRow = goingDown ? nextSec.firstElementChild : nextSec.lastElementChild;
    }
  }
  if (!targetRow) return;     // out of table — let the browser handle it

  const targetCell = targetRow.children[Math.min(colIdx, targetRow.children.length - 1)];
  if (!targetCell) return;

  e.preventDefault();
  const r = document.createRange();
  r.selectNodeContents(targetCell);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
});

/* Tab in editor: list items → indent / outdent. Selection across blocks
 * → prepend / remove "  " on each covered block. Empty cursor → insert
 * "  " at cursor (or strip leading spaces of current line on Shift+Tab). */
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);

  // Inside a list item → use indent / outdent.
  let li = sel.anchorNode;
  while (li && li !== editor) {
    if (li.nodeType === 1 && li.tagName === 'LI') break;
    li = li.parentNode;
  }
  if (li && li !== editor) {
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    syncFromEditor();
    return;
  }

  // SELECTION across one or more blocks → indent / outdent each block.
  if (!range.collapsed) {
    const startBlock = findEditorBlock(range.startContainer);
    const endBlock   = findEditorBlock(range.endContainer);
    if (!startBlock || !endBlock) return;
    const blocks = [];
    for (let cur = startBlock; cur; cur = cur.nextElementSibling) {
      blocks.push(cur);
      if (cur === endBlock) break;
    }
    if (blocks[blocks.length - 1] !== endBlock) {
      blocks.length = 0;
      blocks.push(startBlock);
      if (endBlock !== startBlock) blocks.push(endBlock);
    }
    for (const b of blocks) {
      if (e.shiftKey) {
        const first = (function(){ const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); return w.nextNode(); })();
        if (first) first.nodeValue = first.nodeValue.replace(/^( {1,2}|\t)/, '');
      } else {
        b.insertBefore(document.createTextNode('  '), b.firstChild);
      }
    }
    // Re-select from the start of the first block to the end of the last one,
    // so the user keeps a visible selection over the indented region.
    const r = document.createRange();
    r.setStart(blocks[0], 0);
    r.setEnd(blocks[blocks.length - 1], blocks[blocks.length - 1].childNodes.length);
    sel.removeAllRanges();
    sel.addRange(r);
    syncFromEditor();
    return;
  }

  // EMPTY CURSOR: insert "  " (Tab) or strip leading spaces (Shift+Tab).
  if (e.shiftKey) {
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const stripped = node.nodeValue.replace(/^( {1,2}|\t)/, '');
      const removed = node.nodeValue.length - stripped.length;
      if (removed) {
        node.nodeValue = stripped;
        const r = document.createRange();
        r.setStart(node, Math.max(0, range.startOffset - removed));
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        syncFromEditor();
      }
    }
    return;
  }
  const tn = document.createTextNode('  ');
  range.insertNode(tn);
  const r = document.createRange();
  r.setStartAfter(tn);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  syncFromEditor();
});

editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;

  // Table cell: insert <br>, stay in cell.
  const cell = findCell(window.getSelection().anchorNode);
  if (cell) {
    e.preventDefault();
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    const r = document.createRange();
    r.setStartAfter(br);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    syncFromEditor();
    return;
  }

  const pre = inPreOrCode();
  if (!pre) return;
  e.preventDefault();
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const tn = document.createTextNode('\n');
  range.insertNode(tn);
  range.setStartAfter(tn);
  range.collapse(true);
  // If we're at the very end of the <pre>, a trailing \n won't render
  // a visible caret on a new line until another character is typed —
  // append a zero-width space so the caret appears immediately.
  const last = pre.lastChild;
  if (last === tn) {
    const zwsp = document.createTextNode('​');
    pre.appendChild(zwsp);
    range.setStart(zwsp, 1);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  editor.dispatchEvent(new Event('input'));
});

// Capture-phase listener so the shortcut fires even if the focused
// element (textarea / contentEditable) tries to swallow it.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();

  const isPlus  = e.code === 'Equal' || k === '=' || k === '+';
  const isMinus = e.code === 'Minus' || k === '-' || k === '_';
  let cmd = null;
  if (e.shiftKey) {
    if (k === 'h')        cmd = 'numberHeader';
    else if (k === 't')   cmd = 'deleteRow';
    else if (isPlus)      cmd = 'fontUp';
    else if (isMinus)     cmd = 'fontDown';
  }
  if (!cmd) {
    cmd = ({
      m: 'view', h: 'header', b: 'bold', i: 'italic', u: 'underline',
      r: 'quote', f: 'code', l: 'ul', n: 'ol', t: 'table', p: 'hr',
    })[k];
    if (!cmd && isPlus)  cmd = 'addCol';
    if (!cmd && isMinus) cmd = 'removeCol';
  }
  if (!cmd) return;          // ⌘V, ⌘S, ⌘Z, ⌘C, etc. siguen siendo nativos
  e.preventDefault();
  e.stopPropagation();
  run(cmd);
}, { capture: true });

window.mini.onMenu((action) => {
  if (action === 'open')   openFile();
  if (action === 'save')   saveFile(false);
  if (action === 'saveAs') saveFile(true);
});

/* Files passed from the OS (mini archivo.md, Finder, drag-onto-dock). */
window.mini.onZoom((delta) => adjustZoom(delta));

window.mini.onOpenFileFromOS(({ path: p, content }) => {
  state.filePath = p;
  source.value = content;
  state.baseline = content;
  state.dirty = false;
  app.dataset.dirty = 'false';
  docTitle.textContent = p.split('/').pop();
  if (state.mode === 'editor') {
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
  } else {
    highlightSource();
  }
  updateMeta();
  updateProgress();
});

source.value = '';
state.baseline = source.value;
highlightSource();
updateMeta();
updateProgress();
