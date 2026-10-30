import { alphaBounds, canvasToBlob, cloneCanvas, createCanvas, cropCanvas, ctx2d, intersectRect, rgbaToCss, scaleCanvas, uid } from './core/canvas';
import { Doc } from './core/doc';
import { FILTERS, type Params } from './core/filters';
import { decodeFile, decodeToCanvas, encodeCanvas, encodePsd, fileStem, formatFromName, OPEN_FILTERS } from './core/io';
import { baseName, confirmDialog, isTauri, openFiles, saveFileAs, writePath, type LoadedFile } from './core/platform';
import { nextZoom, RULER, zoomAt } from './core/render';
import {
  combineSelection, featherSelection, growSelection, invertSelection, maskedCopy, selectAll, selectionFromAlpha, selectionFromMask, blendThroughSelection,
} from './core/selection';
import { blendToComposite, renderLayer } from './core/composite';
import { colorRangeMask } from './core/flood';
import { DEFAULT_EFFECTS, type Layer, type Rect, type RGBA, type SelectMode, type Slice } from './core/types';
import { piecesAsSlices } from './tools/knife';
import { activeDoc, app, closeDialog, openDialog, setBg, setFg, setOpts, setPrefs, toast, useApp, type ToolId } from './store';
import { definePattern, tiled, usePatterns } from './core/patterns';
import { changed } from './tools/base';
import { TOOLS } from './tools';
import { cancelTransform, startTransform, transformActive, type TransformMode } from './tools/transform';
import { clearPaintHover } from './tools/paint';
import { useCrop } from './tools/crop';
import { detachLinked, ownerAtlas, saveAtlasProject } from './atlasActions';
import { buildIconFiles, DEFAULT_ICON } from './core/icons';
import { isAtlas } from './core/atlasDoc';
import { activateDoc, addDocToFocused, focusPane, removeDocFromPanes, sizeForDoc } from './panes';

// ---------- документы ----------

/** Размер области, где показан активный документ. */
const viewportSize = () => sizeForDoc(app().activeId);

export function addDoc(doc: Doc) {
  // вид подгоняется при первой отрисовке — по размеру своей области
  doc.needsFit = true;
  useApp.setState((s) => ({ docs: [...s.docs, doc] }));
  addDocToFocused(doc.id);
  changed();
}

export function switchDoc(id: string) {
  if (app().activeId === id) return;
  deactivateTool();
  activateDoc(id);
  changed();
}

/** Фокус на другую область (клик в неё): незавершённые операции инструмента закрываются. */
export function focusPaneAction(paneId: string) {
  if (app().focusedPane === paneId) return;
  deactivateTool();
  focusPane(paneId);
  changed();
}

export async function closeDoc(id: string) {
  const s = app();
  const doc = s.docs.find((d) => d.id === id);
  if (!doc) return;
  // правки связанной вкладки уже в атласе — картинка и слои остаются в нём
  if (doc.link && ownerAtlas(doc)) detachLinked(doc);
  else if (doc.dirty && !(await confirmDialog(`Закрыть «${doc.name}» без сохранения изменений?`))) return;
  if (doc.id === s.activeId) deactivateTool();
  removeDocFromPanes(id);
  useApp.setState({ docs: s.docs.filter((d) => d.id !== id) });
  changed();
}

export function newDocument(name: string, w: number, h: number, fill: 'transparent' | 'white' | 'bg' | 'fg') {
  const doc = new Doc(name, w, h);
  const c = doc.newLayerCanvas();
  if (fill !== 'transparent') {
    const ctx = ctx2d(c);
    ctx.fillStyle = fill === 'white' ? '#fff' : rgbaToCss(fill === 'bg' ? app().bg : app().fg);
    ctx.fillRect(0, 0, w, h);
  }
  const layer = doc.makeLayer(fill === 'transparent' ? 'Слой 1' : 'Фон', c);
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  addDoc(doc);
}

async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  useApp.setState({ busy: label });
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e instanceof Error ? e.message : String(e), 'error');
    return undefined;
  } finally {
    useApp.setState({ busy: null });
  }
}

export async function openLoadedFiles(files: LoadedFile[]) {
  for (const f of files) {
    await withBusy(`Открытие ${f.name}…`, async () => addDoc(await decodeFile(f)));
  }
}

export async function openDocuments() {
  const files = await openFiles(OPEN_FILTERS);
  await openLoadedFiles(files);
}

/** «Поместить»: файлы добавляются слоями в текущий документ. */
export async function placeFiles(files?: LoadedFile[]) {
  const doc = activeDoc();
  if (!doc) return openLoadedFiles(files ?? (await openFiles(OPEN_FILTERS)));
  const list = files ?? (await openFiles(OPEN_FILTERS));
  for (const f of list) {
    await withBusy(`Импорт ${f.name}…`, async () => {
      const img = await decodeToCanvas(f);
      addImageAsLayer(doc, img, fileStem(f.name));
    });
  }
}

/** Слой с картинкой по центру видимой области (или в начале координат, если не помещается). */
export function addImageAsLayer(doc: Doc, img: HTMLCanvasElement, name: string, at?: { x: number; y: number }) {
  const c = doc.newLayerCanvas();
  const x = at?.x ?? Math.round((doc.width - img.width) / 2);
  const y = at?.y ?? Math.round((doc.height - img.height) / 2);
  ctx2d(c).drawImage(img, Math.max(x, img.width > doc.width ? 0 : x), Math.max(y, img.height > doc.height ? 0 : y));
  doc.addLayer(doc.makeLayer(name, c), 'Вставка');
  changed();
}

const SAVE_FILTERS = [
  { name: 'Photoshop (слои)', extensions: ['psd'] },
  { name: 'PNG', extensions: ['png'] },
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP', extensions: ['webp'] },
  { name: 'TIFF', extensions: ['tif', 'tiff'] },
  { name: 'Иконка Windows (ICO)', extensions: ['ico'] },
  { name: 'Иконка macOS (ICNS)', extensions: ['icns'] },
];

async function encodeForPath(doc: Doc, name: string): Promise<Uint8Array> {
  // иконки — стандартный набор размеров; тонкая настройка — «Файл → Иконка приложения»
  if (/\.(ico|icns)$/i.test(name)) {
    const files = await buildIconFiles(doc.composite(), { ...DEFAULT_ICON, platforms: [/\.ico$/i.test(name) ? 'windows' : 'macos'], name: 'x' });
    return Object.values(files)[0];
  }
  const fmt = formatFromName(name) ?? 'psd';
  if (fmt === 'psd') return encodePsd(doc);
  if (doc.layers.length > 1) toast(`Формат ${fmt.toUpperCase()} не хранит слои — сохранено сведённое изображение`);
  return encodeCanvas(doc.composite(), fmt, 95);
}

export async function saveDoc(as = false) {
  const doc = activeDoc();
  if (!doc) return;
  commitPending();
  // атлас и вкладки его спрайтов сохраняются проектом .pyard
  const atlas = ownerAtlas(doc);
  if (atlas && isAtlas(atlas)) return saveAtlasProject(atlas, as && atlas === doc);
  await withBusy('Сохранение…', async () => {
    if (!as && doc.path && isTauri) {
      await writePath(doc.path, await encodeForPath(doc, doc.path));
      doc.savedRev = doc.rev;
      toast(`Сохранено: ${baseName(doc.path)}`);
      return changed();
    }
    const fmt = formatFromName(doc.name);
    const defName = fmt === 'psd' ? doc.name : `${fileStem(doc.name)}.psd`;
    // в Tauri формат определяется по расширению, выбранному в диалоге
    const data = isTauri ? null : encodePsd(doc);
    let path: string | null;
    if (isTauri) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      path = await save({ defaultPath: defName, filters: SAVE_FILTERS });
      if (!path) return;
      await writePath(path, await encodeForPath(doc, path));
    } else path = await saveFileAs(defName, data!, SAVE_FILTERS);
    if (!path) return;
    doc.path = isTauri ? path : null;
    doc.name = baseName(path);
    doc.savedRev = doc.rev;
    toast(`Сохранено: ${doc.name}`);
    changed();
  });
}

export async function quickExportPng() {
  const doc = activeDoc();
  if (!doc) return;
  await withBusy('Экспорт PNG…', async () => {
    const data = await encodeCanvas(doc.composite(), 'png');
    const p = await saveFileAs(`${fileStem(doc.name)}.png`, data, [{ name: 'PNG', extensions: ['png'] }]);
    if (p) toast(`Экспортировано: ${baseName(p)}`);
  });
}

// ---------- инструменты ----------

export function deactivateTool() {
  const doc = activeDoc();
  if (transformActive()) cancelTransform();
  TOOLS[app().tool].deactivate?.(doc);
  clearPaintHover();
}

/** Завершает незакоммиченные интерактивные операции (например, перед сохранением). */
export function commitPending() {
  TOOLS[app().tool].deactivate?.(activeDoc());
}

export function setTool(t: ToolId) {
  if (app().tool === t) return;
  deactivateTool();
  useApp.setState({ tool: t });
  // рамка кадрирования сразу по выделению — Enter обрежет выделенную область
  const d = activeDoc();
  if (t === 'crop' && d?.selection) useCrop.setState({ rect: { ...d.selection.bounds } });
  changed();
}

export function swapColors() {
  const { fg, bg } = app();
  useApp.setState({ fg: bg, bg: fg });
}

export function resetColors() {
  setFg([0, 0, 0, 255]);
  setBg([255, 255, 255, 255]);
}

// ---------- история ----------

export function undo() {
  const doc = activeDoc();
  if (!doc) return;
  if (transformActive()) return cancelTransform();
  commitPending();
  if (doc.undo()) changed();
}

export function redo() {
  const doc = activeDoc();
  if (doc?.redo()) changed();
}

// ---------- выделение ----------

function withDoc(fn: (doc: Doc) => void) {
  return () => {
    const doc = activeDoc();
    if (!doc) return;
    fn(doc);
    changed();
  };
}

export const selectAllAction = withDoc((d) => {
  if (isAtlas(d)) d.atlasSel = d.atlas.sprites.map((s) => s.id);
  else d.setSelection(selectAll(d.width, d.height), 'Выделить всё');
});
export const deselect = withDoc((d) => {
  if (isAtlas(d)) d.atlasSel = [];
  else d.setSelection(null);
});
export const invertSel = withDoc((d) => d.setSelection(invertSelection(d.selection ?? null, d.width, d.height) ?? (d.selection ? null : selectAll(d.width, d.height)), 'Инверсия выделения'));
export const selectLayerAlpha = withDoc((d) => {
  const l = d.activeLayer;
  if (l) d.setSelection(selectionFromAlpha(l.canvas), 'Выделить непрозрачные пиксели');
});

export function modifySelection(op: 'grow' | 'shrink' | 'feather' | 'border', amount: number) {
  const doc = activeDoc();
  if (!doc?.selection || amount <= 0) return;
  const s = doc.selection;
  let next = null;
  if (op === 'grow') next = growSelection(s, amount);
  else if (op === 'shrink') next = growSelection(s, -amount);
  else if (op === 'feather') next = featherSelection(s, amount);
  else {
    // граница = расширенное минус сжатое
    const outer = growSelection(s, Math.ceil(amount / 2));
    const inner = growSelection(s, -Math.floor(amount / 2));
    if (outer) {
      const m = cloneCanvas(outer.mask);
      if (inner) {
        const ctx = ctx2d(m);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(inner.mask, 0, 0);
      }
      next = selectionFromMask(m);
    }
  }
  const labels = { grow: 'Расширить выделение', shrink: 'Сжать выделение', feather: 'Растушевка', border: 'Граница выделения' };
  doc.setSelection(next, labels[op]);
  changed();
}

// ---------- буфер обмена ----------

let clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;

function selectionContent(doc: Doc, merged: boolean): { canvas: HTMLCanvasElement; rect: Rect } | null {
  const src = merged ? doc.composite() : doc.activeLayer?.canvas;
  if (!src) return null;
  const masked = maskedCopy(src, doc.selection);
  const rect = doc.selection ? intersectRect(doc.selection.bounds, { x: 0, y: 0, w: doc.width, h: doc.height }) : alphaBounds(masked);
  if (!rect) return null;
  return { canvas: cropCanvas(masked, rect), rect };
}

async function writeSystemClipboard(c: HTMLCanvasElement) {
  try {
    const blob = await canvasToBlob(c, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch {
    // системный буфер недоступен — остаётся внутренний
  }
}

export function copy(merged = false) {
  const doc = activeDoc();
  if (!doc) return;
  const c = selectionContent(doc, merged);
  if (!c) return toast('Нечего копировать', 'error');
  clipboard = { canvas: c.canvas, x: c.rect.x, y: c.rect.y };
  void writeSystemClipboard(c.canvas);
  toast(`Скопировано ${c.rect.w} × ${c.rect.h}`);
}

export function cut() {
  const doc = activeDoc();
  const l = doc?.activeLayer;
  if (!doc || !l) return;
  copy(false);
  clearSelectionPixels('Вырезать');
}

export async function paste() {
  const doc = activeDoc();
  // системный буфер — если там картинка новее внутренней (например, скриншот)
  let sys: HTMLCanvasElement | null = null;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await it.getType(type);
        sys = await decodeToCanvas({ name: 'clip.png', path: null, data: new Uint8Array(await blob.arrayBuffer()) });
        break;
      }
    }
  } catch {
    // нет доступа к системному буферу
  }
  const internalMatches = clipboard && sys && sys.width === clipboard.canvas.width && sys.height === clipboard.canvas.height;
  const src = sys && !internalMatches ? { canvas: sys, x: undefined, y: undefined } : clipboard;
  if (!src) return toast('Буфер обмена пуст', 'error');
  if (!doc) {
    const d = new Doc('Вставка.psd', src.canvas.width, src.canvas.height);
    const l = d.makeLayer('Вставка', cloneCanvas(src.canvas));
    d.layers = [l];
    d.activeLayerId = l.id;
    return addDoc(d);
  }
  const fits = src.x !== undefined && src.y !== undefined && src.x + src.canvas.width <= doc.width && src.y + src.canvas.height <= doc.height;
  addImageAsLayer(doc, src.canvas, doc.nextLayerName('Вставка'), fits ? { x: src.x!, y: src.y! } : undefined);
}

export function pasteAsNewDoc() {
  if (!clipboard) return toast('Буфер обмена пуст', 'error');
  const d = new Doc('Без названия.psd', clipboard.canvas.width, clipboard.canvas.height);
  const l = d.makeLayer('Слой 1', cloneCanvas(clipboard.canvas));
  d.layers = [l];
  d.activeLayerId = l.id;
  addDoc(d);
}

export function clearSelectionPixels(label = 'Очистить') {
  const doc = activeDoc();
  const l = doc?.activeLayer;
  if (!doc || !l || l.locked) return;
  const sel = doc.selection;
  doc.pixelEdit(l.id, sel?.bounds ?? null, label, (ctx) => {
    if (sel) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.mask, 0, 0);
    } else ctx.clearRect(0, 0, doc.width, doc.height);
  });
  changed();
}

export function fillSelection(which: 'fg' | 'bg') {
  const doc = activeDoc();
  const l = doc?.activeLayer;
  if (!doc || !l || l.locked) return;
  const color = rgbaToCss(which === 'fg' ? app().fg : app().bg);
  const sel = doc.selection;
  const paint = createCanvas(doc.width, doc.height);
  const pc = ctx2d(paint);
  pc.fillStyle = color;
  pc.fillRect(0, 0, doc.width, doc.height);
  const img = sel ? maskedCopy(paint, sel) : paint;
  doc.pixelEdit(l.id, sel?.bounds ?? null, 'Заливка', (ctx) => ctx.drawImage(img, 0, 0));
  changed();
}

export function strokeSelection(width: number) {
  const doc = activeDoc();
  const l = doc?.activeLayer;
  if (!doc?.selection || !l || l.locked) return;
  const border = growSelection(doc.selection, width);
  if (!border) return;
  const m = cloneCanvas(border.mask);
  const mc = ctx2d(m);
  mc.globalCompositeOperation = 'destination-out';
  mc.drawImage(doc.selection.mask, 0, 0);
  mc.globalCompositeOperation = 'source-in';
  mc.fillStyle = rgbaToCss(app().fg);
  mc.fillRect(0, 0, doc.width, doc.height);
  doc.pixelEdit(l.id, null, 'Обводка выделения', (ctx) => ctx.drawImage(m, 0, 0));
  changed();
}

// ---------- слои ----------

export const newLayer = withDoc((d) => d.addLayer(d.makeLayer(d.nextLayerName())));
export const duplicateLayer = withDoc((d) => d.activeLayerId && d.duplicateLayer(d.activeLayerId));
export const deleteLayer = withDoc((d) => d.activeLayerId && d.removeLayer(d.activeLayerId));
export const mergeDown = withDoc((d) => d.activeLayerId && d.mergeDown(d.activeLayerId));
export const flatten = withDoc((d) => d.flatten());

export const mergeVisible = withDoc((d) => {
  const visible = d.layers.filter((l) => l.visible);
  if (visible.length < 2) return;
  const merged = d.composite();
  d.change('Объединить видимые', () => {
    const idx = d.layers.findIndex((l) => l.visible);
    const layer = d.makeLayer('Объединённый', merged);
    const layers = d.layers.filter((l) => !l.visible);
    layers.splice(Math.min(idx, layers.length), 0, layer);
    d.layers = layers;
    d.activeLayerId = layer.id;
  });
});

export function moveLayerBy(delta: number) {
  const d = activeDoc();
  if (!d?.activeLayerId) return;
  d.moveLayer(d.activeLayerId, d.layerIndex(d.activeLayerId) + delta);
  changed();
}

/** Новый слой из выделенного (Cmd+J) или вырезанного (Shift+Cmd+J). */
export function layerVia(cutOut: boolean) {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  const content = d.selection ? maskedCopy(l.canvas, d.selection) : cloneCanvas(l.canvas);
  if (!alphaBounds(content)) return toast('Выделенная область пуста', 'error');
  const layer = d.makeLayer(`${l.name} ${cutOut ? 'вырезка' : 'копия'}`, content);
  if (cutOut && !l.locked) {
    const sel = d.selection;
    const before = l.id;
    d.compound('Вырезать на новый слой', before, (ctx) => {
      if (sel) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(sel.mask, 0, 0);
      } else ctx.clearRect(0, 0, d.width, d.height);
    }, () => {
      const layers = [...d.layers];
      layers.splice(d.layerIndex(before) + 1, 0, layer);
      d.layers = layers;
      d.activeLayerId = layer.id;
    });
  } else d.addLayer(layer, 'Скопировать на новый слой');
  changed();
}

export function flipLayer(dir: 'h' | 'v') {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l || l.locked) return;
  const copyC = cloneCanvas(d.editSource(l));
  d.pixelEdit(l.id, null, dir === 'h' ? 'Отразить слой по горизонтали' : 'Отразить слой по вертикали', (ctx) => {
    ctx.clearRect(0, 0, d.width, d.height);
    if (dir === 'h') {
      ctx.translate(d.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, d.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(copyC, 0, 0);
  });
  changed();
}

export function freeTransform(mode: TransformMode = 'free') {
  const d = activeDoc();
  if (!d) return;
  if (!transformActive()) commitPending();
  startTransform(d, mode);
}

/** Выравнивает содержимое слоя по холсту или по рамке выделения. */
export function alignLayer(where: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l || l.locked) return;
  const b = alphaBounds(l.canvas);
  if (!b) return;
  const area = d.selection?.bounds ?? { x: 0, y: 0, w: d.width, h: d.height };
  let dx = 0, dy = 0;
  if (where === 'left') dx = area.x - b.x;
  if (where === 'right') dx = area.x + area.w - (b.x + b.w);
  if (where === 'hcenter') dx = Math.round(area.x + (area.w - b.w) / 2 - b.x);
  if (where === 'top') dy = area.y - b.y;
  if (where === 'bottom') dy = area.y + area.h - (b.y + b.h);
  if (where === 'vcenter') dy = Math.round(area.y + (area.h - b.h) / 2 - b.y);
  if (!dx && !dy) return;
  const copyC = cloneCanvas(l.canvas);
  d.pixelEdit(l.id, null, 'Выравнивание', (ctx) => {
    ctx.clearRect(0, 0, d.width, d.height);
    ctx.drawImage(copyC, dx, dy);
  });
  changed();
}

// ---------- изображение ----------

export function rotateCanvas(deg: 90 | -90 | 180) {
  const d = activeDoc();
  if (!d) return;
  const W = d.width, H = d.height;
  const nw = deg === 180 ? W : H, nh = deg === 180 ? H : W;
  d.transformAll(
    deg === 180 ? 'Поворот 180°' : deg === 90 ? 'Поворот 90° по часовой' : 'Поворот 90° против часовой',
    nw,
    nh,
    (c) => {
      const out = createCanvas(nw, nh);
      const ctx = ctx2d(out);
      ctx.translate(nw / 2, nh / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(c, -W / 2, -H / 2);
      return out;
    },
    (s) => {
      if (deg === 180) return { ...s, x: W - s.x - s.w, y: H - s.y - s.h };
      if (deg === 90) return { ...s, x: H - s.y - s.h, y: s.x, w: s.h, h: s.w, nine: null };
      return { ...s, x: s.y, y: W - s.x - s.w, w: s.h, h: s.w, nine: null };
    },
  );
  d.needsFit = true;
  changed();
}

export function flipCanvas(dir: 'h' | 'v') {
  const d = activeDoc();
  if (!d) return;
  const W = d.width, H = d.height;
  d.transformAll(dir === 'h' ? 'Отразить холст по горизонтали' : 'Отразить холст по вертикали', W, H, (c) => {
    const out = createCanvas(W, H);
    const ctx = ctx2d(out);
    if (dir === 'h') {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, H);
      ctx.scale(1, -1);
    }
    ctx.drawImage(c, 0, 0);
    return out;
  }, (s) => (dir === 'h' ? { ...s, x: W - s.x - s.w } : { ...s, y: H - s.y - s.h }));
  changed();
}

export function resizeImage(w: number, h: number, smooth: boolean) {
  const d = activeDoc();
  if (!d || (w === d.width && h === d.height)) return;
  const kx = w / d.width, ky = h / d.height;
  d.transformAll('Размер изображения', w, h, (c) => scaleCanvas(c, w, h, smooth), (s) => ({
    ...s,
    x: Math.round(s.x * kx),
    y: Math.round(s.y * ky),
    w: Math.max(1, Math.round(s.w * kx)),
    h: Math.max(1, Math.round(s.h * ky)),
    nine: s.nine && {
      left: Math.round(s.nine.left * kx), right: Math.round(s.nine.right * kx),
      top: Math.round(s.nine.top * ky), bottom: Math.round(s.nine.bottom * ky),
    },
  }));
  d.needsFit = true;
  changed();
}

/** anchor: 0..8 по сетке 3×3 (0 — левый верхний). */
export function resizeCanvas(w: number, h: number, anchor: number) {
  const d = activeDoc();
  if (!d || (w === d.width && h === d.height)) return;
  const ax = anchor % 3, ay = Math.floor(anchor / 3);
  const ox = Math.round(((w - d.width) * ax) / 2), oy = Math.round(((h - d.height) * ay) / 2);
  d.transformAll('Размер холста', w, h, (c) => {
    const out = createCanvas(w, h);
    ctx2d(out).drawImage(c, ox, oy);
    return out;
  }, (s) => {
    const r = intersectRect({ x: s.x + ox, y: s.y + oy, w: s.w, h: s.h }, { x: 0, y: 0, w, h });
    return r ? { ...s, ...r } : null;
  });
  d.needsFit = true;
  changed();
}

function cropTo(d: Doc, r: Rect, label: string) {
  d.transformAll(label, r.w, r.h, (c) => cropCanvas(c, r), (s) => {
    const rr = intersectRect({ x: s.x - r.x, y: s.y - r.y, w: s.w, h: s.h }, { x: 0, y: 0, w: r.w, h: r.h });
    return rr ? { ...s, ...rr } : null;
  });
  d.needsFit = true;
  changed();
}

export function cropToSelection() {
  const d = activeDoc();
  if (!d?.selection) return toast('Нет выделения', 'error');
  const r = intersectRect(d.selection.bounds, { x: 0, y: 0, w: d.width, h: d.height });
  if (r) cropTo(d, r, 'Кадрировать по выделению');
}

export function trimTransparent() {
  const d = activeDoc();
  if (!d) return;
  const b = alphaBounds(d.composite({ includeHidden: true }));
  if (!b) return toast('Изображение полностью прозрачное', 'error');
  if (b.w === d.width && b.h === d.height) return toast('Прозрачных краёв нет');
  cropTo(d, b, 'Тримминг');
}

// ---------- фильтры ----------

/** Результат фильтра для слоя с учётом выделения (для превью и применения). */
export function filterResult(d: Doc, layerCanvas: HTMLCanvasElement, filterId: string, params: Params): HTMLCanvasElement {
  const f = FILTERS.find((x) => x.id === filterId)!;
  const ctx = ctx2d(layerCanvas);
  // обрабатываем только область выделения (+ запас для размытий), остальное копируем как есть
  const pad = typeof params.radius === 'number' ? (params.radius as number) * 3 : typeof params.size === 'number' ? (params.size as number) + 2 : 64;
  const area = d.selection
    ? intersectRect({ x: d.selection.bounds.x - pad, y: d.selection.bounds.y - pad, w: d.selection.bounds.w + pad * 2, h: d.selection.bounds.h + pad * 2 }, { x: 0, y: 0, w: d.width, h: d.height })
    : { x: 0, y: 0, w: d.width, h: d.height };
  const out = cloneCanvas(layerCanvas);
  if (!area) return out;
  const img = ctx.getImageData(area.x, area.y, area.w, area.h);
  const res = f.apply(img, params) ?? img;
  const processed = createCanvas(d.width, d.height);
  ctx2d(processed).putImageData(res, area.x, area.y);
  if (!d.selection) return processed;
  const octx = ctx2d(out);
  blendThroughSelection(octx, processed, d.selection);
  return out;
}

export function applyFilter(filterId: string, params: Params) {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  if (l.locked) return toast(`Слой «${l.name}» заблокирован`, 'error');
  const result = filterResult(d, d.editSource(l), filterId, params);
  const f = FILTERS.find((x) => x.id === filterId)!;
  d.pixelEdit(l.id, null, f.label.replace('…', ''), (ctx) => {
    ctx.clearRect(0, 0, d.width, d.height);
    ctx.drawImage(result, 0, 0);
  });
  changed();
}

export function runFilter(filterId: string) {
  const f = FILTERS.find((x) => x.id === filterId);
  if (!f || !activeDoc()?.activeLayer) return;
  if (filterId === 'curves') return openDialog({ kind: 'curves' });
  if (!f.params.length) return applyFilter(filterId, {});
  openDialog({ kind: 'filter', filterId });
}

// ---------- слайсы ----------

export function sliceFromSelection() {
  const d = activeDoc();
  if (!d?.selection) return toast('Нет выделения', 'error');
  const b = d.selection.bounds;
  const s: Slice = { id: uid('sl'), name: d.nextSliceName(), ...b, nine: null };
  d.setSlices([...d.slices, s], 'Слайс из выделения');
  d.activeSliceId = s.id;
  changed();
}

export function slicesFromLayers() {
  const d = activeDoc();
  if (!d) return;
  const add: Slice[] = [];
  for (const l of d.layers) {
    const b = alphaBounds(l.canvas);
    if (b) add.push({ id: uid('sl'), name: l.name, ...b, nine: null });
  }
  if (!add.length) return toast('Все слои пусты', 'error');
  d.setSlices([...d.slices, ...add], 'Слайсы по слоям');
  toast(`Создано слайсов: ${add.length}`);
  changed();
}

/** Каждый слайс → отдельный слой (из сведённого изображения). */
export function slicesToLayers() {
  const d = activeDoc();
  if (!d?.slices.length) return toast('Нет слайсов', 'error');
  const src = d.composite();
  const made = d.slices.map((s) => {
    const c = d.newLayerCanvas();
    ctx2d(c).drawImage(src, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    return d.makeLayer(s.name, c);
  });
  d.change('Слайсы в слои', () => {
    d.layers = [...d.layers, ...made];
    d.activeLayerId = made[made.length - 1].id;
  });
  toast(`Создано слоёв: ${made.length}`);
  changed();
}

export function clearSlices() {
  const d = activeDoc();
  if (!d?.slices.length) return;
  d.setSlices([], 'Удалить все слайсы');
  d.activeSliceId = null;
  changed();
}

export function selectSliceArea() {
  const d = activeDoc();
  const s = d?.slices.find((x) => x.id === d.activeSliceId);
  if (!d || !s) return;
  const m = createCanvas(d.width, d.height);
  ctx2d(m).fillRect(s.x, s.y, s.w, s.h);
  d.setSelection(selectionFromMask(m), 'Выделить слайс');
  changed();
}

// ---------- вид ----------

export function zoomBy(dir: 1 | -1) {
  const d = activeDoc();
  if (!d) return;
  d.view = zoomAt(d.view, nextZoom(d.view.zoom, dir), viewportSize().w / 2, viewportSize().h / 2);
  changed();
}

export function zoomTo(z: number) {
  const d = activeDoc();
  if (d) setZoomCentered(d, Math.min(64, Math.max(0.02, z)));
}

export function fitToScreen() {
  fitMode('fit');
}

export { closeDialog };

// ---------- выделенное → новый документ ----------

/** Выделенная область (активного слоя или всех видимых) открывается отдельным документом. */
export function selectionToNewDoc(merged: boolean) {
  const d = activeDoc();
  if (!d) return;
  const c = selectionContent(d, merged);
  if (!c) return toast('Выделенная область пуста', 'error');
  const nd = new Doc(`${fileStem(d.name)} фрагмент.psd`, c.rect.w, c.rect.h);
  const l = nd.makeLayer(merged ? 'Фрагмент' : d.activeLayer?.name ?? 'Слой 1', c.canvas);
  nd.layers = [l];
  nd.activeLayerId = l.id;
  addDoc(nd);
}

// ---------- раскрой ножом ----------

export function cutsToSlices() {
  const d = activeDoc();
  if (!d) return;
  if (!d.cuts.x.length && !d.cuts.y.length) return toast('Нет линий реза — поставьте их инструментом «Нож» (⇧K)', 'error');
  const slices = piecesAsSlices(d, 'piece_');
  d.setSlices(slices, 'Куски в слайсы');
  toast(`Слайсов: ${slices.length}`);
  changed();
}

/** Каждый кусок — отдельный слой (из сведённого изображения). */
export function cutsToLayers() {
  const d = activeDoc();
  if (!d) return;
  if (!d.cuts.x.length && !d.cuts.y.length) return toast('Нет линий реза', 'error');
  const src = d.composite();
  const made = piecesAsSlices(d, 'piece_').map((p) => {
    const c = d.newLayerCanvas();
    ctx2d(c).drawImage(src, p.x, p.y, p.w, p.h, p.x, p.y, p.w, p.h);
    return d.makeLayer(p.name, c);
  });
  d.change('Куски в слои', () => {
    d.layers = [...d.layers, ...made];
    d.activeLayerId = made[made.length - 1].id;
  });
  toast(`Создано слоёв: ${made.length}`);
  changed();
}

/** Куски → слайсы и сразу диалог экспорта: каждый кусок в свой файл. */
export function exportPieces() {
  const d = activeDoc();
  if (!d) return;
  if (!d.cuts.x.length && !d.cuts.y.length) return toast('Нет линий реза', 'error');
  cutsToSlices();
  openDialog({ kind: 'export', source: 'slices', ids: d.slices.map((s) => s.id) });
}

export function cutEvery(stepX: number, stepY: number) {
  const d = activeDoc();
  if (!d) return;
  const xs: number[] = [], ys: number[] = [];
  if (stepX > 0) for (let x = stepX; x < d.width; x += stepX) xs.push(x);
  if (stepY > 0) for (let y = stepY; y < d.height; y += stepY) ys.push(y);
  d.setCuts({ x: xs, y: ys }, 'Резы с шагом');
  changed();
}

export function clearCuts() {
  const d = activeDoc();
  if (!d || (!d.cuts.x.length && !d.cuts.y.length)) return;
  d.setCuts({ x: [], y: [] }, 'Очистить резы');
  changed();
}

// ---------- маски и обтравка ----------

export function addMask(kind: 'reveal' | 'hide' | 'selection') {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  if (l.mask) return toast('У слоя уже есть маска', 'error');
  if (kind === 'selection' && !d.selection) return toast('Нет выделения', 'error');
  const m = d.newLayerCanvas();
  const ctx = ctx2d(m);
  if (kind === 'reveal') ctx.fillRect(0, 0, d.width, d.height);
  else if (kind === 'selection') ctx.drawImage(d.selection!.mask, 0, 0);
  d.change('Маска слоя', () => {
    d.layers = d.layers.map((x) => (x.id === l.id ? { ...x, mask: m, maskEnabled: true } : x));
    if (kind === 'selection') d.selection = null;
  });
  d.editMask = true;
  changed();
}

export function deleteMask() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l?.mask) return;
  d.updateLayer(l.id, { mask: null }, 'Удалить маску');
  d.editMask = false;
  changed();
}

/** Применить маску: скрытое маской стирается из пикселей, маска удаляется. */
export function applyMask() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l?.mask) return;
  const baked = cloneCanvas(l.canvas);
  const ctx = ctx2d(baked);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(l.mask, 0, 0);
  d.change('Применить маску', () => {
    d.layers = d.layers.map((x) => (x.id === l.id ? { ...x, canvas: baked, mask: null } : x));
  });
  d.editMask = false;
  changed();
}

export function toggleMaskEnabled() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l?.mask) return;
  d.updateLayer(l.id, { maskEnabled: !l.maskEnabled }, l.maskEnabled ? 'Отключить маску' : 'Включить маску');
  changed();
}

export function setEditMask(on: boolean) {
  const d = activeDoc();
  if (!d) return;
  d.editMask = on && !!d.activeLayer?.mask;
  changed();
}

export function toggleClip() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  if (!l.clip && d.layerIndex(l.id) === 0) return toast('Обтравочной маске нужен слой ниже', 'error');
  d.updateLayer(l.id, { clip: !l.clip }, l.clip ? 'Отменить обтравочную маску' : 'Создать обтравочную маску');
  changed();
}

// ---------- стили слоя ----------

let styleClipboard: Layer['effects'] | null = null;

export function copyStyle() {
  const l = activeDoc()?.activeLayer;
  if (!l) return;
  styleClipboard = l.effects;
  toast('Стиль слоя скопирован');
}

export function pasteStyle() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l || !styleClipboard) return;
  d.updateLayer(l.id, { effects: styleClipboard }, 'Вставить стиль слоя');
  changed();
}

export function clearStyle() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  d.updateLayer(l.id, { effects: DEFAULT_EFFECTS, fillOpacity: 1 }, 'Очистить стиль слоя');
  changed();
}

/** Эффекты, маска и непрозрачность заливки «запекаются» в пиксели слоя. */
export function rasterizeStyle() {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  const baked = cloneCanvas(renderLayer(l, d.rev));
  d.change('Растрировать стиль слоя', () => {
    d.layers = d.layers.map((x) => (x.id === l.id ? { ...x, canvas: baked, mask: null, effects: DEFAULT_EFFECTS, fillOpacity: 1 } : x));
  });
  d.editMask = false;
  changed();
}

// ---------- выделение по цвету ----------

export function selectByColor(color: RGBA, tolerance: number, softness: number, merged: boolean, mode: SelectMode) {
  const d = activeDoc();
  if (!d) return;
  const src = merged ? d.composite() : d.activeLayer?.canvas;
  if (!src) return;
  const next = combineSelection(mode === 'replace' ? null : d.selection, colorRangeMask(src, color, tolerance, softness), mode);
  d.setSelection(next, 'Цветовой диапазон');
  changed();
}

// ---------- узоры ----------

/** «Определить узор»: видимое изображение в рамке выделения (или целиком). */
export function definePatternAction() {
  const d = activeDoc();
  if (!d) return;
  const src = d.composite();
  const r = d.selection ? intersectRect(d.selection.bounds, { x: 0, y: 0, w: d.width, h: d.height }) : { x: 0, y: 0, w: d.width, h: d.height };
  if (!r) return;
  if (r.w > 1024 || r.h > 1024) return toast('Узор не больше 1024×1024 — выделите меньшую область', 'error');
  const n = usePatterns.getState().list.filter((p) => !p.builtin).length + 1;
  const p = definePattern(cropCanvas(src, r), `Узор ${n}`);
  setOpts({ fillPattern: p.id, fillSource: 'pattern' });
  toast(`Узор «${p.name}» ${r.w}×${r.h} добавлен в библиотеку`);
}

export interface FillParams {
  source: 'fg' | 'bg' | 'color' | 'pattern' | 'transparent';
  color: RGBA;
  patternId: string | null;
  patternScale: number;
  opacity: number;
  blend: Layer['blend'];
  preserveAlpha: boolean;
}

/** Холст с заливкой (до применения к слою) — общий для превью и применения. */
export function fillCanvas(d: Doc, p: FillParams): HTMLCanvasElement | null {
  const c = createCanvas(d.width, d.height);
  const ctx = ctx2d(c);
  if (p.source === 'pattern') {
    const t = tiled(p.patternId ?? '', d.width, d.height, p.patternScale / 100);
    if (!t) return null;
    ctx.drawImage(t, 0, 0);
  } else if (p.source !== 'transparent') {
    ctx.fillStyle = rgbaToCss(p.source === 'fg' ? app().fg : p.source === 'bg' ? app().bg : p.color);
    ctx.fillRect(0, 0, d.width, d.height);
  }
  return d.selection ? maskedCopy(c, d.selection) : c;
}

/** Применяет заливку к пикселям (или маске) слоя: ctx — контекст цели. */
export function drawFill(ctx: CanvasRenderingContext2D, base: HTMLCanvasElement, fill: HTMLCanvasElement, p: FillParams, sel: Doc['selection']) {
  if (p.source === 'transparent') {
    ctx.globalAlpha = p.opacity / 100;
    ctx.globalCompositeOperation = 'destination-out';
    if (sel) ctx.drawImage(sel.mask, 0, 0);
    else ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }
  let src = fill;
  if (p.preserveAlpha) {
    // сохранить прозрачность: заливка только там, где уже есть пиксели
    src = cloneCanvas(fill);
    const sc = ctx2d(src);
    sc.globalCompositeOperation = 'destination-in';
    sc.drawImage(base, 0, 0);
  }
  ctx.globalAlpha = p.opacity / 100;
  ctx.globalCompositeOperation = p.preserveAlpha && p.blend === 'normal' ? 'source-atop' : blendToComposite(p.blend);
  ctx.drawImage(src, 0, 0);
}

export function applyFill(p: FillParams) {
  const d = activeDoc();
  const l = d?.activeLayer;
  if (!d || !l) return;
  if (l.locked) return toast(`Слой «${l.name}» заблокирован`, 'error');
  const fill = fillCanvas(d, p);
  if (!fill) return toast('Узор ещё не загружен', 'error');
  const base = d.editSource(l);
  d.pixelEdit(l.id, d.selection?.bounds ?? null, p.source === 'pattern' ? 'Заливка узором' : 'Заливка', (ctx) => drawFill(ctx, base, fill, p, d.selection));
  changed();
}

// ---------- направляющие ----------

export function addGuide(axis: 'x' | 'y', value: number) {
  const d = activeDoc();
  if (!d) return;
  d.setGuides({ ...d.guides, [axis]: [...d.guides[axis], value] }, 'Новая направляющая');
  setPrefs({ guides: true });
  changed();
}

export function clearGuides() {
  const d = activeDoc();
  if (!d || d.guides.x.length + d.guides.y.length === 0) return;
  d.setGuides({ x: [], y: [] }, 'Удалить направляющие');
  changed();
}

/** Направляющие по краям выделения или слайса — удобно выравнивать нарезку. */
export function guidesFromSelection() {
  const d = activeDoc();
  const r = d?.selection?.bounds ?? d?.slices.find((s) => s.id === d.activeSliceId);
  if (!d || !r) return toast('Нет выделения или выбранного слайса', 'error');
  d.setGuides({ x: [...d.guides.x, r.x, r.x + r.w], y: [...d.guides.y, r.y, r.y + r.h] }, 'Направляющие по выделению');
  setPrefs({ guides: true });
  changed();
}

/** Линии реза ножа ставятся по направляющим. */
export function guidesToCuts() {
  const d = activeDoc();
  if (!d) return;
  if (!d.guides.x.length && !d.guides.y.length) return toast('Нет направляющих', 'error');
  d.setCuts({ x: [...d.cuts.x, ...d.guides.x], y: [...d.cuts.y, ...d.guides.y] }, 'Резы по направляющим');
  toast(`Кусков: ${(d.cuts.x.length + 1) * (d.cuts.y.length + 1)}`);
  changed();
}

// ---------- вид: центровка и вписывание ----------

/** Видимая область без линеек (картинку выравниваем по ней, а не под линейками). */
function viewArea() {
  const sz = viewportSize();
  const off = app().prefs.rulers ? RULER : 0;
  return { x: off, y: off, w: sz.w - off, h: sz.h - off };
}

function setZoomCentered(d: Doc, z: number) {
  const a = viewArea();
  d.view = { zoom: z, panX: Math.round(a.x + (a.w - d.width * z) / 2), panY: Math.round(a.y + (a.h - d.height * z) / 2) };
  changed();
}

/** Центрировать картинку, не меняя масштаб. */
export function centerView() {
  const d = activeDoc();
  if (d) setZoomCentered(d, d.view.zoom);
}

export type FitMode = 'fit' | 'fill' | 'width' | 'height';

/** Вписать: целиком, заполнить экран, по ширине или по высоте. */
export function fitMode(mode: FitMode) {
  const d = activeDoc();
  if (!d) return;
  const a = viewArea();
  const pad = mode === 'fill' ? 0 : 24;
  const kw = (a.w - pad * 2) / d.width, kh = (a.h - pad * 2) / d.height;
  const z = mode === 'fit' ? Math.min(kw, kh) : mode === 'fill' ? Math.max(kw, kh) : mode === 'width' ? kw : kh;
  setZoomCentered(d, Math.min(64, Math.max(0.02, z)));
}
