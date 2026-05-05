/* --------------------------------------------------------------
 * mini — renderer. Source pane is CodeMirror 6; everything else is
 * vanilla JS. The textarea API (value, selectionStart/End, scroll,
 * addEventListener) is preserved by a shim so the rest of this file
 * keeps working unchanged.
 * -------------------------------------------------------------- */

import {
  EditorState, EditorSelection, Annotation, RangeSetBuilder,
} from '@codemirror/state';
import { EditorView, drawSelection, keymap, Decoration, ViewPlugin } from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap,
  undo as cmUndo, redo as cmRedo,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const $  = (id) => document.getElementById(id);
const app    = document.querySelector('.app');
const editor = $('editor');
const docTitle = $('doc-title');
const lineInfo = $('line-info');
const progressBar = $('progress-bar');

/* ============================================================
 * CodeMirror 6 source pane
 * ============================================================ */

// Map markdown tokens to mini's existing .hl-* classes so
// theme/theme.source.css continues to control the colours.
const miniHL = HighlightStyle.define([
  { tag: t.heading,        class: 'hl-h'  },
  { tag: t.list,            class: 'hl-l'  },
  { tag: t.quote,           class: 'hl-q'  },
  { tag: t.monospace,       class: 'hl-c'  },
  { tag: t.emphasis,        class: 'hl-em' },
  { tag: t.strong,          class: 'hl-em' },
]);

// Drop Tab and Enter from the default keymap — mini's own keydown
// handlers (auto-continue list / quote markers, smart indent) take
// over for those keys.
const filteredDefaultKeymap = defaultKeymap.filter(
  (b) => b.key !== 'Enter' && b.key !== 'Tab' && b.key !== 'Shift-Tab'
);

const inputListeners = [];


// Find/replace highlight overlay — driven by our own `findState.matches`
// (which is computed with unicode-aware whole-word semantics), not by
// @codemirror/search. Refresh is kicked by an annotation when the
// match list or current index changes.
const findRefresh = Annotation.define();
const findMatchDeco   = Decoration.mark({ class: 'mini-find-match' });
const findCurrentDeco = Decoration.mark({ class: 'mini-find-current' });
const miniFindHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged ||
        u.transactions.some((tr) => tr.annotation(findRefresh) !== undefined)) {
      this.decorations = this.build(u.view);
    }
  }
  build(view) {
    if (!findState.open || !findState.matches.length) return Decoration.none;
    const builder = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      for (let i = 0; i < findState.matches.length; i++) {
        const m = findState.matches[i];
        if (m.end < from || m.start > to) continue;
        builder.add(m.start, m.end,
          i === findState.index ? findCurrentDeco : findMatchDeco);
      }
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

function refreshFindDeco() {
  cmView.dispatch({ annotations: findRefresh.of(Date.now()) });
}

// Re-usable extension list. Every tab gets its own EditorState built
// from this set, so each tab keeps an independent rope, undo history
// and decoration plugins. Switching tabs becomes a single setState.
const cmExtensions = [
  history(),
  drawSelection(),
  markdown(),
  syntaxHighlighting(miniHL),
  EditorView.lineWrapping,
  miniFindHighlighter,
  keymap.of([...filteredDefaultKeymap, ...historyKeymap]),
  EditorView.updateListener.of((v) => {
    if (!v.docChanged) return;
    // Only fire `input` for user-driven changes; programmatic value
    // assignments via the shim use plain dispatches (no userEvent),
    // so they won't accidentally flip the dirty flag.
    const fromUser = v.transactions.some((tr) =>
      tr.isUserEvent('input') ||
      tr.isUserEvent('delete') ||
      tr.isUserEvent('paste') ||
      tr.isUserEvent('drop') ||
      tr.isUserEvent('move')
    );
    if (!fromUser) return;
    const ev = new Event('input');
    for (const fn of inputListeners) fn(ev);
  }),
];

function makeCMState(doc) {
  return EditorState.create({ doc: doc || '', extensions: cmExtensions });
}

const cmView = new EditorView({
  parent: $('source-host'),
  state: makeCMState(''),
});

// Shim that mirrors the textarea API used elsewhere in this file.
const source = {
  get value()  { return cmView.state.doc.toString(); },
  set value(v) {
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: v ?? '' },
      selection: { anchor: 0 },
      scrollIntoView: false,
    });
  },
  get selectionStart() { return cmView.state.selection.main.from; },
  set selectionStart(p) {
    const cur = cmView.state.selection.main;
    const head = Math.max(p, cur.to);
    cmView.dispatch({ selection: { anchor: p, head } });
  },
  get selectionEnd()   { return cmView.state.selection.main.to; },
  set selectionEnd(p) {
    const cur = cmView.state.selection.main;
    const anchor = Math.min(p, cur.from);
    cmView.dispatch({ selection: { anchor, head: p } });
  },
  get scrollTop()    { return cmView.scrollDOM.scrollTop; },
  set scrollTop(v)   { cmView.scrollDOM.scrollTop = v; },
  get scrollLeft()   { return cmView.scrollDOM.scrollLeft; },
  set scrollLeft(v)  { cmView.scrollDOM.scrollLeft = v; },
  get clientHeight() { return cmView.scrollDOM.clientHeight; },
  get clientWidth()  { return cmView.scrollDOM.clientWidth; },
  get hidden()       { return $('source-host').hidden; },
  set hidden(v)      { $('source-host').hidden = !!v; },
  focus() { cmView.focus(); },
  blur()  { cmView.contentDOM.blur(); },
  dispatchEvent(ev) {
    if (ev && ev.type === 'input') {
      for (const fn of inputListeners) fn(ev);
      return true;
    }
    return cmView.dom.dispatchEvent(ev);
  },
  addEventListener(type, fn, opts) {
    if (type === 'input') { inputListeners.push(fn); return; }
    if (type === 'scroll') { cmView.scrollDOM.addEventListener(type, fn, opts); return; }
    // Keyboard / pointer / focus events: capture so we run BEFORE
    // CodeMirror's own bubble-phase keymap listener.
    if (type === 'keydown' || type === 'keyup' || type === 'keypress') {
      cmView.contentDOM.addEventListener(type, fn, opts ?? { capture: true });
      return;
    }
    cmView.contentDOM.addEventListener(type, fn, opts);
  },
};


const state = {
  filePath: null,
  mode: 'source',     // 'source' | 'editor'
  dirty: false,
  baseline: '',       // last saved/loaded content
  tabs: [],           // [{ path, name, content, baseline, dirty }]
  currentTabIndex: -1,
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
    if (s.mode === 'editor') { source.hidden = true;  editor.hidden = false; }
    else                     { editor.hidden = true;  source.hidden = false; }
    state.mode = s.mode;
    app.dataset.mode = s.mode;
  }
  source.value = s.source;
  source.selectionStart = s.sourceStart;
  source.selectionEnd   = s.sourceEnd;
  source.scrollTop      = s.sourceScroll;
  editor.innerHTML  = s.editor;
  editor.scrollTop  = s.editorScroll;
  if (state.mode === 'editor') {
    ensureTrailingParagraph();
    setEditorCaretByOffset(s.editorOffset);
  }
  updateLineInfo();
  updateProgress();
}

function pushUndo(kind) {
  // Source-mode history is owned by CodeMirror — skip our snapshot
  // entirely so we don't keep megabyte-scale copies of the document
  // around for every keystroke.
  if (state.mode === 'source') return;

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

// Editor-mode contenteditable still needs our snapshot stack — its
// DOM operations aren't covered by any standard history. Source-mode
// editing goes through CodeMirror, whose own `history()` extension
// records a finer-grained, memory-efficient timeline.
editor.addEventListener('beforeinput', () => pushUndo('editor-input'));

window.mini.onAppCmd((cmd) => {
  if (state.mode === 'source') {
    if (cmd === 'undo') return cmUndo(cmView);
    if (cmd === 'redo') return cmRedo(cmView);
    return;
  }
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
    $('theme-source-css').textContent = t.source ? scopeCSS(t.source, '.pane.source', '.app[data-mode="source"]') : '';
    $('theme-editor-css').textContent = t.editor ? scopeCSS(t.editor, '.pane.editor', '.app[data-mode="editor"]') : '';
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
function scopeCSS(css, scope, rootScope) {
  // Strip comments so we don't scope inside them.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // `rootScope` is where `:root { ... }` blocks land. Defaults to `scope`,
  // but pass a higher selector (e.g. `.app[data-mode="source"]`) when you
  // want chrome outside the pane (titlebar, toolbar) to inherit theme vars.
  const rs = rootScope || scope;
  return css.replace(/(^|\})\s*([^{}@][^{}]*?)\{/g, (m, brace, sel) => {
    const scoped = sel
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        if (s.startsWith(':root')) return rs + s.slice(5);
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

  // Bold first; stash the rendered span so the italic regexes below can
  // never see the inner `**` / `__` and accidentally re-match a single-* / _.
  const bolds = [];
  const stashBold = (open, close, content) => {
    bolds.push(`<span class="hl-em">${open}${content}${close}</span>`);
    return `\x03${bolds.length - 1}\x03`;
  };
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, c) => stashBold('**', '**', c));
  s = s.replace(/__([^_\n]+)__/g,     (_, c) => stashBold('__', '__', c));

  // Italic (* or _ standalone) — bolds are already replaced by placeholders.
  s = s.replace(/\*([^*\n]+)\*/g, '<span class="hl-em">*$1*</span>');
  s = s.replace(/(^|[^a-zA-Z0-9])_([^_\n]+)_(?=[^a-zA-Z0-9]|$)/g, '$1<span class="hl-em">_$2_</span>');

  // Underline <u>…</u> — already escaped to &lt;u&gt;…&lt;/u&gt;
  s = s.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<span class="hl-em">&lt;u&gt;$1&lt;/u&gt;</span>');

  // Re-inject bold spans, then code spans.
  s = s.replace(/\x03(\d+)\x03/g, (_, i) => bolds[+i]);
  s = s.replace(/\x02(\d+)\x02/g, (_, i) =>
    `<span class="hl-c">\`</span>${codes[+i]}<span class="hl-c">\`</span>`);
  return s;
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

/* Caret preservation across ⌘M.
 *
 * Both views show "the same" document but with very different character
 * counts: source has markdown markers, the rendered editor doesn't. We
 * map between them via a "plain-text offset" — i.e. how many *visible*
 * characters precede the caret. The mapping is heuristic (best-effort),
 * not a full markdown parser. It handles the common cases: headings,
 * blockquotes, list markers, fenced code, emphasis pairs and links. */
function buildPlainMap(md) {
  const out = new Array(md.length + 1);
  out[0] = 0;
  let plain = 0;
  let i = 0;
  let inFence = false;

  const skipLineSyntax = (start) => {
    let k = 0;
    while (md[start + k] === '>') {
      k++;
      if (md[start + k] === ' ') k++;
    }
    let s = 0;
    while (md[start + k + s] === ' ' && s < 4) s++;
    k += s;
    const m = md.slice(start + k).match(/^(?:[-*+]|\d+\.) /);
    if (m) k += m[0].length;
    let h = 0;
    while (md[start + k + h] === '#' && h < 6) h++;
    if (h > 0 && md[start + k + h] === ' ') k += h + 1;
    return k;
  };

  while (i < md.length) {
    const atLineStart = (i === 0 || md[i - 1] === '\n');

    if (atLineStart) {
      if (md.slice(i, i + 3) === '```') {
        inFence = !inFence;
        const eol = md.indexOf('\n', i);
        const stop = eol === -1 ? md.length : eol;
        while (i < stop) { i++; out[i] = plain; }
        continue;
      }
      if (!inFence) {
        const skip = skipLineSyntax(i);
        for (let k = 0; k < skip; k++) { i++; out[i] = plain; }
        if (i >= md.length) break;
      }
    }

    const c = md[i];

    if (c === '\n') {
      i++; out[i] = plain;       // newlines don't add to plain offset:
      continue;                  // editor.textContent has no \n between blocks
    }

    if (!inFence) {
      if ((c === '*' || c === '_') && md[i + 1] === c) {
        i++; out[i] = plain; i++; out[i] = plain; continue;
      }
      if (c === '~' && md[i + 1] === '~') {
        i++; out[i] = plain; i++; out[i] = plain; continue;
      }
      if (c === '*' || c === '_' || c === '`') {
        i++; out[i] = plain; continue;
      }
      if (c === '[') {
        const close = md.indexOf(']', i + 1);
        if (close > i && md[close + 1] === '(') {
          const finish = md.indexOf(')', close + 2);
          if (finish > close) {
            i++; out[i] = plain;                              // [
            while (i < close) { plain++; i++; out[i] = plain; }   // text
            while (i <= finish) { i++; out[i] = plain; }      // ](url)
            continue;
          }
        }
      }
    }

    plain++; i++; out[i] = plain;
  }
  return out;
}

function getEditorPlainOffset() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(editor);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function placeEditorCaretAtPlainOffset(target) {
  if (target == null) return;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let n, count = 0, last = null;
  while ((n = walker.nextNode())) {
    last = n;
    const len = n.nodeValue.length;
    if (count + len >= target) {
      const range = document.createRange();
      range.setStart(n, Math.max(0, target - count));
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    count += len;
  }
  const range = document.createRange();
  if (last) range.setStart(last, last.nodeValue.length);
  else { range.selectNodeContents(editor); range.collapse(false); }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function sourceCaretToPlain(srcOffset) {
  const map = buildPlainMap(source.value);
  return map[Math.min(srcOffset, map.length - 1)] ?? 0;
}

function plainToSourceCaret(plain, src) {
  const map = buildPlainMap(src);
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= plain) return i;
  }
  return src.length;
}

const VIEW_MODE_KEY = 'mini.viewMode';

function setMode(mode) {
  if (mode === state.mode) return;
  try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
  if (mode === 'editor') {
    const plain = sourceCaretToPlain(source.selectionStart);
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
    source.hidden = true;
    editor.hidden = false;
    state.mode = 'editor';
    app.dataset.mode = 'editor';
    requestAnimationFrame(() => {
      editor.focus();
      placeEditorCaretAtPlainOffset(plain);
    });
  } else {
    const plain = getEditorPlainOffset();
    source.value = htmlToMd(editor.innerHTML);
    editor.hidden = true;
    source.hidden = false;
    state.mode = 'source';
    app.dataset.mode = 'source';
    const caret = plain == null ? 0 : plainToSourceCaret(plain, source.value);
    requestAnimationFrame(() => {
      source.focus();
      source.selectionStart = source.selectionEnd = caret;
      // CodeMirror handles scroll-into-view via scrollIntoView option
      cmView.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
    });
    updateMeta();
  }
  updateProgress();
  updateLineInfo();
  if (state.currentTabIndex >= 0) {
    state.tabs[state.currentTabIndex].mode = state.mode;
    persistTabs();
  }
  if (typeof findState !== 'undefined' && findState.open) {
    findState.index = -1;
    computeMatches();
    updateCounter();
    renderFindHL();
  }
}

/* ============================================================
 * Source-mode commands (textarea text manipulation)
 * ============================================================ */

function getSel() {
  return { start: source.selectionStart, end: source.selectionEnd, value: source.value };
}

function setRange(value, selStart, selEnd) {
  // Diff old vs new and dispatch only the differing range so a small
  // edit doesn't replace the whole document. The diff iterates the
  // doc's rope chunks via `doc.iter()` instead of allocating a flat
  // string with toString() — keeps memory usage flat for huge files.
  const doc = cmView.state.doc;
  const oldLen = doc.length;
  const newLen = value.length;

  // common prefix (forward)
  let from = 0;
  if (newLen > 0 && oldLen > 0) {
    const it = doc.iter();
    it.next();
    while (!it.done && from < newLen) {
      const c = it.value;
      const limit = Math.min(c.length, newLen - from);
      let i = 0;
      while (i < limit && c.charCodeAt(i) === value.charCodeAt(from + i)) i++;
      from += i;
      if (i < c.length || from === newLen) break;
      it.next();
    }
  }

  // common suffix (backward)
  let toOld = oldLen;
  let toNew = newLen;
  if (toOld > from && toNew > from) {
    const it = doc.iter(-1);
    it.next();
    while (!it.done && toOld > from && toNew > from) {
      const c = it.value;
      const limit = Math.min(c.length, toNew - from, toOld - from);
      let i = 0;
      while (i < limit &&
             c.charCodeAt(c.length - 1 - i) === value.charCodeAt(toNew - 1 - i)) i++;
      toOld -= i;
      toNew -= i;
      if (i < c.length) break;
      it.next();
    }
  }

  // Skip the dispatch entirely when there's no actual diff — only
  // update the selection if it has to move.
  if (from === toOld && from === toNew) {
    const sel = cmView.state.selection.main;
    if (sel.from !== selStart || sel.to !== selEnd) {
      cmView.dispatch({ selection: { anchor: selStart, head: selEnd } });
    }
    return;
  }
  cmView.dispatch({
    changes: { from, to: toOld, insert: value.slice(from, toNew) },
    selection: { anchor: selStart, head: selEnd },
    userEvent: 'input.replace',
  });
}

function toggleWrap(open, close = open) {
  const doc = cmView.state.doc;
  const sel = cmView.state.selection.main;
  const start = sel.from, end = sel.to;
  const docLen = doc.length;
  const selText = doc.sliceString(start, end);

  // Already wrapped immediately outside the selection?
  const beforeStart = Math.max(0, start - open.length);
  const afterEnd   = Math.min(docLen, end + close.length);
  const before = doc.sliceString(beforeStart, start);
  const after  = doc.sliceString(end, afterEnd);
  if (before === open && after === close) {
    cmView.dispatch({
      changes: [
        { from: start - open.length, to: start, insert: '' },
        { from: end,                 to: end + close.length, insert: '' },
      ],
      selection: { anchor: start - open.length, head: end - open.length },
      userEvent: 'input.replace',
    });
    return;
  }

  // Selection itself is wrapped?
  if (selText.length >= open.length + close.length &&
      selText.startsWith(open) && selText.endsWith(close)) {
    cmView.dispatch({
      changes: [
        { from: start,                 to: start + open.length, insert: '' },
        { from: end - close.length,    to: end,                  insert: '' },
      ],
      selection: { anchor: start, head: end - open.length - close.length },
      userEvent: 'input.replace',
    });
    return;
  }

  if (selText.length === 0) {
    cmView.dispatch({
      changes: { from: start, insert: open + close },
      selection: { anchor: start + open.length },
      userEvent: 'input.insert',
    });
  } else {
    cmView.dispatch({
      changes: [
        { from: start, insert: open },
        { from: end,   insert: close },
      ],
      selection: { anchor: start + open.length, head: end + open.length },
      userEvent: 'input.insert',
    });
  }
}

function lineBoundsAt(value, pos) {
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  let end = value.indexOf('\n', pos);
  if (end === -1) end = value.length;
  return { start, end };
}

function selectedLineRange() {
  const sel = cmView.state.selection.main;
  const doc = cmView.state.doc;
  const a = doc.lineAt(sel.from).from;
  // If the selection ends exactly at a line break, fold back so the
  // empty trailing line isn't included.
  const endProbe = sel.to > sel.from && doc.sliceString(sel.to - 1, sel.to) === '\n'
    ? sel.to - 1
    : sel.to;
  const b = doc.lineAt(endProbe).to;
  return { a, b };
}

function rewriteLines(transform) {
  const { a, b } = selectedLineRange();
  const block = cmView.state.doc.sliceString(a, b);
  const lines = block.split('\n');
  const next = transform(lines).join('\n');
  cmView.dispatch({
    changes: { from: a, to: b, insert: next },
    selection: { anchor: a, head: a + next.length },
    userEvent: 'input.replace',
  });
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
  flashEditorHint(`${MOD}H · Heading ${nb.tagName === 'P' ? '¶' : nb.tagName}`);
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
  flashEditorHint(`${MOD}${SHIFT}H · ${nb.tagName === 'P' ? '¶' : nb.tagName}`);
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
  if (cmd === 'find') { openFind(); return; }
  flashEditorHint(HINTS[cmd]);
  if (cmd === 'view') { setMode(state.mode === 'source' ? 'editor' : 'source'); return; }
  if (cmd === 'open') { openFile(); return; }
  if (cmd === 'save') { saveFile(); return; }
  if (cmd === 'reloadDisk') { reloadFromDisk(); return; }
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
 * Tabs (sidebar) — open files / recents
 * ============================================================ */

const TABS_KEY = 'mini.openTabs';
const sidebarEl = document.getElementById('sidebar');
const sidebarList = document.getElementById('sidebar-list');

function basename(p) { return (p || '').split(/[/\\]/).pop(); }

function persistTabs() {
  try {
    const tabs = state.tabs
      .filter(t => t.path)
      .map(t => ({ path: t.path, mode: t.mode || 'source' }));
    const activePath = state.currentTabIndex >= 0
      ? state.tabs[state.currentTabIndex].path : null;
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activePath }));
  } catch {}
}

// Snapshot the editor's live state into the active tab. With per-tab
// EditorStates this is a reference assignment — no string copy, no
// allocation regardless of doc size.
function captureCurrentTab() {
  if (state.currentTabIndex < 0) return;
  const t = state.tabs[state.currentTabIndex];
  t.cmState = cmView.state;
  t.dirty = state.dirty;
  t.baseline = state.baseline;
  t.path = state.filePath;
  t.name = state.filePath ? basename(state.filePath) : 'untitled.md';
  t.mode = state.mode;
  // Editor mode has no built-in state object like CodeMirror's, so we
  // stash caret offset + scroll so the next switch restores the view.
  if (state.mode === 'editor') {
    t.editorOffset = getEditorCaretOffset();
    t.editorScroll = editor.scrollTop;
  }
}

function loadTab(t) {
  state.filePath = t.path;
  state.baseline = t.baseline;
  state.dirty = t.dirty;
  app.dataset.dirty = t.dirty ? 'true' : 'false';
  docTitle.textContent = t.name;

  const targetMode = t.mode || state.mode;

  // Lazy upgrade for tabs persisted in the old `content` format.
  if (!t.cmState) t.cmState = makeCMState(t.content);

  // Pure state swap — instant, no dispatch, no string allocation.
  if (cmView.state !== t.cmState) cmView.setState(t.cmState);

  if (targetMode === 'editor') {
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
  } else {
    editor.innerHTML = '';
  }

  if (state.mode !== targetMode) {
    if (targetMode === 'editor') { source.hidden = true;  editor.hidden = false; }
    else                         { editor.hidden = true;  source.hidden = false; }
    state.mode = targetMode;
    app.dataset.mode = targetMode;
  }

  // Restore the editor's view (CodeMirror handles this for source via setState).
  if (targetMode === 'editor') {
    requestAnimationFrame(() => {
      if (typeof t.editorScroll === 'number') editor.scrollTop = t.editorScroll;
      if (typeof t.editorOffset === 'number') setEditorCaretByOffset(t.editorOffset);
    });
  }

  updateMeta();
  updateProgress();
}

function switchToTab(i) {
  if (i < 0 || i >= state.tabs.length) return;
  if (i === state.currentTabIndex) return;
  captureCurrentTab();
  state.currentTabIndex = i;
  loadTab(state.tabs[i]);
  renderSidebar();
  persistTabs();
}

function addTab(filePath, content) {
  if (filePath) {
    const existing = state.tabs.findIndex(t => t.path === filePath);
    if (existing >= 0) { switchToTab(existing); return existing; }
  }
  captureCurrentTab();
  const tab = {
    path: filePath || null,
    name: filePath ? basename(filePath) : 'untitled.md',
    cmState: makeCMState(content || ''),
    baseline: content || '',
    dirty: false,
    mode: state.mode,    // new tabs inherit the current view
  };
  state.tabs.push(tab);
  state.currentTabIndex = state.tabs.length - 1;
  loadTab(tab);
  renderSidebar();
  persistTabs();
  return state.currentTabIndex;
}

function closeTab(i) {
  if (i < 0 || i >= state.tabs.length) return;
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    state.currentTabIndex = -1;
    state.filePath = null;
    state.baseline = '';
    state.dirty = false;
    app.dataset.dirty = 'false';
    cmView.setState(makeCMState(''));
    docTitle.textContent = 'untitled.md';
    if (state.mode === 'editor') {
      editor.innerHTML = '';
      ensureTrailingParagraph();
    }
    updateMeta();
    updateProgress();
  } else if (state.currentTabIndex === i) {
    const next = Math.min(i, state.tabs.length - 1);
    state.currentTabIndex = next;
    loadTab(state.tabs[next]);
  } else if (state.currentTabIndex > i) {
    state.currentTabIndex--;
  }
  renderSidebar();
  persistTabs();
}

function newTab() { return addTab(null, ''); }

// User pressed ⌘W: close active tab. With no tabs left and no current,
// fall back to closing the window.
function closeAction() {
  if (state.currentTabIndex >= 0) {
    closeTab(state.currentTabIndex);
  } else {
    window.mini.closeWindow();
  }
}

function renderSidebar() {
  sidebarList.innerHTML = '';
  for (let i = 0; i < state.tabs.length; i++) {
    const t = state.tabs[i];
    const li = document.createElement('li');
    li.className = 'tab-item' +
      (i === state.currentTabIndex ? ' active' : '') +
      (t.dirty ? ' dirty' : '');
    li.draggable = true;
    li.dataset.idx = String(i);

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    name.title = t.path || t.name;
    li.addEventListener('click', () => switchToTab(i));
    li.appendChild(name);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    li.appendChild(close);

    attachTabDnD(li, i);
    sidebarList.appendChild(li);
  }
  // Only show the sidebar when there's more than one open tab.
  sidebarEl.hidden = state.tabs.length < 2;
}

/* ---------- Drag-and-drop reorder ---------- */

function clearDragMarkers() {
  sidebarList
    .querySelectorAll('.drag-over-top, .drag-over-bottom')
    .forEach((el) => el.classList.remove('drag-over-top', 'drag-over-bottom'));
}

function attachTabDnD(li, index) {
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDragMarkers();
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height / 2;
    clearDragMarkers();
    li.classList.add(upper ? 'drag-over-top' : 'drag-over-bottom');
  });
  li.addEventListener('dragleave', (e) => {
    // only clear if leaving for an unrelated target
    if (e.relatedTarget && li.contains(e.relatedTarget)) return;
    li.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(fromIdx)) return;
    const rect = li.getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height / 2;
    const toIdx = upper ? index : index + 1;
    moveTab(fromIdx, toIdx);
  });
}

function moveTab(from, to) {
  if (from < 0 || from >= state.tabs.length) return;
  let target = to;
  if (target > from) target--;        // splice shifts indices left
  if (target === from) return;        // no-op
  const activeRef = state.currentTabIndex >= 0 ? state.tabs[state.currentTabIndex] : null;
  const [t] = state.tabs.splice(from, 1);
  state.tabs.splice(target, 0, t);
  if (activeRef) state.currentTabIndex = state.tabs.indexOf(activeRef);
  renderSidebar();
  persistTabs();
}

/* ---------- Sidebar resize ---------- */

const sidebarResizer = document.getElementById('sidebar-resizer');
const SIDEBAR_WIDTH_KEY = 'mini.sidebarWidth';
const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 200;

function applySidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
  sidebarEl.style.flex = `0 0 ${w}px`;
  return w;
}

(function initSidebarWidth() {
  const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  applySidebarWidth(Number.isFinite(stored) ? stored : SIDEBAR_DEFAULT);
})();

let sidebarResizing = false;
sidebarResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sidebarResizing = true;
  document.body.classList.add('sidebar-resizing');
  sidebarResizer.classList.add('resizing');
});
document.addEventListener('mousemove', (e) => {
  if (!sidebarResizing) return;
  applySidebarWidth(e.clientX);
});
document.addEventListener('mouseup', () => {
  if (!sidebarResizing) return;
  sidebarResizing = false;
  document.body.classList.remove('sidebar-resizing');
  sidebarResizer.classList.remove('resizing');
  const w = sidebarEl.getBoundingClientRect().width;
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w))); } catch {}
});

async function restoreTabs() {
  try {
    const stored = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
    if (!stored) return;
    // Back-compat: older sessions stored just `paths`.
    const list = stored.tabs || (stored.paths || []).map(p => ({ path: p }));
    const activePath = stored.activePath || null;
    let activeIdx = -1;
    for (const spec of list) {
      const f = await window.mini.readFile(spec.path);
      if (!f) continue;
      state.tabs.push({
        path: f.path,
        name: basename(f.path),
        cmState: makeCMState(f.content),
        baseline: f.content,
        dirty: false,
        mode: spec.mode || 'source',
      });
      if (f.path === activePath) activeIdx = state.tabs.length - 1;
    }
    if (state.tabs.length > 0) {
      const idx = activeIdx >= 0 ? activeIdx : 0;
      state.currentTabIndex = idx;
      loadTab(state.tabs[idx]);
    }
    renderSidebar();
  } catch {}
}

/* ============================================================
 * Files
 * ============================================================ */

async function openFile() {
  const f = await window.mini.openFile();
  if (!f) return;
  addTab(f.path, f.content);
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

/* Floating copy button on each <pre> in editor mode.
 * Marked contenteditable=false and class="code-copy" — htmlToMd skips it. */
const COPY_ICON_SVG = `
<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"
        fill="none" stroke="currentColor" stroke-width="1.3"/>
  <path d="M2.75 10.5 V3.75 a1.5 1.5 0 0 1 1.5 -1.5 H10.5"
        fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const CHECK_ICON_SVG = `
<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function decorateCodeBlocks() {
  for (const pre of editor.querySelectorAll('pre')) {
    if (pre.querySelector(':scope > .code-copy')) continue;
    const btn = document.createElement('div');
    btn.className = 'code-copy';
    btn.innerHTML = COPY_ICON_SVG;
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.contentEditable = 'false';
    btn.setAttribute('aria-hidden', 'false');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = (code ? code.textContent : pre.textContent).replace(/​/g, '');
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = CHECK_ICON_SVG;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = COPY_ICON_SVG;
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
  docTitle.textContent = basename(result);

  if (state.currentTabIndex < 0) {
    addTab(result, source.value);
  } else {
    const t = state.tabs[state.currentTabIndex];
    t.path = result;
    t.name = basename(result);
    t.cmState = cmView.state;          // pin the post-save state
    t.baseline = source.value;
    t.dirty = false;
    renderSidebar();
    persistTabs();
  }
}

/* ============================================================
 * Stats & progress
 * ============================================================ */

function activePane() {
  return state.mode === 'source' ? source : editor;
}

function updateMeta() { /* word/char counter removed */ }

/* Current line:column indicator — source mode only.
 * In editor mode the same pill is reused as a transient "hint" surface
 * (e.g. flashEditorHint('⌘H · H1') after a heading cycle). */
const IS_MAC = /Mac/i.test(navigator.platform);
const MOD    = IS_MAC ? '⌘' : 'Ctrl+';
const SHIFT  = IS_MAC ? '⇧' : 'Shift+';

const HINTS = {
  bold:      `${MOD}B · Bold`,
  italic:    `${MOD}I · Italic`,
  underline: `${MOD}U · Underline`,
  ul:        `${MOD}L · Bullet List`,
  ol:        `${MOD}K · Numbered List`,
  quote:     `${MOD}D · Quote`,
  code:      `${MOD}R · Code`,
  hr:        `${MOD}P · Rule`,
  table:     `${MOD}T · Add Row`,
  deleteRow: `${MOD}${SHIFT}T · Remove Row`,
  addCol:    `${MOD}G · Add Col`,
  removeCol: `${MOD}${SHIFT}G · Remove Col`,
  reloadDisk:`${MOD}${SHIFT}R · Reload from Disk`,
  fontUp:    `${MOD}+ · Zoom In`,
  fontDown:  `${MOD}− · Zoom Out`,
};

let editorHintTimer = null;
function flashEditorHint(text, ms = 2500) {
  if (!text || state.mode !== 'editor') return;
  lineInfo.textContent = text;
  if (editorHintTimer) clearTimeout(editorHintTimer);
  editorHintTimer = setTimeout(() => {
    editorHintTimer = null;
    if (state.mode === 'editor') lineInfo.textContent = '';
  }, ms);
}

function updateLineInfo() {
  if (state.mode !== 'source') {
    if (!editorHintTimer) lineInfo.textContent = '';
    return;
  }
  // O(log N) line lookup via CodeMirror's line index — beats slicing
  // and splitting the entire doc on every cursor move.
  const head = cmView.state.selection.main.head;
  const ln = cmView.state.doc.lineAt(head);
  lineInfo.textContent = ln.number + ':' + (head - ln.from + 1);
}

['keyup', 'click', 'input', 'mouseup', 'focus'].forEach((ev) => {
  source.addEventListener(ev, updateLineInfo);
});
document.addEventListener('selectionchange', updateLineInfo);

// Coalesce progress updates with rAF — input/scroll fire many times per
// frame; one layout-read per paint is enough.
let progressRAF = 0;
function updateProgress() {
  if (progressRAF) return;
  progressRAF = requestAnimationFrame(() => {
    progressRAF = 0;
    const p = activePane();
    const max = p.scrollHeight - p.clientHeight;
    const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, p.scrollTop / max));
    progressBar.style.width = (ratio * 100).toFixed(1) + '%';
  });
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    app.dataset.dirty = 'true';
    if (state.currentTabIndex >= 0) {
      state.tabs[state.currentTabIndex].dirty = true;
      // Targeted update — avoid rebuilding the whole sidebar DOM
      // tree on every keystroke that flips the dirty flag.
      const item = sidebarList.children[state.currentTabIndex];
      if (item) item.classList.add('dirty');
    }
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

/* Toolbar collapse / expand — state persisted to localStorage */
const collapseBtn = document.getElementById('toolbar-collapse');
const fabBtn      = document.getElementById('toolbar-fab');
const TOOLBAR_KEY = 'mini.toolbarCollapsed';
const setCollapsed = (v) => {
  if (v) document.body.setAttribute('data-toolbar', 'collapsed');
  else   document.body.removeAttribute('data-toolbar');
  try { localStorage.setItem(TOOLBAR_KEY, v ? '1' : '0'); } catch {}
};
setCollapsed(localStorage.getItem(TOOLBAR_KEY) === '1');
collapseBtn.addEventListener('click', () => setCollapsed(true));
fabBtn.addEventListener('click', () => setCollapsed(false));

/* Toolbar buttons: delegate click to run() based on data-cmd. */
document.querySelector('.tools')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tool-btn[data-cmd]');
  if (!btn) return;
  e.preventDefault();
  // Keep keyboard focus on the editor pane after clicking — otherwise
  // commands like ⌘B would no-op because focus is on the toolbar button.
  (state.mode === 'editor' ? editor : source).focus();
  run(btn.dataset.cmd);
});

source.addEventListener('input', () => {
  markDirty(); updateMeta(); updateProgress();
  if (state.mode === 'source' && findState && findState.open) scheduleFindRescan();
});

/* Tab in source — three behaviours:
 *   1. Multi-line selection      → indent / outdent every covered line.
 *   2. Caret at line start (no sel) → indent / outdent that line.
 *   3. Caret mid-line / single-line selection → insert "  " at cursor
 *      (Tab) or no-op (Shift+Tab). Standard text-editor behaviour. */
source.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const doc = cmView.state.doc;
  const sel = cmView.state.selection.main;
  const start = sel.from, end = sel.to;
  const startLine = doc.lineAt(start);
  const endProbe = (end > start && doc.sliceString(end - 1, end) === '\n') ? end - 1 : end;
  const endLine = doc.lineAt(endProbe);
  const isMultiLine = startLine.from !== endLine.from;

  // 1) Multi-line selection — indent / outdent every covered line.
  if (isMultiLine) {
    const a = startLine.from;
    const b = endLine.to;
    const lines = doc.sliceString(a, b).split('\n');
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
    cmView.dispatch({
      changes: { from: a, to: b, insert: out.join('\n') },
      selection: { anchor: start + firstDelta, head: end + totalDelta },
      userEvent: 'input.replace',
    });
    return;
  }

  // 2) Caret at start of line, no selection — indent/outdent the line.
  if (start === end && start === startLine.from) {
    if (e.shiftKey) {
      const head = doc.sliceString(startLine.from, Math.min(startLine.from + 2, startLine.to));
      const m = head.match(/^( {1,2}|\t)/);
      if (m) {
        cmView.dispatch({
          changes: { from: startLine.from, to: startLine.from + m[0].length, insert: '' },
          selection: { anchor: start, head: end },
          userEvent: 'delete.dedent',
        });
      }
    } else {
      cmView.dispatch({
        changes: { from: startLine.from, insert: '  ' },
        selection: { anchor: start + 2, head: end + 2 },
        userEvent: 'input.indent',
      });
    }
    return;
  }

  // 3) Mid-line / single-line selection — standard insert / no-op.
  if (e.shiftKey) return;
  cmView.dispatch({
    changes: { from: start, to: end, insert: '  ' },
    selection: { anchor: start + 2 },
    userEvent: 'input.indent',
  });
});

/* Enter in source: continue the previous line's marker (>, -, *, 1.).
 * Empty marker line (e.g. "- " with nothing after) escapes the list.
 * Inside a fenced ``` block we don't intervene — Enter just adds \n. */
source.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const doc = cmView.state.doc;
  const sel = cmView.state.selection.main;
  const start = sel.from, end = sel.to;

  // Inside a fenced ``` block: let CodeMirror handle Enter normally.
  // findEnclosingFence still walks the whole doc to pair fences — that's
  // the only path that needs full content, and it's invoked once per Enter.
  if (findEnclosingFence(doc.toString(), start, end)) return;

  const ln = doc.lineAt(start);
  const line = ln.text;

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
    cmView.dispatch({
      changes: { from: ln.from, to: ln.to, insert: '' },
      selection: { anchor: ln.from },
      userEvent: 'delete.list-escape',
    });
    return;
  }

  e.preventDefault();
  const insert = '\n' + prefix;
  cmView.dispatch({
    changes: { from: start, to: end, insert },
    selection: { anchor: start + insert.length },
    userEvent: 'input.list-continue',
  });
});
source.addEventListener('scroll', updateProgress);
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

/* Tab in editor: tables → next/previous cell. List items → indent /
 * outdent. Selection across blocks → prepend / remove "  " on each
 * covered block. Empty cursor → insert "  " at cursor (or strip leading
 * spaces of current line on Shift+Tab). */
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);

  // Inside a table cell → navigate left-to-right; wrap to next row at
  // the end; on the last cell of the last row, append a fresh body row.
  const cell = findCell(sel.anchorNode);
  if (cell) {
    const tr = cell.parentNode;
    const cells = Array.from(tr.children);
    const colIdx = cells.indexOf(cell);
    const sectionSibling = (section, dir) =>
      (section && /^(THEAD|TBODY|TFOOT)$/.test(section.tagName))
        ? section[dir === 'next' ? 'nextElementSibling' : 'previousElementSibling']
        : null;
    let target = null;

    if (e.shiftKey) {
      if (colIdx > 0) {
        target = cells[colIdx - 1];
      } else {
        let prevRow = tr.previousElementSibling;
        if (!prevRow) {
          const sec = sectionSibling(tr.parentNode, 'prev');
          if (sec) prevRow = sec.lastElementChild;
        }
        if (prevRow) target = prevRow.children[prevRow.children.length - 1];
      }
    } else {
      if (colIdx < cells.length - 1) {
        target = cells[colIdx + 1];
      } else {
        let nextRow = tr.nextElementSibling;
        if (!nextRow) {
          const sec = sectionSibling(tr.parentNode, 'next');
          if (sec) nextRow = sec.firstElementChild;
        }
        if (!nextRow) {
          const table = findTable(cell);
          if (table) {
            let tbody = table.querySelector('tbody');
            if (!tbody) {
              tbody = document.createElement('tbody');
              table.appendChild(tbody);
            }
            nextRow = document.createElement('tr');
            for (let i = 0; i < cells.length; i++) nextRow.appendChild(newCell('td'));
            tbody.appendChild(nextRow);
            markDirty(); updateMeta();
          }
        }
        if (nextRow) target = nextRow.children[0];
      }
    }

    if (target) {
      const r = document.createRange();
      r.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return;
  }

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
  // While typing in the find panel only ⌘F (re-focus) is meaningful;
  // every other editor command is suppressed so it doesn't corrupt the
  // document while the user is searching.
  const inFind = findPanel && findPanel.contains(document.activeElement);
  if (inFind && k !== 'f') return;

  const isPlus  = e.code === 'Equal' || k === '=' || k === '+';
  const isMinus = e.code === 'Minus' || k === '-' || k === '_';
  let cmd = null;
  if (e.shiftKey) {
    if (k === 'h')        cmd = 'numberHeader';
    else if (k === 't')   cmd = 'deleteRow';
    else if (k === 'g')   cmd = 'removeCol';
    else if (isPlus)      cmd = 'fontUp';      // ⌘⇧+ also zooms in
    else if (isMinus)     cmd = 'fontDown';    // ⌘⇧- also zooms out
    else return;             // any other ⌘⇧… is reserved for menus / native
  } else {
    cmd = ({
      m: 'view', h: 'header', b: 'bold', i: 'italic', u: 'underline',
      f: 'find', d: 'quote', r: 'code', l: 'ul', k: 'ol', t: 'table', p: 'hr',
      g: 'addCol',
    })[k];
    if (!cmd && isPlus)  cmd = 'fontUp';
    if (!cmd && isMinus) cmd = 'fontDown';
  }
  if (!cmd) return;          // ⌘V, ⌘S, ⌘Z, ⌘C, etc. siguen siendo nativos
  e.preventDefault();
  e.stopPropagation();
  run(cmd);
}, { capture: true });

window.mini.onMenu((action) => {
  if (action === 'new')        newTab();
  if (action === 'open')       openFile();
  if (action === 'save')       saveFile(false);
  if (action === 'saveAs')     saveFile(true);
  if (action === 'reloadDisk') reloadFromDisk();
  if (action === 'close')      closeAction();
});

async function reloadFromDisk() {
  if (state.currentTabIndex < 0) return;
  const t = state.tabs[state.currentTabIndex];
  if (!t.path) return; // untitled buffer — nothing to reload
  if (state.dirty) {
    const ok = await window.mini.confirmReload(t.name);
    if (!ok) return;
  }
  const data = await window.mini.readFile(t.path);
  if (!data) return;
  const newState = makeCMState(data.content);
  cmView.setState(newState);
  t.cmState = newState;
  t.baseline = data.content;
  t.dirty = false;
  t.editorOffset = 0;
  t.editorScroll = 0;
  state.baseline = data.content;
  state.dirty = false;
  app.dataset.dirty = 'false';
  if (state.mode === 'editor') {
    editor.innerHTML = mdToHtml(source.value);
    ensureTrailingParagraph();
    editor.scrollTop = 0;
  }
  renderSidebar();
  persistTabs();
  updateMeta();
  updateProgress();
  updateLineInfo();
}

/* Files passed from the OS (mini archivo.md, Finder, drag-onto-dock). */
window.mini.onZoom((delta) => run(delta > 0 ? 'fontUp' : 'fontDown'));

window.mini.onOpenFileFromOS(({ path: p, content }) => {
  addTab(p, content);
});

/* ============================================================
 * Find / Replace
 * ============================================================ */

const findPanel    = document.getElementById('find-panel');
const findInput    = document.getElementById('find-input');
const findReplace  = document.getElementById('find-replace');
const findCounter  = document.getElementById('find-counter');
const findCaseBtn  = document.getElementById('find-case');
const findWordBtn  = document.getElementById('find-word');

const findState = {
  open: false,
  query: '',
  matchCase: false,
  wholeWord: false,
  matches: [],
  index: -1,
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Resolve a character offset in source.value to its on-screen y inside
// the source pane's scroll area (visual top of the rendered line, in
// scroll content coordinates). Uses CodeMirror's own measurement.
function visualYOfSourceOffset(offset) {
  try {
    const c = cmView.coordsAtPos(Math.max(0, Math.min(offset, cmView.state.doc.length)));
    if (!c) return null;
    const containerRect = cmView.scrollDOM.getBoundingClientRect();
    return c.top - containerRect.top + cmView.scrollDOM.scrollTop;
  } catch { return null; }
}

// Editor-mode highlights via CSS Custom Highlight API. Falls back to
// "no visual highlight" if the runtime lacks support — navigation and
// replace still work.
let editorMatchHL = null;
let editorCurrentHL = null;
if (typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights) {
  editorMatchHL   = new Highlight();
  editorCurrentHL = new Highlight();
  CSS.highlights.set('find-match',   editorMatchHL);
  CSS.highlights.set('find-current', editorCurrentHL);
}

function searchedText() {
  return state.mode === 'editor' ? editor.textContent : source.value;
}

function currentCaretOffsetInSearchedText() {
  if (state.mode === 'source') return source.selectionStart;
  const o = getEditorPlainOffset();
  return o == null ? 0 : o;
}

// Walk text nodes of `root` and produce a Range covering [start, end)
// in the concatenated textContent.
function rangeFromTextOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let cum = 0;
  let placedStart = false;
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!placedStart && cum + len >= start) {
      r.setStart(n, start - cum);
      placedStart = true;
    }
    if (placedStart && cum + len >= end) {
      r.setEnd(n, end - cum);
      return r;
    }
    cum += len;
  }
  return null;
}

function clearEditorHighlights() {
  if (editorMatchHL)   editorMatchHL.clear();
  if (editorCurrentHL) editorCurrentHL.clear();
}

function openFind() {
  if (findState.open) {
    findInput.focus();
    findInput.select();
    return;
  }
  findState.open = true;
  findPanel.hidden = false;
  document.body.classList.add('searching');
  // Pre-fill from current selection in whichever pane is active.
  const sel = state.mode === 'editor'
    ? (window.getSelection()?.toString() || '')
    : source.value.substring(source.selectionStart, source.selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  runFind();
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findState.open = false;
  findPanel.hidden = true;
  document.body.classList.remove('searching');
  clearEditorHighlights();
  refreshFindDeco();
  (state.mode === 'editor' ? editor : source).focus();
}

function computeMatches() {
  const q = findInput.value;
  findState.query = q;
  if (!q) { findState.matches = []; findState.index = -1; return; }
  let pattern = escapeRegex(q);
  if (findState.wholeWord) {
    // Unicode-aware whole-word boundary. JS `\b` is ASCII-only and breaks
    // on accented chars and queries that start/end with a non-word char.
    const wordChar = '[\\p{L}\\p{N}_]';
    if (/^[\p{L}\p{N}_]/u.test(q)) pattern = `(?<!${wordChar})${pattern}`;
    if (/[\p{L}\p{N}_]$/u.test(q)) pattern = `${pattern}(?!${wordChar})`;
  }
  const flags = 'gu' + (findState.matchCase ? '' : 'i');
  const matches = [];
  const text = searchedText();
  try {
    const re = new RegExp(pattern, flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  } catch {}
  findState.matches = matches;
  if (matches.length === 0) {
    findState.index = -1;
  } else if (findState.index < 0 || findState.index >= matches.length) {
    const caret = currentCaretOffsetInSearchedText();
    const i = matches.findIndex(m => m.start >= caret);
    findState.index = i >= 0 ? i : 0;
  }
}

function renderFindHL() {
  if (state.mode === 'source') {
    // Source-mode painting is handled by CodeMirror's @codemirror/search
    // (see runFind dispatching setSearchQuery). Just clear any stale
    // editor-mode highlights from a previous mode toggle.
    clearEditorHighlights();
    return;
  }
  // editor mode → CSS Custom Highlight API
  if (!editorMatchHL) return;     // API unsupported — nav still works
  editorMatchHL.clear();
  editorCurrentHL.clear();
  for (let i = 0; i < findState.matches.length; i++) {
    const m = findState.matches[i];
    const r = rangeFromTextOffsets(editor, m.start, m.end);
    if (!r) continue;
    if (i === findState.index) editorCurrentHL.add(r);
    else                       editorMatchHL.add(r);
  }
}

function updateCounter() {
  if (findState.matches.length === 0) {
    findCounter.textContent = findInput.value ? 'No results' : '0/0';
  } else {
    findCounter.textContent = `${findState.index + 1}/${findState.matches.length}`;
  }
}

function gotoMatch(i) {
  if (i < 0 || i >= findState.matches.length) return;
  findState.index = i;
  const m = findState.matches[i];
  if (state.mode === 'source') {
    // Place a zero-width caret at the match start (so the textarea-like
    // selection rectangle doesn't sit on top of our orange `current`
    // decoration), scroll the line into view, and refresh decorations
    // so the new current match repaints.
    cmView.dispatch({
      selection: { anchor: m.start },
      scrollIntoView: true,
      annotations: findRefresh.of(Date.now()),
    });
  } else {
    // Scroll the editor so the current match is visible without taking
    // focus away from the find input.
    const r = rangeFromTextOffsets(editor, m.start, m.end);
    if (r) {
      const rect = r.getBoundingClientRect();
      const pane = editor.getBoundingClientRect();
      if (rect.top < pane.top || rect.bottom > pane.bottom) {
        editor.scrollTop += rect.top - pane.top - editor.clientHeight / 2;
      }
    }
  }
  updateCounter();
  renderFindHL();
}

function runFind() {
  computeMatches();
  updateCounter();
  refreshFindDeco();
  if (findState.matches.length > 0) gotoMatch(findState.index);
  else renderFindHL();
}

function nextMatch() {
  if (findState.matches.length === 0) return;
  gotoMatch((findState.index + 1) % findState.matches.length);
}
function prevMatch() {
  if (findState.matches.length === 0) return;
  gotoMatch((findState.index - 1 + findState.matches.length) % findState.matches.length);
}

function replaceCurrent() {
  if (findState.matches.length === 0 || findState.index < 0) return;
  const m = findState.matches[findState.index];
  const repl = findReplace.value;
  if (state.mode === 'source') {
    // Single targeted change — no full-doc string allocation.
    cmView.dispatch({
      changes: { from: m.start, to: m.end, insert: repl },
      selection: { anchor: m.start + repl.length },
      userEvent: 'input.replace',
    });
  } else {
    const r = rangeFromTextOffsets(editor, m.start, m.end);
    if (!r) return;
    r.deleteContents();
    if (repl) r.insertNode(document.createTextNode(repl));
    syncFromEditor();
  }
  const at = m.start + repl.length;
  computeMatches();
  if (findState.matches.length === 0) {
    findState.index = -1;
    updateCounter();
    renderFindHL();
    return;
  }
  const i = findState.matches.findIndex(x => x.start >= at);
  findState.index = i >= 0 ? i : 0;
  gotoMatch(findState.index);
}

function replaceAll() {
  if (findState.matches.length === 0) return;
  const repl = findReplace.value;
  if (state.mode === 'source') {
    // One transaction with N disjoint changes — CodeMirror handles
    // offset bookkeeping internally and no flat doc string is built.
    cmView.dispatch({
      changes: findState.matches.map((m) => ({ from: m.start, to: m.end, insert: repl })),
      userEvent: 'input.replace',
    });
  } else {
    // Walk in reverse so earlier ranges stay valid.
    for (let i = findState.matches.length - 1; i >= 0; i--) {
      const m = findState.matches[i];
      const r = rangeFromTextOffsets(editor, m.start, m.end);
      if (!r) continue;
      r.deleteContents();
      if (repl) r.insertNode(document.createTextNode(repl));
    }
    syncFromEditor();
  }
  computeMatches();
  updateCounter();
  renderFindHL();
}

// Debounce regex-over-the-whole-doc so typing in the query stays
// Search runs on Enter, not on every keystroke — much friendlier on
// large documents where the regex would otherwise scan the whole text
// after each char typed.
findCaseBtn.addEventListener('click', () => {
  findState.matchCase = !findState.matchCase;
  findCaseBtn.classList.toggle('active', findState.matchCase);
  findInput.focus();
  runFind();
});
findWordBtn.addEventListener('click', () => {
  findState.wholeWord = !findState.wholeWord;
  findWordBtn.classList.toggle('active', findState.wholeWord);
  findInput.focus();
  runFind();
});
document.getElementById('find-prev').addEventListener('click', () => { prevMatch(); findInput.focus(); });
document.getElementById('find-next').addEventListener('click', () => { nextMatch(); findInput.focus(); });
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('find-replace-next').addEventListener('click', () => { replaceCurrent(); findInput.focus(); });
document.getElementById('find-replace-all').addEventListener('click',  () => { replaceAll();     findInput.focus(); });
document.getElementById('find-select-all').addEventListener('click',   () => {
  // Multi-cursor at every match in source mode.
  if (state.mode !== 'source' || findState.matches.length === 0) return;
  const ranges = findState.matches.map((m) => EditorSelection.range(m.start, m.end));
  cmView.dispatch({ selection: EditorSelection.create(ranges, 0) });
  closeFind();
});

findInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  // First Enter (or Enter after editing the query) → run the search;
  // subsequent Enter presses just navigate to next/prev match.
  if (findInput.value !== findState.query) runFind();
  else e.shiftKey ? prevMatch() : nextMatch();
});
findReplace.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
});
// Esc anywhere (panel buttons or inputs, or even when focus is back in
// the textarea) closes the find panel as long as it's open.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && findState.open) {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
}, { capture: true });

// Keep matches in sync with edits in either pane. Coalesce per-frame
// so each keystroke doesn't re-run the regex over the whole document.
let findRescanRAF = 0;
function scheduleFindRescan() {
  if (!findState.open || findRescanRAF) return;
  findRescanRAF = requestAnimationFrame(() => {
    findRescanRAF = 0;
    computeMatches();
    updateCounter();
    renderFindHL();
    refreshFindDeco();
  });
}
// Editor-mode rescan: the source input listener (declared earlier)
// already handles source-mode rescans inline.
editor.addEventListener('input', () => { if (state.mode === 'editor') scheduleFindRescan(); });

source.value = '';
state.baseline = source.value;
updateMeta();
updateProgress();

// Restore the last view mode (source / editor) from the previous run.
try {
  if (localStorage.getItem(VIEW_MODE_KEY) === 'editor') setMode('editor');
} catch {}

// Restore the previously open tabs unless this window was launched
// with ?fresh=1 (Cmd+Shift+N → New Window).
const isFreshWindow =
  new URLSearchParams(window.location.search).get('fresh') === '1';
if (!isFreshWindow) restoreTabs();
