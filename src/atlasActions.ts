import {
  detectAnimations, encodeProject, exportAtlasFiles, makeSprite, newAtlasState, PROJECT_EXT, rememberExport, splitSpritePath, uniqueSpriteName,
  type AtlasState,
} from './core/atlas';
import { isAtlas, newAtlasDoc, replaceSpriteImage, syncAtlas, updateAtlas } from './core/atlasDoc';
import { alphaBounds, cloneCanvas, cropCanvas } from './core/canvas';
import { renderLayer } from './core/composite';
import type { NineSlice } from './core/types';
import { Doc } from './core/doc';
import { writeFiles } from './core/export';
import { decodeFile, decodeToCanvas, encodePsd, fileStem } from './core/io';
import { baseName, isTauri, openFiles, saveFileAs, writePath, type LoadedFile } from './core/platform';
import { activeDoc, app, toast, useApp } from './store';
import { changed } from './tools/base';
import { addDoc, switchDoc } from './actions';

/** Действия редактора атласов (документ kind: 'atlas'). */

const IMAGE_FILTERS = [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'psd', 'tif', 'tiff', 'tga'] }];
export const PROJECT_FILTERS = [{ name: 'Проект PixelYard', extensions: [PROJECT_EXT] }];

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
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

export interface NewSprite {
  name: string;
  folder?: string;
  image: HTMLCanvasElement;
  source?: Uint8Array | null;
  nine?: NineSlice | null;
}

/** Документы-атласы, открытые сейчас. */
export const atlasDocs = () => app().docs.filter((d) => isAtlas(d));

function withSprites(state: AtlasState, list: NewSprite[]): AtlasState {
  let next = state;
  for (const it of list) {
    const folder = it.folder ?? '';
    const sp = { ...makeSprite(uniqueSpriteName(next, it.name, folder), it.image, folder), source: it.source ?? null, nine: it.nine ?? null };
    next = { ...next, sprites: [...next.sprites, sp] };
  }
  return next;
}

export function newAtlasAction(list: NewSprite[] = [], name = 'atlas') {
  const state = withSprites(newAtlasState(), list);
  const doc = newAtlasDoc(`${name}.${PROJECT_EXT}`, { ...state, animations: detectAnimations(state) });
  addDoc(doc);
  return doc;
}

export function addSpritesAction(doc: Doc, list: NewSprite[]) {
  if (!isAtlas(doc) || !list.length) return;
  const before = new Set(doc.atlas.sprites.map((s) => s.id));
  updateAtlas(doc, list.length > 1 ? `Добавить спрайты (${list.length})` : 'Добавить спрайт', (a) => withSprites(a, list));
  doc.atlasSel = doc.atlas.sprites.filter((s) => !before.has(s.id)).map((s) => s.id);
  changed();
}

async function spritesFromFiles(files: LoadedFile[]): Promise<NewSprite[]> {
  const out: NewSprite[] = [];
  for (const f of files) {
    const { name, folder } = splitSpritePath(f.name);
    const isPsd = /\.psd$/i.test(f.name);
    out.push({ name, folder, image: await decodeToCanvas(f), source: isPsd ? f.data : null });
  }
  return out;
}

/** Файлы → спрайты активного атласа (или новый атлас). */
export async function addSpriteFiles(files?: LoadedFile[], target = activeDoc()) {
  const list = files ?? (await openFiles(IMAGE_FILTERS));
  if (!list.length) return;
  await busy('Добавление спрайтов…', async () => {
    const sprites = await spritesFromFiles(list);
    if (target && isAtlas(target)) addSpritesAction(target, sprites);
    else newAtlasAction(sprites);
  });
}

/** Новый атлас из картинок с диска. */
export async function newAtlasFromFiles() {
  const list = await openFiles(IMAGE_FILTERS);
  if (!list.length) return;
  await busy('Создание атласа…', async () => newAtlasAction(await spritesFromFiles(list)));
}

/** Спрайты из слоёв или слайсов картинки. */
export function spritesFromDoc(src: Doc, what: 'layers' | 'slices' | 'merged'): NewSprite[] {
  if (what === 'merged') return [{ name: fileStem(src.name), image: src.composite() }];
  if (what === 'slices') {
    const flat = src.composite();
    return src.slices.map((s) => ({ name: s.name, image: cropCanvas(flat, s), nine: s.nine }));
  }
  return src.layers
    .filter((l) => l.visible)
    .map((l) => {
      const c = renderLayer(l, src.rev);
      const b = alphaBounds(c);
      return b ? { name: l.name.replace(/\s*\/\s*/g, '/'), image: cropCanvas(c, b) } : null;
    })
    .filter((x): x is NewSprite => !!x)
    .map((s) => ({ ...s, ...splitSpritePath(s.name) }))
    .reverse();
}

/** Из слоёв/слайсов открытой картинки — в выбранный атлас или в новый. */
export function spritesFromDocAction(src: Doc, what: 'layers' | 'slices' | 'merged', targetId: string | null) {
  const list = spritesFromDoc(src, what);
  if (!list.length) return toast(what === 'slices' ? 'В документе нет слайсов' : 'Нечего добавить', 'error');
  const target = targetId ? app().docs.find((d) => d.id === targetId) : null;
  if (target && isAtlas(target)) {
    addSpritesAction(target, list);
    switchDoc(target.id);
  } else {
    newAtlasAction(list, fileStem(src.name));
  }
  changed();
}

export function removeSpritesAction(doc: Doc, ids: string[]) {
  const set = new Set(ids);
  updateAtlas(doc, ids.length > 1 ? `Удалить спрайты (${ids.length})` : 'Удалить спрайт', (a) => ({
    ...a,
    sprites: a.sprites.filter((s) => !set.has(s.id)),
    animations: a.animations.map((an) => ({ ...an, frames: an.frames.filter((f) => !set.has(f)) })),
  }));
  doc.atlasSel = [];
  changed();
}

// ---------- правка спрайта в отдельной вкладке ----------

const linkedOf = (atlasId: string, spriteId: string) => app().docs.find((d) => d.link?.atlasDocId === atlasId && d.link.spriteId === spriteId) ?? null;

export async function editSpriteAction(doc: Doc, spriteId: string) {
  if (!isAtlas(doc)) return;
  const open = linkedOf(doc.id, spriteId);
  if (open) return switchDoc(open.id);
  const sp = doc.atlas.sprites.find((s) => s.id === spriteId);
  if (!sp) return;
  await busy('Открытие спрайта…', async () => {
    let d: Doc;
    if (sp.source) d = await decodeFile({ name: `${sp.name}.psd`, data: sp.source, path: null });
    else {
      d = new Doc(`${sp.name}.png`, sp.image.width, sp.image.height);
      const layer = d.makeLayer(sp.name, cloneCanvas(sp.image));
      d.layers = [layer];
      d.activeLayerId = layer.id;
    }
    d.path = null;
    d.name = sp.name;
    d.link = { atlasDocId: doc.id, spriteId };
    addDoc(d);
  });
}

const synced = new WeakMap<Doc, number>();
let linkTimer = 0;

/** Переносит правки связанной вкладки в атлас (композит → картинка спрайта). */
function flushLinked(d: Doc, withSource = false) {
  const link = d.link;
  if (!link) return;
  const atlas = app().docs.find((x) => x.id === link.atlasDocId);
  if (!atlas || !isAtlas(atlas)) return;
  if (synced.get(d) !== d.rev) {
    synced.set(d, d.rev);
    replaceSpriteImage(atlas, link.spriteId, d.composite());
    changed();
  }
  if (withSource) {
    const src = encodePsd(d);
    atlas.patchAtlasEverywhere((a) => ({ ...a, sprites: a.sprites.map((s) => (s.id === link.spriteId ? { ...s, source: src } : s)) }));
  }
  d.savedRev = d.rev;
}

/** Перед закрытием связанной вкладки: картинка и слои остаются в атласе. */
export function detachLinked(d: Doc) {
  flushLinked(d, true);
  syncAll();
}

function syncAll() {
  let any = false;
  for (const d of app().docs) if (isAtlas(d) && syncAtlas(d)) any = true;
  if (any) changed();
}

/** Подписка: перепаковка атласов после правок/отмены и перенос правок связанных вкладок. */
export function installAtlasSync() {
  let scheduled = false;
  return useApp.subscribe((s, prev) => {
    if (s.tick === prev.tick) return;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        syncAll();
      });
    }
    const pending = s.docs.filter((d) => d.link && synced.get(d) !== d.rev && d.preview === null);
    if (pending.length) {
      clearTimeout(linkTimer);
      linkTimer = window.setTimeout(() => {
        for (const d of pending) if (app().docs.includes(d)) flushLinked(d);
        syncAll();
      }, 150);
    }
  });
}

// ---------- проект и выгрузка ----------

/** Сохранение атласа в .pyard (с многослойными исходниками открытых вкладок). */
export async function saveAtlasProject(doc: Doc, as = false) {
  if (!isAtlas(doc)) return;
  await busy('Сохранение проекта…', async () => {
    const sources = new Map<string, Uint8Array>();
    for (const d of app().docs) {
      if (d.link?.atlasDocId !== doc.id) continue;
      flushLinked(d);
      sources.set(d.link.spriteId, encodePsd(d));
    }
    syncAtlas(doc);
    const name = fileStem(doc.name);
    const data = await encodeProject(doc.atlas, name, sources);
    let path: string | null = !as && isTauri ? doc.path : null;
    if (path) await writePath(path, data);
    else {
      path = await saveFileAs(`${name}.${PROJECT_EXT}`, data, PROJECT_FILTERS);
      if (!path) return;
      doc.path = isTauri ? path : null;
      doc.name = baseName(path);
    }
    doc.savedRev = doc.rev;
    toast(`Проект сохранён: ${doc.name}`);
    changed();
  });
}

export async function exportAtlasAction(doc: Doc | null = activeDoc()) {
  if (!doc || !isAtlas(doc)) return;
  const state = doc.atlas;
  rememberExport(state.export);
  await busy('Выгрузка атласа…', async () => {
    const files = await exportAtlasFiles(state, fileStem(doc.name), (done, total) => useApp.setState({ busy: `Выгрузка атласа… ${done}/${total}` }));
    useApp.setState({ busy: null });
    const res = await writeFiles(files, state.export.name || fileStem(doc.name), state.export.output === 'zip');
    if (res) toast(`Выгружено файлов: ${res.files} → ${baseName(res.target)}`);
  });
}

/** Атлас, связанный с документом (сам атлас или атлас связанной вкладки). */
export function ownerAtlas(doc: Doc | null): Doc | null {
  if (!doc) return null;
  if (isAtlas(doc)) return doc;
  const id = doc.link?.atlasDocId;
  return id ? app().docs.find((d) => d.id === id) ?? null : null;
}
