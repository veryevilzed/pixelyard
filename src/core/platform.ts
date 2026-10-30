/**
 * Тонкая прослойка над файловой системой: в Tauri — нативные диалоги и прямая
 * запись на диск, в браузере (vite dev) — <input type=file> и скачивание.
 */
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

export async function confirmDialog(message: string, title = 'PhotoEdit'): Promise<boolean> {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }
  return window.confirm(message);
}

/** Подписка на перетаскивание файлов в окно (Tauri отдаёт пути, браузер — File). */
export async function onFileDrop(cb: (files: LoadedFile[]) => void): Promise<() => void> {
  if (isTauri) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type === 'drop') cb(await Promise.all(e.payload.paths.map(readPath)));
    });
  }
  const over = (e: DragEvent) => e.preventDefault();
  const drop = async (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) cb(await Promise.all(files.map(readBrowserFile)));
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
  };
}
