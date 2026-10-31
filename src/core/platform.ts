/**
 * Тонкая прослойка над файловой системой: в Tauri — нативные диалоги и прямая
 * запись на диск, в браузере (vite dev) — <input type=file> и скачивание.
 */
import { APP_NAME } from '../version';

export interface LoadedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function joinPath(dir: string, name: string) {
  return dir.replace(/[\\/]+$/, '') + '/' + name;
}

export async function openFiles(filters: FileFilter[], multiple = true): Promise<LoadedFile[]> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple, filters });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(await Promise.all(files.map(readBrowserFile)));
    };
    input.click();
  });
}

export async function readPath(path: string): Promise<LoadedFile> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  return { name: baseName(path), path, data: await readFile(path) };
}

export async function readBrowserFile(f: File): Promise<LoadedFile> {
  return { name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) };
}

/** Диалог «Сохранить как». Возвращает путь (Tauri) или имя файла (браузер), null — отмена. */
export async function saveFileAs(defaultName: string, data: Uint8Array, filters: FileFilter[]): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: defaultName, filters });
    if (!path) return null;
    await writePath(path, data);
    return path;
  }
  download(defaultName, data);
  return defaultName;
}

export async function writePath(path: string, data: Uint8Array) {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, data);
}

export async function ensureDir(path: string) {
  const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
  if (!(await exists(path))) await mkdir(path, { recursive: true });
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const p = await open({ directory: true, multiple: false });
  return typeof p === 'string' ? p : null;
}

export function download(name: string, data: Uint8Array | Blob) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  } catch {
    // заголовок не критичен
  }
}

export async function confirmDialog(message: string, title = APP_NAME): Promise<boolean> {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }
  return window.confirm(message);
}

/** Подписка на перетаскивание файлов в окно (Tauri отдаёт пути, браузер — File). */
export interface DropModifiers {
  shift: boolean;
  alt: boolean;
}

export async function onFileDrop(cb: (files: LoadedFile[], mods: DropModifiers) => void): Promise<() => void> {
  if (isTauri) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    const { invoke } = await import('@tauri-apps/api/core');
    return getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== 'drop') return;
      // модификаторы спрашиваем сразу — пока пользователь ещё держит клавишу
      const mods = await invoke<DropModifiers>('modifier_keys').catch(() => ({ shift: false, alt: false }));
      cb(await Promise.all(e.payload.paths.map(readPath)), mods);
    });
  }
  const over = (e: DragEvent) => e.preventDefault();
  const drop = async (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) cb(await Promise.all(files.map(readBrowserFile)), { shift: e.shiftKey, alt: e.altKey });
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
  };
}

/**
 * Файлы, открытые из Finder (двойной клик по .pyard, «Открыть с помощью»). Событие лишь будит —
 * пути забираются из очереди Rust, поэтому файл не откроется дважды.
 */
export async function onOpenedFiles(cb: (files: LoadedFile[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const drain = async () => {
    const paths = await invoke<string[]>('take_opened_files');
    if (paths.length) cb(await Promise.all(paths.map(readPath)));
  };
  const un = await listen('open-files', () => void drain());
  await drain();
  return un;
}

/**
 * Печать готовых листов: картинки листов кладутся в скрытый блок, который виден только при печати
 * (@media print), размер страницы — по листу. В программе — системный диалог печати macOS.
 */
export async function printPages(pages: HTMLCanvasElement[], paper: { w: number; h: number }) {
  document.getElementById('print-root')?.remove();
  document.getElementById('print-style')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  const urls: string[] = [];
  for (const c of pages) {
    const blob = await canvasToBlobAsync(c);
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.style.width = `${paper.w}mm`;
    img.style.height = `${paper.h}mm`;
    root.appendChild(img);
    await img.decode().catch(() => {});
  }
  const style = document.createElement('style');
  style.id = 'print-style';
  style.textContent = `
    #print-root { display: none; }
    @page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
    @media print {
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; overflow: visible !important; height: auto !important; }
      body > *:not(#print-root) { display: none !important; }
      #print-root { display: block !important; }
      #print-root img { display: block; page-break-after: always; break-after: page; }
      #print-root img:last-child { page-break-after: auto; break-after: auto; }
    }`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    // диалог печати не блокирует окно — блок печати остаётся до следующей печати
    await invoke('print_webview');
    return;
  }
  window.print();
  root.remove();
  style.remove();
  urls.forEach((u) => URL.revokeObjectURL(u));
}

function canvasToBlobAsync(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось подготовить лист'))), 'image/png'));
}

/**
 * Выход из программы с вопросом о несохранённом. В Tauri — по событию «quit-requested» (⌘Q, Dock)
 * и из меню/кнопки окна; закрывает программу командой quit_app.
 */
export async function quitWithConfirm(dirtyNames: string[]): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  if (dirtyNames.length) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const list = dirtyNames.length > 6 ? `${dirtyNames.slice(0, 6).join(', ')} и ещё ${dirtyNames.length - 6}` : dirtyNames.join(', ');
    const ok = await ask(`Несохранённые изменения: ${list}.\n\nВыйти без сохранения? Изменения пропадут.`, {
      title: 'Выйти из PixelYard?',
      kind: 'warning',
      okLabel: 'Выйти без сохранения',
      cancelLabel: 'Отмена',
    });
    if (!ok) return;
  }
  await invoke('quit_app');
}
