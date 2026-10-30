import { useEffect } from 'react';
import * as A from './actions';
import { addSpriteFiles, installAtlasSync, newAtlasFromFiles } from './atlasActions';
import { isAtlas } from './core/atlasDoc';
import { confirmDialog, isTauri, onFileDrop, onOpenedFiles, setWindowTitle } from './core/platform';
import { adjustSize, cycleTool, eventShortcut, findShortcut } from './menu';
import { activeDoc, app, openDialog, useApp } from './store';
import { cycleTab } from './panes';
import { APP_NAME, APP_TITLE, APP_VERSION } from './version';
import { effectiveTool } from './tools';
import { Dialogs } from './ui/Dialogs';
import { MenuBar } from './ui/MenuBar';
import { TabDragLayer, Workspace } from './ui/Panes';
import { OptionsBar } from './ui/OptionsBar';
import { Sidebar } from './ui/Sidebar';
import { StatusBar } from './ui/StatusBar';
import { Toolbox } from './ui/Toolbox';
import { isTyping } from './ui/Viewport';

function handleKey(e: KeyboardEvent) {
  const s = app();
  if (s.dialog || s.busy) return;
  if (isTyping()) return;
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    return void cycleTab(e.shiftKey ? -1 : 1);
  }
  const doc = activeDoc();
  // сначала — активный инструмент (Enter/Esc/стрелки/Delete в своём контексте)
  if (doc && !e.metaKey && !e.ctrlKey && effectiveTool(s.tool).key?.(e, doc)) {
    e.preventDefault();
    return;
  }
  const sc = eventShortcut(e);
  const item = findShortcut(sc) ?? (sc === 'Shift+Mod+=' ? findShortcut('Mod+=') : null);
  if (item) {
    e.preventDefault();
    if (!item.enabled || item.enabled()) item.action();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.code === 'BracketLeft') return void adjustSize(-1);
  if (e.code === 'BracketRight') return void adjustSize(1);
  if (k === 'x' && !e.shiftKey) return void A.swapColors();
  if (k === 'd' && !e.shiftKey) return void A.resetColors();
  const code = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : k;
  if (cycleTool(code)) e.preventDefault();
}

function EmptyState() {
  return (
    <div className="empty">
      <h2>
        {APP_NAME} <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 14 }}>{APP_VERSION}</span>
      </h2>
      <div className="row">
        <button className="btn primary" onClick={() => openDialog({ kind: 'new' })}>Новый документ</button>
        <button className="btn" onClick={() => void A.openDocuments()}>Открыть…</button>
        <button className="btn" onClick={() => void A.paste()}>Вставить из буфера</button>
        <button className="btn" onClick={() => void newAtlasFromFiles()}>Новый атлас из картинок…</button>
      </div>
      <div className="hint">или перетащите файлы в окно — PNG, JPG, WebP, PSD, TIFF, TGA, GIF, BMP, проекты .pyard…</div>
    </div>
  );
}

export function App() {
  const toast = useApp((s) => s.toast);
  const busy = useApp((s) => s.busy);
  useApp((s) => s.tick);
  const doc = activeDoc();
  const title = doc ? `${doc.name}${doc.dirty ? ' •' : ''} — ${APP_TITLE}` : APP_TITLE;

  useEffect(() => {
    void setWindowTitle(title);
  }, [title]);

  useEffect(() => installAtlasSync(), []);

  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    void onOpenedFiles((files) => void A.openLoadedFiles(files)).then((u) => (cancelled ? u() : (un = u)));
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onFileDrop((files) => {
      // проекты открываются всегда; в атлас картинки добавляются спрайтами,
      // в открытый документ — слоями, иначе открываются новыми документами
      const projects = files.filter((f) => /\.pyard$/i.test(f.name));
      if (projects.length) void A.openLoadedFiles(projects);
      files = files.filter((f) => !/\.pyard$/i.test(f.name));
      if (!files.length) return;
      if (isAtlas(activeDoc())) void addSpriteFiles(files);
      else if (activeDoc()) void A.placeFiles(files);
      else void A.openLoadedFiles(files);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (app().docs.some((d) => d.dirty)) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);

    let unlistenClose: (() => void) | null = null;
    if (isTauri) {
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        const u = await w.onCloseRequested(async (ev) => {
          const dirty = app().docs.filter((d) => d.dirty);
          if (!dirty.length) return;
          ev.preventDefault();
          const ok = await confirmDialog(`Есть несохранённые изменения (${dirty.map((d) => d.name).join(', ')}). Выйти без сохранения?`);
          if (ok) await w.destroy();
        });
        if (cancelled) u();
        else unlistenClose = u;
      })();
    }
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('beforeunload', beforeUnload);
      unlisten?.();
      unlistenClose?.();
    };
  }, []);

  return (
    <div className="app">
      <MenuBar />
      <OptionsBar />
      <div className="workspace">
        <Toolbox />
        <Workspace empty={<EmptyState />} />
        <Sidebar />
      </div>
      <StatusBar />
      <Dialogs />
      <TabDragLayer />
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      {busy && (
        <div className="busy">
          <div>{busy}</div>
        </div>
      )}
    </div>
  );
}
