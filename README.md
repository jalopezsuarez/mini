# mini - Minimalist Markdown Editor

**Write without distractions. Publish without friction.**

`mini` is a minimalist Markdown editor for **macOS and Windows**. Built for anyone who needs to write well, fast, and without clutter: notes, documentation, articles, ideas. One window, one font, one thing to do — *write*.

---

## Why you'll like it

- **Zero clutter.** No endless settings, no surprises. Just your text.
- **Two views, one tap.** Switch from raw Markdown to a rendered view with `⌘M`. The same idea, two ways to look at it.
- **Shortcuts where you expect them.** Bold, italic, lists, headers, tables, quotes, code… every gesture you already know, exactly where it should be.
- **Handles big files.** Powered by [CodeMirror 6](https://codemirror.net/) under the hood — open multi-megabyte notes, dumps or logs without freezing. Each tab keeps an independent rope and undo history; switching is instant.
- **Tabs and recents.** A thin left sidebar tracks every file you open. Drag to reorder, click to switch, `⌘W` to close. Resizable. Hidden when you have nothing open.
- **Find and replace.** `⌘F` opens an inline find/replace panel — match case, whole word, navigation, replace one or all, plus *Select* to drop a multi-cursor on every match.
- **Multiple windows.** `⌘⇧N` opens a fresh window — useful for working on two documents side by side.
- **Tables that actually work.** Create them, add rows or columns, delete — all from the keyboard. Tab walks cell by cell.
- **Auto-numbered headers.** `⌘⇧H` numbers your sections automatically (1., 1.1, 1.1.1…). Perfect for technical docs, manuals, or reports.
- **Your typography, your style.** Drop a font or a CSS file into the `theme/` folder and `mini` picks it up. No code required.
- **Launch from the terminal.** Install the `mini` command with one click and open any file with `mini notes.md`.
- **Native to your OS.** Double-click any `.md` from Finder or Explorer and it opens. Like any app that respects its place.
- **Lightweight.** Fast to start, small footprint, no accounts, no phoning home.

## Who it's for

- **Writers and editors** who want a clean canvas and impeccable Markdown.
- **Technical teams** who document in `.md` and need tables, code, and numbered headers without fighting their editor.
- **Students and researchers** who take notes in Markdown and export wherever they need.
- **Anyone tired** of bloated editors that take longer to open than to close.

## Essential shortcuts

> On Windows, use `Ctrl` wherever the table shows `⌘`.

| Action                         | Shortcut            |
| ------------------------------ | ------------------- |
| Toggle view (source/render)    | `⌘M`                |
| Find / replace                 | `⌘F`                |
| Header (cycle levels)          | `⌘H`                |
| Numbered header                | `⌘⇧H`               |
| Bold / Italic / Underline      | `⌘B` / `⌘I` / `⌘U`  |
| Bullet / Numbered list         | `⌘L` / `⌘K`         |
| Quote / Code                   | `⌘D` / `⌘R`         |
| Horizontal rule                | `⌘P`                |
| Table (new or add row)         | `⌘T`                |
| Delete row                     | `⌘⇧T`               |
| Add / remove column            | `⌘G` / `⌘⇧G`        |
| Increase / decrease font size  | `⌘+` / `⌘-`         |
| New tab / New window           | `⌘N` / `⌘⇧N`        |
| Open / Save / Save As          | `⌘O` / `⌘S` / `⌘⇧S` |
| Close tab                      | `⌘W`                |

---

## Technical overview

`mini` is a desktop app built with [Electron](https://www.electronjs.org/), shipped for **macOS** (Apple Silicon and Intel) and **Windows x64**. The renderer is plain ES modules, with [CodeMirror 6](https://codemirror.net/) for the source editor; the rest of the UI (sidebar, find panel, toolbar, theming) is hand-written, dependency-free.

### Project structure

```
mini/
├── main.js                     Electron main process (window, menus, IPC, CLI)
├── preload.js                  Secure bridge between main and renderer
├── src/
│   ├── index.html
│   ├── styles.css
│   ├── renderer.js             Renderer source (ESM imports CodeMirror)
│   └── renderer.bundle.js      Built bundle (gitignored, produced by esbuild)
└── theme/                      User-customizable fonts and CSS
```

### Requirements

- macOS (Apple Silicon or Intel) or Windows 10+ x64
- Node.js 18+ and npm (development only)

### Development

```bash
npm install
npm start          # builds the renderer bundle, then launches Electron
npm run watch      # rebuild on every save (in another terminal)
```

`npm start` automatically runs `npm run build` (esbuild bundles `src/renderer.js` + CodeMirror into `src/renderer.bundle.js`).

### Packaging the app

```bash
# macOS — Apple Silicon
npm run package

# macOS — Intel x64
npm run package:intel

# macOS — Universal (Intel + Apple Silicon)
npm run package:universal

# Windows x64
npm run package:win
```

The resulting bundle ends up in `dist/`.

### `mini` terminal command  *(macOS only)*

On first launch, the app offers to install `/usr/local/bin/mini` so you can run it from the shell:

```bash
mini                # open the app
mini notes.md       # open a file
```

---

## Customize your mini

`mini` is designed to let you decide how it looks. All visuals live in the `theme/` folder, completely separated from the app code. Edit a couple of CSS files, drop in a font, and you're done — restart the app and your changes take effect.

> **Where to find the `theme/` folder:**
> - In development: `theme/` at the project root.
> - In the installed app (macOS): `/Applications/mini.app/Contents/Resources/app/theme/`
>   (right-click `mini.app` → *Show Package Contents*).
> - In the installed app (Windows): `mini-win32-x64\resources\app\theme\` next to `mini.exe`.

### Two views, two themes

`mini` has two views, and each one has its own stylesheet. You can give them distinct personalities — for example, mono and technical for writing, serif and elegant for reading.

| File                     | What it controls                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| `theme/theme.source.css` | **Source** view (raw Markdown with token highlighting).           |
| `theme/theme.editor.css` | **Editor** view (rendered Markdown: headings, quotes, etc.).      |

Selectors you write in each file apply **only to their pane**. The same goes for `:root` variables — they don't leak between views.

### Changing colors

Each theme exposes a palette of CSS variables under `:root`. Edit them and you'll see the change immediately (after a restart):

**`theme.source.css` — source view**

```css
:root {
  --bg:        #252524;   /* pane background */
  --fg:        #e7e5e2;   /* base text */
  --fg-dim:    #8b8782;   /* dim text, placeholder */
  --accent:    #c96442;   /* accent (caret, emphasis) */
  --selection: #3a3633;   /* selection color */
  --caret:     #c96442;   /* caret color */
}
```

And the **highlight tokens** (headers, lists, quotes, code, emphasis):

```css
.hl-h  { color: #68ecec; }   /* # headers */
.hl-l  { color: #73b7fb; }   /* - * + 1. list markers */
.hl-q  { color: #f27d86; }   /* > quotes */
.hl-c  { color: #9fe872; }   /* ` ``` code */
.hl-em { color: #ca7def; }   /* **bold** *italic* */
```

**Find / replace match colors** (variables, work in both source and rendered view):

```css
:root {
  --find-bg:         #ffff4c;   /* all matches background */
  --find-fg:         #000000;   /* all matches foreground */
  --find-current-bg: #fd9845;   /* current match background */
  --find-current-fg: #000000;   /* current match foreground */
}
```

**`theme.editor.css` — rendered view**

```css
:root {
  --bg:        #1f1e1d;   /* background */
  --bg-soft:   #262624;   /* block backgrounds (pre, th) */
  --bg-code:   #2a2826;   /* inline code background */
  --fg:        #fafaf9;   /* text */
  --fg-dim:    #8b8782;   /* secondary text */
  --heading:   #fafaf9;   /* headings */
  --accent:    #c96442;   /* links, markers, caret */
  --rule:      #3a3735;   /* borders and separators */
  --quote-bar: #c96442;   /* blockquote side bar */
}
```

### Changing fonts

**Step 1 — add the file.** Drop any `.ttf`, `.otf`, `.woff`, or `.woff2` into `theme/`. `mini` registers it automatically at startup, using the **filename (without extension)** as the `font-family`.

```
theme/
├── Inter.ttf            → font-family: 'Inter'
├── JetBrainsMono.ttf    → font-family: 'JetBrainsMono'
├── sf-mono.ttf          → font-family: 'sf-mono'      (bundled by default)
└── copernicus.ttf       → font-family: 'copernicus'   (bundled by default)
```

**Step 2 — use it in the theme.** Each CSS file exposes typography variables:

```css
/* theme.source.css */
:root {
  --mono: 'sf-mono', ui-monospace, monospace;
}

/* theme.editor.css */
:root {
  --serif: 'copernicus', -apple-system, system-ui, sans-serif;
  --sans:  'copernicus', -apple-system, system-ui, sans-serif;
  --mono:  'sf-mono',    ui-monospace, monospace;
}
```

Need multiple weights? Drop `Inter-Regular.ttf` and `Inter-Bold.ttf` and group them under one family with `@font-face`:

```css
@font-face {
  font-family: 'Inter';
  src: url('theme://Inter-Regular.ttf');
  font-weight: 400;
}
@font-face {
  font-family: 'Inter';
  src: url('theme://Inter-Bold.ttf');
  font-weight: 700;
}
```

> The `theme://` scheme points to your `theme/` folder. Use it to link fonts, background images, or any asset from CSS.

### Size, line height, and details

Beyond colors and fonts, you can tweak any standard CSS property:

```css
/* theme.editor.css */
html, body {
  font-size: 16px;        /* base size */
  line-height: 1.8;       /* line spacing */
}

h1 { font-size: 2.2em; border-bottom: 2px solid var(--accent); }
blockquote { font-style: normal; border-left-width: 4px; }
pre { border-radius: 12px; }
```

In the source view you can also tune character spacing, ligatures, and more:

```css
/* theme.source.css */
html, body {
  font-size: 14px;
  line-height: 1.7;
  letter-spacing: 0.01em;
  font-feature-settings: "liga" 1, "calt" 1;   /* enable ligatures */
}
```

### Apply the changes

Save the files and **restart `mini`** (`⌘Q` and reopen). The theme loads at startup.

### Starting from scratch

The bundled `theme.source.css` and `theme.editor.css` are the best reference: they're commented and show every available variable. Copy them, change them, break things — you can always go back to the originals.

---

## License

To be defined.
