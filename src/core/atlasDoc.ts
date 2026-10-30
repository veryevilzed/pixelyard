import { buildAtlas, newAtlasState, type AtlasSprite, type AtlasState } from './atlas';
import { Doc } from './doc';
import type { PackedFrame } from './pack';

/**
 * Атлас-документ: doc.atlas (в истории) → упаковка → слой «Атлас» с текущей страницей.
 * Слой и размер документа пересобираются из состояния, поэтому вкладки, сплит, зум и навигатор
 * работают как с обычной картинкой.
 */

export function isAtlas(doc: Doc | null | undefined): doc is Doc & { atlas: AtlasState } {
  return !!doc && doc.kind === 'atlas' && !!doc.atlas;
}

export function newAtlasDoc(name: string, state: AtlasState = newAtlasState()): Doc {
  const doc = new Doc(name, 64, 64);
  doc.kind = 'atlas';
  doc.atlas = state;
  syncAtlas(doc);
  return doc;
}

/** Пересобирает упаковку, если состояние сменилось; восстанавливает слой страницы. true — что-то поменялось. */
export function syncAtlas(doc: Doc): boolean {
  if (!isAtlas(doc)) return false;
  let changed = false;
  if (doc.atlasBuiltFor !== doc.atlas) {
    doc.atlasBuiltFor = doc.atlas;
    try {
      doc.atlasPack = buildAtlas(doc.atlas);
      doc.atlasError = null;
    } catch (e) {
      doc.atlasError = e instanceof Error ? e.message : String(e);
    }
    const ids = new Set(doc.atlas.sprites.map((s) => s.id));
    doc.atlasSel = doc.atlasSel.filter((id) => ids.has(id));
    doc.atlasLayer = null;
    changed = true;
  }
  const pages = doc.atlasPack?.pages ?? [];
  const page = Math.max(0, Math.min(doc.atlasPage, pages.length - 1));
  if (page !== doc.atlasPage) doc.atlasPage = page;
  const pg = pages[page];
  if (pg && (!doc.atlasLayer || doc.atlasLayer.canvas !== pg.canvas)) {
    doc.atlasLayer = { ...doc.makeLayer('Атлас', pg.canvas), locked: true };
    changed = true;
  }
  if (doc.atlasLayer && (doc.layers.length !== 1 || doc.layers[0] !== doc.atlasLayer)) {
    doc.layers = [doc.atlasLayer];
    doc.activeLayerId = doc.atlasLayer.id;
    changed = true;
  }
  if (pg && (doc.width !== pg.width || doc.height !== pg.height)) {
    doc.width = pg.width;
    doc.height = pg.height;
    changed = true;
  }
  doc.selection = null;
  return changed;
}

export function setAtlasPage(doc: Doc, page: number) {
  doc.atlasPage = page;
  syncAtlas(doc);
}

/** Изменение атласа одной записью истории. */
export function updateAtlas(doc: Doc, label: string, fn: (s: AtlasState) => AtlasState) {
  if (!isAtlas(doc)) return;
  const next = fn(doc.atlas);
  if (next === doc.atlas) return;
  doc.change(label, () => {
    doc.atlas = next;
  });
  syncAtlas(doc);
}

/** Изменение свойств спрайтов (по id) одной записью истории. */
export function updateSprites(doc: Doc, ids: string[], patch: Partial<AtlasSprite> | ((s: AtlasSprite) => Partial<AtlasSprite>), label = 'Свойства спрайта') {
  const set = new Set(ids);
  updateAtlas(doc, label, (a) => ({
    ...a,
    sprites: a.sprites.map((s) => (set.has(s.id) ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)),
  }));
}

/** Новая картинка спрайта из связанной вкладки — без записи в историю атласа. */
export function replaceSpriteImage(doc: Doc, spriteId: string, image: HTMLCanvasElement) {
  if (!isAtlas(doc)) return;
  doc.patchAtlasEverywhere((a) => (a.sprites.some((s) => s.id === spriteId) ? { ...a, sprites: a.sprites.map((s) => (s.id === spriteId ? { ...s, image } : s)) } : a));
  syncAtlas(doc);
}

/** Кадры текущей страницы. */
export function pageFrames(doc: Doc): PackedFrame[] {
  return doc.atlasPack?.pages[doc.atlasPage]?.frames.filter((f) => f.w > 0) ?? [];
}

/** Прямоугольник кадра в атласе (с учётом поворота). */
export function frameRect(f: PackedFrame) {
  return { x: f.x, y: f.y, w: f.rotated ? f.h : f.w, h: f.rotated ? f.w : f.h };
}

export function spriteIdOf(f: PackedFrame) {
  return String(f.extra?.spriteId ?? '');
}

/** Спрайт под точкой (координаты документа). */
export function frameAt(doc: Doc, x: number, y: number): PackedFrame | null {
  const list = pageFrames(doc);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = frameRect(list[i]);
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return list[i];
  }
  return null;
}

/** Кадр спрайта (на любой странице). */
export function frameOf(doc: Doc, spriteId: string): PackedFrame | null {
  return doc.atlasPack?.frames.find((f) => spriteIdOf(f) === spriteId) ?? null;
}

export function selectedSprites(doc: Doc): AtlasSprite[] {
  if (!isAtlas(doc)) return [];
  const set = new Set(doc.atlasSel);
  return doc.atlas.sprites.filter((s) => set.has(s.id));
}
