import { cloneCanvas, createCanvas, ctx2d, intersectRect, uid } from './canvas';
import { blendToComposite, compositeLayers, grayToMaskData, maskToGray } from './composite';
import { DEFAULT_EFFECTS, type Cuts, type Layer, type Rect, type Selection, type Slice } from './types';

/** Снимок «структуры» документа: ссылки на неизменяемые объекты. */
interface Snapshot {
  width: number;
  height: number;
  layers: Layer[];
  slices: Slice[];
  cuts: Cuts;
  guides: Cuts;
  selection: Selection | null;
  activeLayerId: string | null;
}

interface PixelPatch {
  layerId: string;
  /** Что правилось: пиксели слоя или его маска. */
  target: 'pixels' | 'mask';
  rect: Rect;
  before: ImageData;
  after: ImageData;
}

export interface HistoryEntry {
  id: string;
  label: string;
  /** Структурное изменение: снимки до/после. */
  before?: Snapshot;
  after?: Snapshot;
  /** Пиксельное изменение: только затронутая область. */
  patches?: PixelPatch[];
}

const MAX_HISTORY = 100;

/** Подмена содержимого слоя при интерактивных операциях (мазок, перемещение, фильтр). */
export interface LayerPreview {
  layerId: string;
  /** layer.canvas здесь — то, что редактируется (пиксели или серая маска). */
  draw(ctx: CanvasRenderingContext2D, layer: Layer): void;
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

type PixelFn = (ctx: CanvasRenderingContext2D, layer: Layer) => void;

/** Контекст слоя может хранить чужое состояние (режим наложения, альфа) — сбрасываем. */
function resetCtx(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
}

export class Doc {
  id = uid('doc');
  name: string;
  path: string | null = null;
  width: number;
  height: number;
  layers: Layer[] = [];
  slices: Slice[] = [];
  cuts: Cuts = { x: [], y: [] };
  guides: Cuts = { x: [], y: [] };
  selection: Selection | null = null;
  activeLayerId: string | null = null;
  activeSliceId: string | null = null;
  /** Инструменты рисуют в маску активного слоя, а не в его пиксели. */
  editMask = false;

  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  /** Счётчик изменений — для перерисовки, кэшей и флага «не сохранено». */
  rev = 0;
  savedRev = 0;

  view: ViewState = { zoom: 1, panX: 0, panY: 0 };
  /** true, пока вид ещё не подогнан под размер окна. */
  needsFit = true;
  preview: LayerPreview | null = null;

  private grayCache: { mask: HTMLCanvasElement; rev: number; gray: HTMLCanvasElement } | null = null;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
  }

  get dirty() {
    return this.rev !== this.savedRev;
  }

  get activeLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  /** Сейчас правится маска активного слоя. */
  get editingMask(): boolean {
    return this.editMask && !!this.activeLayer?.mask;
  }

  layerIndex(id: string) {
    return this.layers.findIndex((l) => l.id === id);
  }

  getLayer(id: string) {
    return this.layers.find((l) => l.id === id) ?? null;
  }

  newLayerCanvas() {
    return createCanvas(this.width, this.height);
  }

  makeLayer(name: string, canvas?: HTMLCanvasElement): Layer {
    return {
      id: uid('ly'),
      name,
      canvas: canvas ?? this.newLayerCanvas(),
      visible: true,
      locked: false,
      opacity: 1,
      fillOpacity: 1,
      blend: 'normal',
      clip: false,
      mask: null,
      maskEnabled: true,
      effects: DEFAULT_EFFECTS,
    };
  }

  nextLayerName(base = 'Слой') {
    let n = this.layers.length + 1;
    while (this.layers.some((l) => l.name === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  /**
   * То, что инструменты читают как «текущий слой»: пиксели или маска в виде
   * серого изображения (белое — видно), если включено редактирование маски.
   */
  editSource(layer: Layer): HTMLCanvasElement {
    if (!(this.editMask && layer.mask)) return layer.canvas;
    const c = this.grayCache;
    if (c && c.mask === layer.mask && c.rev === this.rev) return c.gray;
    const gray = maskToGray(layer.mask);
    this.grayCache = { mask: layer.mask, rev: this.rev, gray };
    return gray;
  }

  // ---------- история ----------

  private snapshot(): Snapshot {
    return {
      width: this.width,
      height: this.height,
      layers: this.layers,
      slices: this.slices,
      cuts: this.cuts,
      guides: this.guides,
      selection: this.selection,
      activeLayerId: this.activeLayerId,
    };
  }

  private restore(s: Snapshot) {
    this.width = s.width;
    this.height = s.height;
    this.layers = s.layers;
    this.slices = s.slices;
    this.cuts = s.cuts;
    this.guides = s.guides;
    this.selection = s.selection;
    this.activeLayerId = s.activeLayerId;
    if (this.activeSliceId && !this.slices.some((sl) => sl.id === this.activeSliceId)) this.activeSliceId = null;
  }

  private push(entry: HistoryEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.rev++;
  }

  /**
   * Структурное изменение (слои, размер, слайсы, выделение). Функция должна
   * заменять массивы/объекты, а не мутировать их, иначе снимок «до» испортится.
   */
  change(label: string, fn: () => void) {
    const before = this.snapshot();
    fn();
    const after = this.snapshot();
    this.push({ id: uid('h'), label, before, after });
  }

  /**
   * Выполняет fn над пикселями слоя (или над маской — через серое представление)
   * и возвращает патч области r для истории.
   */
  private edit(layer: Layer, r: Rect, fn: PixelFn): PixelPatch {
    const target = this.editMask && layer.mask ? 'mask' : 'pixels';
    const canvas = target === 'mask' ? layer.mask! : layer.canvas;
    const ctx = ctx2d(canvas);
    const before = ctx.getImageData(r.x, r.y, r.w, r.h);
    if (target === 'mask') {
      const gray = maskToGray(canvas);
      const g = ctx2d(gray);
      g.save();
      resetCtx(g);
      fn(g, { ...layer, canvas: gray });
      g.restore();
      ctx.putImageData(grayToMaskData(gray), 0, 0, r.x, r.y, r.w, r.h);
    } else {
      ctx.save();
      resetCtx(ctx);
      fn(ctx, layer);
      ctx.restore();
    }
    return { layerId: layer.id, target, rect: r, before, after: ctx.getImageData(r.x, r.y, r.w, r.h) };
  }

  /** Пиксельное изменение слоя в области rect (null = весь слой). */
  pixelEdit(layerId: string, rect: Rect | null, label: string, fn: PixelFn) {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    const full = { x: 0, y: 0, w: this.width, h: this.height };
    const r = rect ? intersectRect(rect, full) : full;
    if (!r) return;
    this.push({ id: uid('h'), label, patches: [this.edit(layer, r, fn)] });
  }

  /** Пиксельное изменение сразу нескольких слоёв одной записью истории. */
  multiPixelEdit(layerIds: string[], label: string, fn: PixelFn) {
    const r = { x: 0, y: 0, w: this.width, h: this.height };
    const patches: PixelPatch[] = [];
    for (const id of layerIds) {
      const layer = this.getLayer(id);
      if (layer) patches.push(this.edit(layer, r, fn));
    }
    if (patches.length) this.push({ id: uid('h'), label, patches });
  }

  /** Пиксели слоя + структурное изменение (например, выделение) одной записью истории. */
  compound(label: string, layerId: string, pixelFn: PixelFn, structFn: () => void) {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    const before = this.snapshot();
    const patch = this.edit(layer, { x: 0, y: 0, w: this.width, h: this.height }, pixelFn);
    structFn();
    this.push({ id: uid('h'), label, before, after: this.snapshot(), patches: [patch] });
  }

  private applyPatches(patches: PixelPatch[], which: 'before' | 'after') {
    for (const p of patches) {
      // canvas общий для всех версий объекта слоя, поэтому ищем по id в текущем состоянии
      const layer = this.getLayer(p.layerId);
      const canvas = p.target === 'mask' ? layer?.mask : layer?.canvas;
      if (canvas) ctx2d(canvas).putImageData(p[which], p.rect.x, p.rect.y);
    }
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    if (e.patches) this.applyPatches([...e.patches].reverse(), 'before');
    if (e.before) this.restore(e.before);
    this.redoStack.push(e);
    this.rev++;
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    if (e.after) this.restore(e.after);
    if (e.patches) this.applyPatches(e.patches, 'after');
    this.undoStack.push(e);
    this.rev++;
    return true;
  }

  /** Переход к состоянию после записи index в undoStack (-1 = исходное). */
  jumpTo(index: number) {
    while (this.undoStack.length - 1 > index && this.undo());
    while (this.undoStack.length - 1 < index && this.redo());
  }

  // ---------- операции со слоями ----------

  updateLayer(id: string, patch: Partial<Omit<Layer, 'id' | 'canvas'>>, label = 'Свойства слоя') {
    this.change(label, () => {
      this.layers = this.layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
    });
  }

  addLayer(layer: Layer, label = 'Новый слой', aboveId = this.activeLayerId) {
    this.change(label, () => {
      const idx = aboveId ? this.layerIndex(aboveId) : this.layers.length - 1;
      const layers = [...this.layers];
      layers.splice(idx + 1, 0, layer);
      this.layers = layers;
      this.activeLayerId = layer.id;
    });
    this.editMask = false;
  }

  removeLayer(id: string) {
    if (this.layers.length <= 1) return;
    this.change('Удалить слой', () => {
      const idx = this.layerIndex(id);
      this.layers = this.layers.filter((l) => l.id !== id);
      if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.max(0, idx - 1)]?.id ?? null;
    });
  }

  duplicateLayer(id: string) {
    const src = this.getLayer(id);
    if (!src) return;
    const copy: Layer = {
      ...src,
      id: uid('ly'),
      name: `${src.name} копия`,
      canvas: cloneCanvas(src.canvas),
      mask: src.mask ? cloneCanvas(src.mask) : null,
    };
    this.addLayer(copy, 'Дублировать слой', id);
  }

  moveLayer(id: string, toIndex: number) {
    const from = this.layerIndex(id);
    const to = Math.max(0, Math.min(this.layers.length - 1, toIndex));
    if (from < 0 || from === to) return;
    this.change('Порядок слоёв', () => {
      const layers = [...this.layers];
      const [l] = layers.splice(from, 1);
      layers.splice(to, 0, l);
      this.layers = layers;
    });
  }

  /**
   * Объединение с нижним: эффекты, маски и режимы «запекаются» в пиксели.
   * Обтравочные слои над верхним остаются обтравленными по результату.
   */
  mergeDown(id: string) {
    const idx = this.layerIndex(id);
    if (idx <= 0) return;
    const top = this.layers[idx];
    const bottom = this.layers[idx - 1];
    const merged = this.newLayerCanvas();
    const pair = [{ ...bottom, opacity: 1, blend: 'normal' as const, clip: false }, { ...top, clip: top.clip }];
    compositeLayers({ width: this.width, height: this.height, layers: pair, rev: this.rev }, ctx2d(merged));
    this.change('Объединить с нижним', () => {
      const layers = [...this.layers];
      layers.splice(idx - 1, 2, {
        ...this.makeLayer(bottom.name, merged),
        id: bottom.id,
        opacity: bottom.opacity,
        blend: bottom.blend,
        clip: bottom.clip,
        visible: bottom.visible,
      });
      this.layers = layers;
      this.activeLayerId = bottom.id;
    });
    this.editMask = false;
  }

  /** Сведённое изображение всех видимых слоёв (с эффектами, масками и обтравкой). */
  composite(opts: { includeHidden?: boolean } = {}): HTMLCanvasElement {
    const out = createCanvas(this.width, this.height);
    compositeLayers(this, ctx2d(out), opts);
    return out;
  }

  flatten() {
    const flat = this.composite();
    this.change('Выполнить сведение', () => {
      const layer = this.makeLayer('Фон', flat);
      this.layers = [layer];
      this.activeLayerId = layer.id;
    });
    this.editMask = false;
  }

  /**
   * Заменяет пиксели всех слоёв новыми canvas нового размера (кроп, размер холста,
   * поворот). mapCanvas получает старый canvas и возвращает новый; маски — тоже.
   */
  transformAll(label: string, w: number, h: number, mapCanvas: (c: HTMLCanvasElement) => HTMLCanvasElement, mapSlice?: (s: Slice) => Slice | null) {
    this.change(label, () => {
      this.layers = this.layers.map((l) => ({ ...l, canvas: mapCanvas(l.canvas), mask: l.mask ? mapCanvas(l.mask) : null }));
      this.width = w;
      this.height = h;
      this.selection = null;
      this.cuts = { x: [], y: [] };
      this.guides = { x: [], y: [] };
      if (mapSlice) this.slices = this.slices.map(mapSlice).filter((s): s is Slice => !!s);
    });
  }

  setSelection(sel: Selection | null, label = sel ? 'Выделение' : 'Снять выделение') {
    if (!sel && !this.selection) return;
    this.change(label, () => {
      this.selection = sel;
    });
  }

  // ---------- слайсы и раскрой ----------

  setSlices(slices: Slice[], label: string) {
    this.change(label, () => {
      this.slices = slices;
    });
  }

  updateSlice(id: string, patch: Partial<Slice>, label = 'Изменить слайс') {
    this.setSlices(this.slices.map((s) => (s.id === id ? { ...s, ...patch } : s)), label);
  }

  nextSliceName() {
    let n = this.slices.length + 1;
    while (this.slices.some((s) => s.name === `slice_${n}`)) n++;
    return `slice_${n}`;
  }

  setGuides(guides: Cuts, label: string) {
    const norm = (a: number[]) => [...new Set(a.map(Math.round))].sort((p, q) => p - q);
    this.change(label, () => {
      this.guides = { x: norm(guides.x), y: norm(guides.y) };
    });
  }

  setCuts(cuts: Cuts, label: string) {
    const norm = (a: number[], max: number) => [...new Set(a.map(Math.round))].filter((v) => v > 0 && v < max).sort((p, q) => p - q);
    this.change(label, () => {
      this.cuts = { x: norm(cuts.x, this.width), y: norm(cuts.y, this.height) };
    });
  }
}

export { blendToComposite };
