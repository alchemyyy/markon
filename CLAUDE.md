# CLAUDE.md

Notes for future Claude sessions working on **markon** — a markdown editor that started as a PWA and now also ships as a Tauri 2 desktop app. Read this first.

---

## What this app is

A live-preview Markdown editor built on:

- **CodeMirror 6** for the editor (`src/core.js`)
- **marked** + **highlight.js** for the rendered preview (`src/preview.js`, `src/syntax.js`)
- **Vite** + **vite-plugin-pwa** for the web bundle
- **Tauri 2** for the desktop wrapper (`src-tauri/`)

The web build is still a working PWA. The Tauri build adds native file/folder access, file associations, CLI args, and a sidebar file tree.

---

## Top-level architecture

```
main.js
 ├── createEditor()          (core.js)              — CodeMirror view, undo history, autoscroll
 ├── initUI()                (ui.js)                — toolbar buttons, hotkeys, settings, preview, sync
 ├── createDocsStore()       (docs.js)              — tab state, persistence, save/load orchestration
 ├── createTabBar()          (tabs.js)              — pointer-driven tab UI with live reorder
 ├── createFileTree()        (tree.js)              — folder tree, mtime stats, fs-watcher
 └── createRecentDropdown()  (recent-ui.js)         — recent-files popover
```

Cross-module wiring lives on `window.*` (legacy convention from before the docs store): `window.docs`, `window.fileTree`, `window.recentDropdown`, `window.showToast`, `window.setLineNumbers`, `window.editorSync`, etc. New modules can keep using this pattern; rewriting it is out of scope.

---

## Documents / tabs (`src/docs.js`) — the core invariant

There is **always at least one tab**. Closing the last tab seeds a fresh `Untitled` automatically.

A "doc" is `{ id, path, name, content, savedContent }`. `path` is `null` for untitled tabs. Dirty = `content !== savedContent`. Per-doc dirty state is mirrored into a `dirtyIds: Set` so we don't have to scan all tabs on every keystroke.

**Persistence**: a JSON snapshot of `{ tabs, activeId }` lives at `localStorage['markon-tabs-v1']`, debounced 600ms, flushed on `beforeunload` and `visibilitychange`. On boot, if the v1 key is missing, the boot path falls back to reading the legacy IndexedDB blob (`markon-storage` DB, `markon-content` key) so users from before the tabs migration don't lose their content. `src/storage.js` and `src/worker.js` are the old single-doc IndexedDB layer — no longer wired up but kept for that fallback to read from. Do not re-enable them as a writer.

**Notify discipline**: `notify()` fires subscribers + persists. `updateActiveContent()` (called on every keystroke) only fires `notify()` when the dirty bit *flips*; otherwise it just calls `schedulePersist()`. This keeps the tab bar and the file tree from re-rendering on every character typed.

**Switching tabs uses `suppressEditorSync`**: `switchTo()` calls `editor.setContent(doc.content)`, which fires the editor's update listener, which calls `updateActiveContent` — which would clobber the new doc's content with itself. The flag breaks that loop.

---

## Native vs. web (`src/native.js`)

`isTauri()` checks `'__TAURI_INTERNALS__' in window`. Every native function (`saveAs`, `saveToPath`, `readFileAt`, `openFolder`, `readDirEntries`, `watchPath`, `getCliArgs`, etc.) short-circuits gracefully when not in Tauri:

- `openText` / `openCSS` fall through to hidden `<input type="file">` via `utils.js`
- `saveAs` falls through to `downloadText` (anchor click)
- `readFileAt`, `openFolder`, `readDirEntries`, `watchPath`, `getCliArgs` all return `null` or `[]`

This means the same `docs.openViaDialog()` / `docs.save()` code paths work in PWA and Tauri.

`@tauri-apps/*` plugin imports are dynamic (`await import(...)`) so they tree-shake out of the web bundle.

---

## Tauri configuration (`src-tauri/`)

- `Cargo.toml`: `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-cli` (all v2)
- `src/lib.rs`: registers all three plugins
- `tauri.conf.json`:
  - `productName: markon`, identifier `com.getmarkon.markon`
  - Window: 1200×800 default, 600×400 min
  - `bundle.fileAssociations` for `.md` / `.markdown` / `.mdown` / `.mkd`
  - `plugins.cli.args[]` declares a positional `files` arg with `multiple: true` (and **no** `multipleOccurrences` — that key was rejected by the v2 schema)
- `capabilities/default.json` grants:
  - `dialog:allow-open`, `dialog:allow-save`
  - `fs:allow-read-text-file`, `fs:allow-write-text-file`, `fs:allow-read-dir`, `fs:allow-stat`, `fs:allow-watch` (all `path: "**"`)
  - `cli:default`
  - `core:window:allow-set-title`

Whenever you add a new Tauri permission, **the user must restart `npm run tauri:dev`** — capabilities are baked in at startup.

`npm run tauri:build` produces installers under `src-tauri/target/release/bundle/`. First build pulls/compiles ~400 Rust crates (5–10 min); incremental is ~30–60s.

---

## File tree (`src/tree.js`) — non-obvious behaviors

- The tree column lives in `#wrap`'s grid as `var(--tree-w, 0px)`. When a folder is open, `tree.js` sets `--tree-w` inline on `<html>` from the persisted width and adds `html.tree-open`. When closed, it removes the inline property and the column collapses to 0px.
- **Width is user-resizable** via a 24px-wide handle (`.tree-resize-handle`) overhanging the right edge. Persisted to `localStorage['markon-tree-w']`, clamped 140–600.
- **Watchers are per-expanded-folder, non-recursive**: a `Map<path, stopFn>`. Expand → start a non-recursive `watch()`. Collapse → unwatch the folder *and any expanded descendants*. Close folder → stop all. This avoids the "recursive watcher on `node_modules`" pitfall.
- All FS events are debounced 250ms before triggering `rebuild()`, on top of Tauri's 100ms native delay.
- Each row is `[leading-slot] [icon] [name]`. The leading slot holds either:
  - A chevron (for dirs)
  - A compact age stamp (for files; format below)
  - A `●` (when the file is dirty — overrides the age via `font-size: 0` + `::after`)
  - Nothing if the user disabled timestamps via the clock toggle

**Age formatter** (`fmtAge` in tree.js):

| Range          | Format    | Example  |
| -------------- | --------- | -------- |
| < 1h           | `XXm`     | `09m`    |
| 1h–9h59m       | `XhYY`    | `1h09`, `9h55` |
| 1h–9h59m, 0m   | `Xh`      | `1h`     |
| 10h–23h        | `XXh`     | `23h`    |
| 1d–9d, 0h      | `Xd`      | `1d`     |
| 1d–9d, with h  | `XdYY`    | `1d10`   |
| ≥10d           | `XXd`     | `50d`    |

All output is left-padded with **non-breaking spaces** (`\u00A0`) to a minimum of 4 character cells, so columns line up in a tabular-nums font. Plain spaces would collapse under `white-space: nowrap`.

**Sort modes**: `name` (default) and `mtime`. Header has a static sort icon that opens a popup menu (`.tree-sort-menu`) — *not* a cycle. Persists to `localStorage['markon-tree-sort']`. Sorting by mtime requires `fs.stat` per entry, which `readDirEntries` already does (fanned out via `Promise.all`).

---

## Tabs (`src/tabs.js`) — drag/reorder model

**Pointer events, not HTML5 drag.** The HTML5 drag API is unreliable in WebView2; we use `pointerdown` + `window`-level `pointermove` / `pointerup` instead.

Click vs drag distinction: under `DRAG_THRESHOLD` (4 px) of movement = click (tab switch); past it = drag. The trailing click event after a real drag is suppressed via a 150ms timestamp guard (`lastDragEndAt`).

**Live reorder**: while dragging, `applyShifts()` translates all *other* tabs left/right by exactly one tab-width to open up the destination slot. The dragged tab follows the cursor via inline `transform`. State is *not* mutated until `pointerup` — `docs.reorder()` is called once at drop. Render() then replaces all tab elements naturally clearing every inline transform.

**Reorder threshold (`REORDER_OVERLAP = 0.25`)**: a slot of reorder fires when the dragged tab has been displaced by ≥25% of its width. Each additional full tab-width past that triggers another slot. Symmetric for left/right, independent of where on the tab the user grabbed.

Render-during-drag safety: `onMove` checks `bar.contains(drag.el)` and aborts cleanly if a structural notify swapped the element out underfoot.

---

## Editor (`src/core.js`)

- **Undo history**: `history({ minDepth: 10000 })` from `@codemirror/commands` is wired in explicitly. Without it, you'd get the WebView's contentEditable native undo (caps at ~100). Also include `historyKeymap` in the keymap so Ctrl+Z works.
- **Line numbers** are wrapped in a `Compartment` so they can be toggled live via `window.setLineNumbers(bool)`. State persists to `localStorage['markon-line-numbers']` (default on).
- **Drag-selection autoscroll**: CM6's built-in is glacially slow. We attach our own rAF-driven `attachFastAutoscroll(view)` on top of CM's. Constants:
  - `AUTOSCROLL_TOP_ZONE = 80px` (fixed) — top trigger zone
  - `AUTOSCROLL_BOTTOM_ZONE_RATIO = 0.06` (proportional) — bottom 6% of scroller height; this matters for fullscreen
  - `AUTOSCROLL_BASE = 2`, `AUTOSCROLL_RAMP = 0.18`, `AUTOSCROLL_MAX = 28` (px/frame)
- **Editor scrollbar side** is class-driven on `<html>`: default is right (no class); `html.editor-scrollbar-left` flips `.cm-scroller` to `direction: rtl` + `flex-direction: row-reverse` and restores `direction: ltr` on `.cm-content`/`.cm-gutters`/`.cm-line`. Toggled by the "Editor scrollbar on the left" preference. `applyScrollbarSide()` runs *before* `createEditor()` in `main.js` so the scroller mounts on the right side from the first frame.

---

## Layout (`index.html` + `src/components.css`)

`<body>` is a vertical flex column:

```
#bar              — fixed top toolbar (no auto-hide; the previous #bar.open class is gone)
#tab-bar-slot     — full-width row, populated by tabs.js
#wrap             — grid: var(--tree-w, 0px) | 1fr | 14px | <preview-w>
                    children: #tree-sidebar | #editor | #split | #preview
```

The previous `#editor-col` wrapper around tab-bar+editor is gone; tabs span the full window now (above the tree, editor, *and* preview).

`#wrap`'s `grid-template-columns` is **mutated by JS in two places**: `setPreviewWidth()` in `resize.js` (preview/editor split) preserves the leading `var(--tree-w)` column. Don't drop it when touching that function — it'll re-break the layout the same way it broke earlier this session.

Default split: 60% editor / 40% preview, computed as `Math.round((wrap.width - 14) * 0.4)` on first paint.

---

## Top toolbar (`src/actions.js`)

Buttons are declared in `ACTIONS_CONFIG`. Order in the array = order in the toolbar. Current toolbar order: `Open → Open Folder → Save → Save All → Recent → Sync Scroll → Install → Settings → (Theme, hidden by default)`.

`HIDEABLE_TOOLBAR_BUTTONS` is the small registry of buttons users can toggle from the Settings → Preferences section. Each entry: `{ id, key, defaultOn }`. Currently only `toggle-theme` is in the list, with the human-readable label in `PREF_LABELS` in `settings.js`.

Hotkeys: `hotkeys.js` builds a modifier string in **`ctrl + alt + shift`** order. Match that order when declaring hotkeys in `ACTIONS_CONFIG`.

Hidden actions (those with `showInToolbar: false`) still get triggered correctly via hotkey: `hotkeys.js` falls back to invoking the handler directly if the corresponding DOM element doesn't exist.

**Tooltip clip avoidance** lives in `ui.js` after `createButtons`: a delegated `mouseover` handler measures each tooltip's would-be position from `btn.getBoundingClientRect()` + `tip.offsetWidth` (NOT a getBoundingClientRect on the tooltip — that includes any leftover transform from a previous hover), and shifts via inline `transform: translateX(...)` so the tooltip stays an 8px margin away from either screen edge. Re-runs every hover so it adapts to window resize.

---

## Settings (`src/settings.js`)

Three sections, in order: **Preferences** (toggleable booleans), **Themes** (theme picker grid + custom CSS upload), **Actions** (the actions grid with hotkey badges).

Preferences currently:
1. Show light/dark mode toggle in toolbar (`HIDEABLE_TOOLBAR_BUTTONS` driven)
2. Show line number gutter in editor (`window.setLineNumbers`)
3. Editor scrollbar on the left (`setScrollbarLeft`)

Default theme: `github` (changed from `solarized` / `tokyo-night`). Both `getPrefTheme` and the `applyTheme` validation fallback in `utils.js` use `github`.

---

## Confirm-on-close modal (`src/confirm-close.js`)

Custom 3-way modal (Save / Discard / Cancel) replaces native `confirm()` in `docs.close()`. Save runs through the existing `docs.save()` flow — if save fails or the user cancels Save-As, the close is aborted. ESC / backdrop click / Cancel all resolve to `'cancel'`.

`docs.close()` is **async** because of this. After `await`-ing the dialog, it re-finds the tab index in case state shifted while the modal was open. Don't call `docs.close()` synchronously expecting it to complete.

---

## Service worker gotcha (Tauri WebView2)

The PWA service worker registered in earlier dev sessions persists across Tauri app restarts (WebView2 has its own per-user storage). It will keep serving stale `index.html` even after the file on disk changes — symptom: a feature that depends on new HTML structure mysteriously doesn't apply.

Mitigations in place:
1. `vite.config.js` → `devOptions: { enabled: false }` — no new SW registers in dev
2. `main.js` → `killStaleServiceWorker()` runs at top of `boot()` to unregister any lingering SW + clear caches, then reload once

If the user reports "I changed the HTML, restarted, and it's still wrong", the kill switch may not have run yet because the cached HTML doesn't reference the latest `main.js`. Have them manually unregister via DevTools → Application → Service Workers → Unregister.

---

## Things that look like bugs but aren't

- **No mtime in `readDir()`**: Tauri's `fs.readDir` doesn't include mtime. We `stat` each entry separately inside `readDirEntries` (Promise.all'd). Hence the `fs:allow-stat` permission. Don't try to refactor this away — it's necessary.
- **Preview pane initial width** comes from `createPreviewManager` in `resize.js`, which reads `wrap.getBoundingClientRect().width` on init. If `#wrap` hasn't been laid out yet when this runs, the calculation defaults to `window.innerWidth`. Currently it works because `createEditor` (sync layout via CodeMirror mount) runs before `initUI`. Don't reorder these.
- **`docs.boot()` runs after `initUI`** so the editor exists; the boot path may call `setMarkdown` on the freshly-created editor.

---

## Deferred features

See `DEFERRED_FEATURES.md` for two pulled-out features with full implementation notes:
1. **Pop-out tabs to new windows** (Chrome-style detach) — needs Tauri multi-window + per-tab state transfer + drag-out detection
2. ~~File-tree mtime display~~ — implemented in this session (the `fmtAge` system in `tree.js`)

The mtime section is now historical; the pop-out section is still relevant.

See also `BLUR_EFFECTS.md` for an audit of the remaining `backdrop-filter: blur(...)` calls (these are frosted-glass surfaces, not the symmetric "glow" halos that were stripped earlier).

---

## Style / convention notes that bit us

- **Top bar padding is asymmetric**: `padding: 0 16px 0 0` (right only). `#actions` has no left padding so toolbar buttons sit flush to the screen's left edge. The brand logo on the right has its own `padding-right: 16px` *on top of* the bar's 16px right padding. Don't collapse these into a symmetric value — the user explicitly wanted controls flush left.
- **Glow-style effects (0,0-offset symmetric halos) were removed** in an earlier pass. Don't reintroduce `text-shadow: 0 0 ...` or `box-shadow: 0 0 ...` with colored halos. Drop shadows with offset (e.g., `0 4px 12px ...`) are fine.
- **Tabs use `cursor: grab`** (not `pointer`) and `touch-action: none` so trackpad scrolls don't cancel a drag.
- **Settings dialog and other popovers use `dialog[open]`** native HTML, not custom z-index stacking. Toast moves into the open dialog so it can render above the backdrop.

---

## Build / dev commands

```bash
npm run dev         # Vite dev server (web only)
npm run build       # production web bundle
npm run tauri:dev   # Vite + Tauri dev (requires Rust + WebView2 on Windows)
npm run tauri:build # MSI/NSIS/dmg/AppImage installers
```

Lint: `npm run check` (Biome) / `npm run fix` (auto-fix). Biome reorders imports — expect that.
