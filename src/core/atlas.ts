import { unzipSync, zipSync } from 'fflate';
import { createCanvas, scaleCanvas, uid } from './canvas';
import { customToDef, describeAtlas, loadCustomFormats, pageBase, SPRITE_FORMATS, type FormatDef } from './atlasFormats';
import { decodeBrowserImage, encodeCanvas } from './io';
import { packPages, trimSprite, type PackAlgorithm, type PackHeuristic, type PackInput, type PackResult, type PackSort, type RotationDir } from './pack';
import type { NineSlice } from './types';

/**
 * Атлас как документ: спрайты со своими настройками, параметры упаковки и выгрузки,
 * анимации. Состояние неизменяемо — любая правка создаёт новый объект (так работает история).
 */

export interface AtlasSprite {
  id: string;
  name: string;
  /** Папка: '' или 'ui/buttons'. */
  folder: string;
  /** Полное изображение кадра (композит исходника). Правка — новый объект. */
  image: HTMLCanvasElement;
  /** Многослойный исходник (PSD) из файла проекта; живой исходник — связанная вкладка. */
  source: Uint8Array | null;
  /** Свой множитель масштаба. */
  scale: number;
  trim: 'inherit' | 'on' | 'off';
  /** null — общий. */
  extrude: number | null;
  /** Можно ли поворачивать (если вращение включено в атласе). */
  rotate: boolean;
  /** Опорная точка 0..1. */
  pivotX: number;
  pivotY: number;
  nine: NineSlice | null;
}

export type AnimMode = 'loop' | 'once' | 'pingpong';

export interface AtlasAnimation {
  id: string;
  name: string;
  fps: number;
  mode: AnimMode;
  /** id спрайтов по порядку. */
  frames: string[];
}

export interface AtlasSettings {
  maxSize: number;
  pot: boolean;
  square: boolean;
  spacing: number;
  border: number;
  extrude: number;
  trim: boolean;
  allowRotation: boolean;
  algorithm: PackAlgorithm;
  heuristic: PackHeuristic;
  sort: PackSort;
  multipage: boolean;
  /** Имя кадра с путём папки: ui/button. */
  includeFolder: boolean;
}

export type AtlasImageFormat = 'png' | 'webp' | 'jpg';

export interface AtlasScale {
  scale: number;
  suffix: string;
  enabled: boolean;
}

export interface AtlasExport {
  /** Имя файлов без расширения (пусто — по имени проекта). */
  name: string;
  formatId: string;
  imageFormat: AtlasImageFormat;
  quality: number;
  scales: AtlasScale[];
  smoothScale: boolean;
  output: 'folder' | 'zip';
}

export interface AtlasState {
  sprites: AtlasSprite[];
  animations: AtlasAnimation[];
  settings: AtlasSettings;
  export: AtlasExport;
}

export const DEFAULT_ATLAS_SETTINGS: AtlasSettings = {
  maxSize: 2048,
  pot: true,
  square: false,
  spacing: 2,
  border: 0,
  extrude: 0,
  trim: true,
  allowRotation: false,
  algorithm: 'best',
  heuristic: 'short-side',
  sort: 'auto',
  multipage: true,
  includeFolder: false,
};

export const DEFAULT_SCALES: AtlasScale[] = [
  { scale: 0.5, suffix: '@0.5x', enabled: false },
  { scale: 1, suffix: '', enabled: true },
  { scale: 2, suffix: '@2x', enabled: false },
  { scale: 4, suffix: '@4x', enabled: false },
];

const BASE_EXPORT: AtlasExport = {
  name: '',
  formatId: 'tp-hash',
  imageFormat: 'png',
  quality: 92,
  scales: DEFAULT_SCALES,
  smoothScale: true,
  output: 'folder',
};

const EXPORT_KEY = 'pixelyard.atlasExport';

/** Последние настройки выгрузки — стартовые для новых атласов. */
export function rememberedExport(): AtlasExport {
  try {
    const v = JSON.parse(localStorage.getItem(EXPORT_KEY) ?? 'null') as Partial<AtlasExport> | null;
    return { ...BASE_EXPORT, ...(v ?? {}), name: '' };
  } catch {
    return BASE_EXPORT;
  }
}

export function rememberExport(e: AtlasExport) {
  localStorage.setItem(EXPORT_KEY, JSON.stringify({ ...e, name: '' }));
}

export function newAtlasState(sprites: AtlasSprite[] = []): AtlasState {
  return { sprites, animations: [], settings: DEFAULT_ATLAS_SETTINGS, export: rememberedExport() };
}

export function makeSprite(name: string, image: HTMLCanvasElement, folder = ''): AtlasSprite {
  return { id: uid('sp'), name, folder, image, source: null, scale: 1, trim: 'inherit', extrude: null, rotate: true, pivotX: 0.5, pivotY: 0.5, nine: null };
}

/** Имя файла картинки → имя спрайта и папка: «ui/btn_ok.png» → { folder: 'ui', name: 'btn_ok' }. */
export function splitSpritePath(path: string): { folder: string; name: string } {
  const parts = path.replace(/\\/g, '/').replace(/\.[^./]+$/, '').split('/').filter(Boolean);
  const name = parts.pop() ?? 'sprite';
  return { folder: parts.join('/'), name };
}

export function frameName(s: AtlasSprite, o: AtlasSettings) {
  return o.includeFolder && s.folder ? `${s.folder}/${s.name}` : s.name;
}

/** Уникальное имя внутри атласа (с учётом папки). */
export function uniqueSpriteName(state: AtlasState, name: string, folder: string, exceptId?: string) {
  const taken = new Set(state.sprites.filter((s) => s.id !== exceptId && s.folder === folder).map((s) => s.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}_${n}`)) n++;
  return `${name}_${n}`;
}

// ---------- форматы ----------

export function allSpriteFormats(): FormatDef[] {
  return [...SPRITE_FORMATS, ...loadCustomFormats().filter((c) => c.kind === 'sprites').map(customToDef)];
}

export function atlasFormat(state: AtlasState): FormatDef {
  const id = state.export.formatId;
  return SPRITE_FORMATS.find((f) => f.id === id) ?? allSpriteFormats().find((f) => f.id === id) ?? SPRITE_FORMATS[0];
}

export const IMAGE_EXT: Record<AtlasImageFormat, string> = { png: 'png', webp: 'webp', jpg: 'jpg' };

// ---------- сборка ----------

// масштабированные копии: исходник → (ключ масштаба → холст)
const scaledCache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

function scaled(img: HTMLCanvasElement, s: number, smooth: boolean) {
  if (s === 1) return img;
  const key = `${s}:${smooth}`;
  let m = scaledCache.get(img);
  if (!m) scaledCache.set(img, (m = new Map()));
  let c = m.get(key);
  if (!c) {
    c = scaleCanvas(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), smooth);
    m.set(key, c);
  }
  return c;
}

/** Номер кадра в анимации — libGDX/Spine `index`. */
function animIndex(state: AtlasState) {
  const m = new Map<string, { i: number; name: string }>();
  for (const a of state.animations) a.frames.forEach((id, i) => m.has(id) || m.set(id, { i, name: a.name }));
  return m;
}

/** Входные данные упаковщика в порядке state.sprites (frame.index = индекс спрайта). */
export function atlasPackInputs(state: AtlasState, scale: number): PackInput[] {
  const o = state.settings;
  const idx = animIndex(state);
  return state.sprites.map((sp) => {
    const k = scale * sp.scale;
    const img = scaled(sp.image, k, state.export.smoothScale);
    const trim = sp.trim === 'inherit' ? o.trim : sp.trim === 'on';
    const extra: Record<string, number | string> = { spriteId: sp.id, pivotX: sp.pivotX, pivotY: sp.pivotY };
    if (sp.nine) Object.assign(extra, { nineL: Math.round(sp.nine.left * k), nineT: Math.round(sp.nine.top * k), nineR: Math.round(sp.nine.right * k), nineB: Math.round(sp.nine.bottom * k) });
    const an = idx.get(sp.id);
    if (an) Object.assign(extra, { index: an.i, anim: an.name });
    const name = frameName(sp, o);
    const base = trimSprite(name, img, trim, extra) ?? { name, canvas: createCanvas(0, 0), offX: 0, offY: 0, srcW: img.width, srcH: img.height, extra };
    return { ...base, noRotate: !sp.rotate, extrude: sp.extrude ?? undefined };
  });
}

/** Упаковка атласа в заданном масштабе. Вращение и его направление — по формату. */
export function buildAtlas(state: AtlasState, scale = 1, format = atlasFormat(state)): PackResult {
  const o = state.settings;
  if (!state.sprites.length) {
    const c = createCanvas(64, 64);
    return { pages: [{ canvas: c, width: 64, height: 64, frames: [] }], frames: [], canvas: c, width: 64, height: 64 };
  }
  const rotationDir: RotationDir = format.rotation === 'ccw' ? 'ccw' : 'cw';
  return packPages(atlasPackInputs(state, scale), {
    maxSize: o.maxSize,
    spacing: o.spacing,
    border: o.border,
    extrude: o.extrude,
    pot: o.pot,
    square: o.square,
    allowRotation: o.allowRotation && format.rotation !== false,
    algorithm: o.algorithm,
    heuristic: o.heuristic,
    sort: o.sort,
    multipage: o.multipage,
    rotationDir,
  });
}

/** Доля полезной площади страницы. */
export function pageFill(p: PackResult['pages'][number]) {
  const used = p.frames.reduce((s, f) => s + f.w * f.h, 0);
  return used / Math.max(1, p.width * p.height);
}

// ---------- выгрузка ----------

/** Данные анимаций для форматов (имена кадров уже с учётом папок). */
export function animationData(state: AtlasState) {
  const byId = new Map(state.sprites.map((s) => [s.id, s]));
  return state.animations
    .map((a) => ({
      name: a.name,
      nameJson: JSON.stringify(a.name),
      fps: a.fps,
      mode: a.mode,
      loop: a.mode !== 'once',
      pingpong: a.mode === 'pingpong',
      frames: a.frames.filter((id) => byId.has(id)).map((id) => ({ name: frameName(byId.get(id)!, state.settings) })),
    }))
    .filter((a) => a.frames.length);
}

/** Все файлы выгрузки: страницы во всех включённых масштабах + описания + доп. файлы формата. */
export async function exportAtlasFiles(state: AtlasState, projectName: string, onProgress?: (done: number, total: number) => void): Promise<Record<string, Uint8Array>> {
  const e = state.export;
  const format = atlasFormat(state);
  const name = (e.name || projectName || 'atlas').replace(/[\\/:*?"<>|]+/g, '_');
  const scales = e.scales.filter((s) => s.enabled);
  if (!scales.length) throw new Error('Не выбран ни один масштаб выгрузки');
  if (!state.sprites.length) throw new Error('В атласе нет спрайтов');
  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  let done = 0;
  for (const s of scales) {
    const res = buildAtlas(state, s.scale, format);
    const base = `${name}${s.suffix}`;
    const n = res.pages.length;
    const pages = res.pages.map((p, i) => ({ image: `${pageBase(base, i, n)}.${IMAGE_EXT[e.imageFormat]}`, width: p.width, height: p.height, frames: p.frames }));
    for (let i = 0; i < n; i++) files[pages[i].image] = await encodeCanvas(res.pages[i].canvas, e.imageFormat, e.quality);
    const anims = animationData(state);
    for (const [fn, text] of Object.entries(describeAtlas(format, pages, base, s.scale, { animations: anims }))) files[fn] = enc.encode(text);
    onProgress?.(++done, scales.length);
  }
  return files;
}

// ---------- файл проекта .pyard ----------

export const PROJECT_EXT = 'pyard';

interface ProjectSprite extends Omit<AtlasSprite, 'image' | 'source'> {
  file: string;
  source?: string;
}

interface ProjectJson {
  format: 'pixelyard';
  kind: 'atlas';
  version: 1;
  name: string;
  app: string;
  settings: AtlasSettings;
  export: AtlasExport;
  animations: AtlasAnimation[];
  sprites: ProjectSprite[];
}

/**
 * Упаковывает проект в zip: project.json + sprites/<id>.png + sources/<id>.psd.
 * sources — актуальные многослойные исходники (из открытых связанных вкладок), иначе берётся sprite.source.
 */
export async function encodeProject(state: AtlasState, name: string, sources: Map<string, Uint8Array> = new Map()): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const sprites: ProjectSprite[] = [];
  for (const sp of state.sprites) {
    const { image, source, ...rest } = sp;
    const file = `sprites/${sp.id}.png`;
    files[file] = await encodeCanvas(image, 'png');
    const src = sources.get(sp.id) ?? source;
    let srcFile: string | undefined;
    if (src) {
      srcFile = `sources/${sp.id}.psd`;
      files[srcFile] = src;
    }
    sprites.push({ ...rest, file, ...(srcFile ? { source: srcFile } : {}) });
  }
  const json: ProjectJson = { format: 'pixelyard', kind: 'atlas', version: 1, name, app: 'PixelYard', settings: state.settings, export: state.export, animations: state.animations, sprites };
  files['project.json'] = new TextEncoder().encode(JSON.stringify(json, null, 2));
  return zipSync(files, { level: 6 });
}

export async function decodeProject(data: Uint8Array): Promise<{ name: string; state: AtlasState }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('Файл проекта повреждён (не zip)');
  }
  const raw = files['project.json'];
  if (!raw) throw new Error('В файле нет project.json — это не проект PixelYard');
  const json = JSON.parse(new TextDecoder().decode(raw)) as ProjectJson;
  if (json.format !== 'pixelyard' || json.kind !== 'atlas') throw new Error('Неизвестный тип проекта');
  if (json.version > 1) throw new Error('Проект создан более новой версией PixelYard');
  const sprites: AtlasSprite[] = [];
  for (const p of json.sprites) {
    const bytes = files[p.file];
    const image = bytes ? await decodeBrowserImage(bytes, 'png') : createCanvas(1, 1);
    const { file: _f, source: srcName, ...rest } = p;
    sprites.push({ ...makeSprite(p.name, image), ...rest, image, source: srcName ? files[srcName] ?? null : null });
  }
  return {
    name: json.name,
    state: {
      sprites,
      animations: json.animations ?? [],
      settings: { ...DEFAULT_ATLAS_SETTINGS, ...json.settings },
      export: { ...BASE_EXPORT, ...json.export },
    },
  };
}

/** Автоматические анимации по суффиксу номера: run_0, run_1… → «run». */
export function detectAnimations(state: AtlasState): AtlasAnimation[] {
  const groups = new Map<string, { n: number; id: string }[]>();
  for (const s of state.sprites) {
    const m = /^(.*?)[_\-. ]?(\d+)$/.exec(s.name);
    if (!m || !m[1]) continue;
    const key = (s.folder ? s.folder + '/' : '') + m[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ n: Number(m[2]), id: s.id });
  }
  const have = new Set(state.animations.map((a) => a.name));
  const out: AtlasAnimation[] = [];
  for (const [name, list] of groups) {
    if (list.length < 2 || have.has(name)) continue;
    list.sort((a, b) => a.n - b.n);
    out.push({ id: uid('an'), name, fps: 12, mode: 'loop', frames: list.map((x) => x.id) });
  }
  return out;
}
