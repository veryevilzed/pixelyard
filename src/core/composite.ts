import { alphaBounds, createCanvas, ctx2d, rgbaToCss } from './canvas';
import { dilateAlpha } from './filters';
import { tiled, usePatterns } from './patterns';
import { hasEffects, type BlendMode, type GlowFx, type Layer, type LayerEffects, type LayerGroup, type Rect, type ShadowFx } from './types';

export function blendToComposite(b: BlendMode): GlobalCompositeOperation {
  return b === 'normal' ? 'source-over' : (b as GlobalCompositeOperation);
}

// ---------- маска слоя: альфа ↔ градации серого ----------

/** Маска в виде непрозрачного серого изображения (белое = видно) — в нём рисуют инструменты. */
export function maskToGray(mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(mask.width, mask.height);
  const src = ctx2d(mask).getImageData(0, 0, mask.width, mask.height);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    d[i] = d[i + 1] = d[i + 2] = a;
    d[i + 3] = 255;
  }
  ctx2d(out).putImageData(src, 0, 0);
  return out;
}

/** Обратно: яркость (с учётом прозрачности) → альфа маски. */
export function grayToMaskData(gray: HTMLCanvasElement): ImageData {
  const img = ctx2d(gray).getImageData(0, 0, gray.width, gray.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255);
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = lum;
  }
  return img;
}

export function grayToMask(gray: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(gray.width, gray.height);
  ctx2d(out).putImageData(grayToMaskData(gray), 0, 0);
  return out;
}

// ---------- эффекты ----------

const BIG = 100000; // смещение для отрисовки «только тени»

function withAlpha(c: [number, number, number, number], opacity: number) {
  return rgbaToCss([c[0], c[1], c[2], Math.round((c[3] * opacity) / 100)]);
}

/** Силуэт (альфа источника), расширенный на spread% от size — основа теней и свечений. */
function silhouette(src: HTMLCanvasElement, size: number, spread: number): HTMLCanvasElement {
  const grow = Math.round((size * spread) / 100);
  if (grow <= 0) return src;
  const w = src.width, h = src.height;
  const d = ctx2d(src).getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = d[i * 4 + 3];
  const cov = dilateAlpha(alpha, w, h, grow);
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = Math.max(alpha[i], cov[i] * 255);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Рисует только тень формы shape (без самой формы). */
function drawShadowOnly(ctx: CanvasRenderingContext2D, shape: HTMLCanvasElement, color: string, blur: number, dx: number, dy: number) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = dx + BIG;
  ctx.shadowOffsetY = dy;
  ctx.drawImage(shape, -BIG, 0);
  ctx.restore();
}

function shadowOffset(fx: ShadowFx) {
  // угол — откуда светит свет, тень падает в противоположную сторону
  const a = (fx.angle * Math.PI) / 180;
  return { dx: -Math.cos(a) * fx.distance, dy: Math.sin(a) * fx.distance };
}

/** Инверсия формы в пределах рамки (для внутренних теней/свечений). */
function inverse(shape: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const out = createCanvas(shape.width + pad * 2, shape.height + pad * 2);
  const ctx = ctx2d(out);
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(shape, pad, pad);
  return out;
}

function strokeRing(shape: HTMLCanvasElement, size: number, position: 'outside' | 'inside' | 'center'): HTMLCanvasElement {
  const w = shape.width, h = shape.height;
  const d = ctx2d(shape).getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  const inv = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = d[i * 4 + 3];
    inv[i] = 255 - alpha[i];
  }
  const outer = position === 'inside' ? 0 : position === 'center' ? size / 2 : size;
  const inner = position === 'outside' ? 0 : position === 'center' ? size / 2 : size;
  const grown = outer > 0 ? dilateAlpha(alpha, w, h, outer) : null;
  const shrunkInv = inner > 0 ? dilateAlpha(inv, w, h, inner) : null;
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i] / 255;
    // снаружи: расширение минус сама форма; внутри: форма минус её сжатие
    const outside = grown ? Math.max(0, Math.max(grown[i], a) - a) : 0;
    const inside = shrunkInv ? Math.min(a, Math.max(shrunkInv[i], 1 - a)) : 0;
    img.data[i * 4 + 3] = Math.min(1, outside + inside) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function margin(e: LayerEffects) {
  let m = 0;
  if (e.dropShadow.enabled) m = Math.max(m, e.dropShadow.distance + e.dropShadow.size * 2);
  if (e.outerGlow.enabled) m = Math.max(m, e.outerGlow.size * 2);
  if (e.stroke.enabled) m = Math.max(m, e.stroke.size + 2);
  return Math.ceil(m) + 2;
}

function glowColor(fx: GlowFx) {
  return withAlpha(fx.color, fx.opacity);
}

/**
 * Пиксели слоя с маской, непрозрачностью заливки и эффектами — в canvas размером
 * с документ. Тяжёлые операции выполняются только в рамке содержимого.
 */
export function renderLayerContent(layer: Layer, src: HTMLCanvasElement, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const fx = layer.effects;
  const useMask = !!mask && layer.maskEnabled;
  const effects = hasEffects(fx);
  if (!useMask && !effects && layer.fillOpacity >= 1) return src;
  const W = src.width, H = src.height;
  let content = src;
  if (useMask) {
    content = createCanvas(W, H);
    const c = ctx2d(content);
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask!, 0, 0);
  }
  if (!effects) {
    if (layer.fillOpacity >= 1) return content;
    const out = createCanvas(W, H);
    const o = ctx2d(out);
    o.globalAlpha = layer.fillOpacity;
    o.drawImage(content, 0, 0);
    return out;
  }
  const b = alphaBounds(content);
  if (!b) return content;
  const m = margin(fx);
  const r: Rect = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
  // форма в локальных координатах рамки r
  const shape = createCanvas(r.w, r.h);
  ctx2d(shape).drawImage(content, -r.x, -r.y);
  const out = createCanvas(r.w, r.h);
  const o = ctx2d(out);

  // под слоем: тень и внешнее свечение
  if (fx.dropShadow.enabled) {
    const { dx, dy } = shadowOffset(fx.dropShadow);
    drawShadowOnly(o, silhouette(shape, fx.dropShadow.size, fx.dropShadow.spread), withAlpha(fx.dropShadow.color, fx.dropShadow.opacity), fx.dropShadow.size, dx, dy);
  }
  if (fx.outerGlow.enabled) {
    drawShadowOnly(o, silhouette(shape, fx.outerGlow.size, fx.outerGlow.spread), glowColor(fx.outerGlow), fx.outerGlow.size, 0, 0);
  }

  // заливка слоя
  o.globalAlpha = layer.fillOpacity;
  o.drawImage(shape, 0, 0);
  o.globalAlpha = 1;

  // внутренние эффекты рисуются в отдельный буфер и обрезаются по форме
  const inner = createCanvas(r.w, r.h);
  const ic = ctx2d(inner);
  let innerUsed = false;
  if (fx.colorOverlay.enabled) {
    ic.globalCompositeOperation = blendToComposite(fx.colorOverlay.blend);
    ic.fillStyle = withAlpha(fx.colorOverlay.color, fx.colorOverlay.opacity);
    ic.fillRect(0, 0, r.w, r.h);
    ic.globalCompositeOperation = 'source-over';
    innerUsed = true;
  }
  if (fx.gradientOverlay.enabled) {
    const g = fx.gradientOverlay;
    const cx = b.x - r.x + b.w / 2, cy = b.y - r.y + b.h / 2;
    const a = (g.angle * Math.PI) / 180;
    const half = (Math.abs(Math.cos(a) * b.w) + Math.abs(Math.sin(a) * b.h)) / 2 * (g.scale / 100);
    const [c0, c1] = g.reverse ? [g.to, g.from] : [g.from, g.to];
    const grad = g.kind === 'linear'
      ? ic.createLinearGradient(cx - Math.cos(a) * half, cy + Math.sin(a) * half, cx + Math.cos(a) * half, cy - Math.sin(a) * half)
      : ic.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, (Math.hypot(b.w, b.h) / 2) * (g.scale / 100)));
    grad.addColorStop(0, rgbaToCss(c0));
    grad.addColorStop(1, rgbaToCss(c1));
    ic.globalAlpha = g.opacity / 100;
    ic.globalCompositeOperation = blendToComposite(g.blend);
    ic.fillStyle = grad;
    ic.fillRect(0, 0, r.w, r.h);
    ic.globalAlpha = 1;
    ic.globalCompositeOperation = 'source-over';
    innerUsed = true;
  }
  if (fx.patternOverlay.enabled) {
    const po = fx.patternOverlay;
    const t = po.patternId ? tiled(po.patternId, r.w, r.h, po.scale / 100, -r.x, -r.y) : null;
    if (t) {
      ic.globalAlpha = po.opacity / 100;
      ic.globalCompositeOperation = blendToComposite(po.blend);
      ic.drawImage(t, 0, 0);
      ic.globalAlpha = 1;
      ic.globalCompositeOperation = 'source-over';
      innerUsed = true;
    }
  }
  if (fx.innerGlow.enabled) {
    const pad = Math.ceil(fx.innerGlow.size * 2) + 2;
    const inv = inverse(shape, pad);
    ic.save();
    ic.translate(-pad, -pad);
    drawShadowOnly(ic, inv, glowColor(fx.innerGlow), fx.innerGlow.size, 0, 0);
    ic.restore();
    innerUsed = true;
  }
  if (fx.innerShadow.enabled) {
    const s = fx.innerShadow;
    const { dx, dy } = shadowOffset(s);
    const pad = Math.ceil(s.distance + s.size * 2) + 2;
    const inv = inverse(shape, pad);
    ic.save();
    ic.translate(-pad, -pad);
    drawShadowOnly(ic, inv, withAlpha(s.color, s.opacity), s.size, dx, dy);
    ic.restore();
    innerUsed = true;
  }
  if (innerUsed) {
    ic.globalCompositeOperation = 'destination-in';
    ic.drawImage(shape, 0, 0);
    o.drawImage(inner, 0, 0);
  }

  if (fx.stroke.enabled && fx.stroke.size > 0) {
    const ring = strokeRing(shape, fx.stroke.size, fx.stroke.position);
    const rc = ctx2d(ring);
    rc.globalCompositeOperation = 'source-in';
    rc.fillStyle = withAlpha(fx.stroke.color, fx.stroke.opacity);
    rc.fillRect(0, 0, r.w, r.h);
    o.drawImage(ring, 0, 0);
  }

  const full = createCanvas(W, H);
  ctx2d(full).drawImage(out, r.x, r.y);
  return full;
}

/** Версии пикселей холстов: растут при каждой правке (Doc.edit, отмена/повтор). */
const canvasVersions = new WeakMap<HTMLCanvasElement, number>();
export function touchCanvas(c: HTMLCanvasElement | null | undefined) {
  if (c) canvasVersions.set(c, (canvasVersions.get(c) ?? 0) + 1);
}
const ver = (c: HTMLCanvasElement | null) => (c ? canvasVersions.get(c) ?? 0 : -1);

/** Отпечаток версий пикселей всех слоёв и масок: не изменился — пиксели слоёв те же. */
export const pixelStamp = (layers: Layer[]) => layers.map((l) => `${ver(l.canvas)}.${ver(l.mask ?? null)}`).join(',');

/**
 * Кэш отрендеренных слоёв (эффекты, маска): ключ — объект слоя (свойства неизменяемы)
 * + версии пикселей слоя и маски. Правка одного слоя не пересчитывает эффекты остальных.
 */
const cache = new WeakMap<Layer, { pix: number; mask: number; patterns: number; canvas: HTMLCanvasElement }>();

export function renderLayer(layer: Layer, _rev?: number): HTMLCanvasElement {
  const masked = !!layer.mask && layer.maskEnabled;
  if (!masked && !hasEffects(layer.effects) && layer.fillOpacity >= 1) return layer.canvas;
  // узоры грузятся асинхронно — после загрузки кэш нужно пересчитать
  const patterns = usePatterns.getState().loaded;
  const pix = ver(layer.canvas), mask = ver(layer.mask);
  const hit = cache.get(layer);
  if (hit && hit.pix === pix && hit.mask === mask && hit.patterns === patterns) return hit.canvas;
  const c = renderLayerContent(layer, layer.canvas, layer.mask);
  cache.set(layer, { pix, mask, patterns, canvas: c });
  return c;
}

function baseShape(l: Layer): HTMLCanvasElement {
  if (!l.mask || !l.maskEnabled) return l.canvas;
  const c = createCanvas(l.canvas.width, l.canvas.height);
  const ctx = ctx2d(c);
  ctx.drawImage(l.canvas, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(l.mask, 0, 0);
  return c;
}

export interface CompositeSource {
  width: number;
  height: number;
  layers: Layer[];
  rev: number;
  groups?: LayerGroup[];
}

/**
 * Сводит слои с учётом обтравочных масок: обтравочные слои рисуются в буфер
 * своей базы, и группа целиком накладывается с непрозрачностью и режимом базы.
 * getContent позволяет подменить содержимое слоя (превью инструмента).
 */
export function compositeLayers(
  doc: CompositeSource,
  ctx: CanvasRenderingContext2D,
  opts: { includeHidden?: boolean; getContent?: (l: Layer) => HTMLCanvasElement | null } = {},
) {
  const content = (l: Layer) => opts.getContent?.(l) ?? renderLayer(l, doc.rev);
  const layers = doc.layers;
  // папки: скрытая папка прячет слои, её непрозрачность умножается на слоевую
  const groups = new Map((doc.groups ?? []).map((g) => [g.id, g]));
  const shown = (l: Layer) => (l.visible && (!l.group || groups.get(l.group)?.visible !== false)) || !!opts.includeHidden;
  const alpha = (l: Layer) => l.opacity * (l.group ? groups.get(l.group)?.opacity ?? 1 : 1);
  let i = 0;
  while (i < layers.length) {
    const base = layers[i];
    let j = i + 1;
    while (j < layers.length && layers[j].clip) j++;
    const clipped = layers.slice(i + 1, j);
    i = j;
    const baseVisible = shown(base);
    // обтравочные слои над скрытой базой тоже не видны
    if (!baseVisible) continue;
    const visibleClipped = clipped.filter(shown);
    const baseCanvas = content(base);
    if (!visibleClipped.length) {
      ctx.globalAlpha = alpha(base);
      ctx.globalCompositeOperation = blendToComposite(base.blend);
      ctx.drawImage(baseCanvas, 0, 0);
      continue;
    }
    const group = createCanvas(doc.width, doc.height);
    const g = ctx2d(group);
    g.drawImage(baseCanvas, 0, 0);
    // обтравка — по пикселям базы (с маской), без её эффектов, как в Photoshop
    const shape = baseShape(base);
    for (const c of visibleClipped) {
      const t = createCanvas(doc.width, doc.height);
      const tc = ctx2d(t);
      tc.drawImage(content(c), 0, 0);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(shape, 0, 0);
      g.globalAlpha = alpha(c);
      g.globalCompositeOperation = blendToComposite(c.blend);
      g.drawImage(t, 0, 0);
    }
    ctx.globalAlpha = alpha(base);
    ctx.globalCompositeOperation = blendToComposite(base.blend);
    ctx.drawImage(group, 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
