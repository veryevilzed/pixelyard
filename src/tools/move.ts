import { createCanvas, ctx2d } from '../core/canvas';
import type { Doc } from '../core/doc';
import { maskedCopy, selectionFromMask } from '../core/selection';
import type { Point } from '../core/types';
import { app } from '../store';
import { changed, editableLayer, infoLabel, requestRender, type Tool } from './base';

// ---------- перемещение ----------

interface MoveState {
  doc: Doc;
  layerId: string;
  start: Point;
  dx: number;
  dy: number;
  /** Плавающий фрагмент (при перемещении выделенного). */
  float: HTMLCanvasElement | null;
  /** Слой без вырезанного фрагмента. */
  base: HTMLCanvasElement | null;
}

let mv: MoveState | null = null;

function beginMove(doc: Doc, layerId: string, start: Point, duplicate: boolean): MoveState {
  const src = doc.editSource(doc.getLayer(layerId)!);
  let float: HTMLCanvasElement | null = null, base: HTMLCanvasElement | null = null;
  if (doc.selection) {
    float = maskedCopy(src, doc.selection);
    base = createCanvas(doc.width, doc.height);
    const b = ctx2d(base);
    b.drawImage(src, 0, 0);
    if (!duplicate) {
      b.globalCompositeOperation = 'destination-out';
      b.drawImage(doc.selection.mask, 0, 0);
    }
  }
  const s: MoveState = { doc, layerId, start, dx: 0, dy: 0, float, base };
  doc.preview = {
    layerId,
    draw(ctx, l) {
      if (s.float && s.base) {
        ctx.drawImage(s.base, 0, 0);
        ctx.drawImage(s.float, s.dx, s.dy);
      } else ctx.drawImage(l.canvas, s.dx, s.dy);
    },
  };
  return s;
}

function commitMove(s: MoveState, label = 'Перемещение') {
  s.doc.preview = null;
  const { dx, dy } = s;
  if (!dx && !dy) return changed();
  const sel = s.doc.selection;
  const draw = (ctx: CanvasRenderingContext2D, layer: { canvas: HTMLCanvasElement }) => {
    if (s.float && s.base) {
      ctx.clearRect(0, 0, s.doc.width, s.doc.height);
      ctx.drawImage(s.base, 0, 0);
      ctx.drawImage(s.float, dx, dy);
    } else {
      const copy = createCanvas(s.doc.width, s.doc.height);
      ctx2d(copy).drawImage(layer.canvas, 0, 0);
      ctx.clearRect(0, 0, s.doc.width, s.doc.height);
      ctx.drawImage(copy, dx, dy);
    }
  };
  if (sel) {
    const m = createCanvas(s.doc.width, s.doc.height);
    ctx2d(m).drawImage(sel.mask, dx, dy);
    s.doc.compound(label, s.layerId, draw, () => {
      s.doc.selection = selectionFromMask(m);
    });
  } else s.doc.pixelEdit(s.layerId, null, label, draw);
  changed();
}

/** Верхний видимый слой с непрозрачным пикселем в точке. */
function pickLayer(doc: Doc, x: number, y: number) {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible) continue;
    if (ctx2d(l.canvas).getImageData(px, py, 1, 1).data[3] > 10) return l;
  }
  return null;
}

export const moveTool: Tool = {
  cursor: () => 'move',
  down(p, doc) {
    if (app().opts.moveAutoSelect || p.meta) {
      const l = pickLayer(doc, p.x, p.y);
      if (l && l.id !== doc.activeLayerId) {
        doc.activeLayerId = l.id;
        changed();
      }
    }
    const layer = editableLayer(doc);
    if (!layer) return;
    mv = beginMove(doc, layer.id, { x: p.x, y: p.y }, p.alt);
  },
  drag(p) {
    if (!mv) return;
    let dx = p.x - mv.start.x, dy = p.y - mv.start.y;
    if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    mv.dx = Math.round(dx);
    mv.dy = Math.round(dy);
    requestRender();
  },
  up() {
    if (!mv) return;
    const s = mv;
    mv = null;
    commitMove(s);
  },
  key(e, doc) {
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (!d) return false;
    const layer = editableLayer(doc);
    if (!layer) return true;
    const step = e.shiftKey ? 10 : 1;
    const s = beginMove(doc, layer.id, { x: 0, y: 0 }, false);
    s.dx = d[0] * step;
    s.dy = d[1] * step;
    commitMove(s, 'Сдвиг');
    return true;
  },
  deactivate() {
    if (mv) {
      const s = mv;
      mv = null;
      commitMove(s);
    }
  },
  hidesSelection: () => !!mv,
  overlay(ctx, v, doc) {
    if (mv && doc.selection) {
      ctx.save();
      ctx.translate(v.panX + mv.dx * v.zoom, v.panY + mv.dy * v.zoom);
      ctx.scale(v.zoom, v.zoom);
      ctx.lineWidth = 1 / v.zoom;
      ctx.setLineDash([4 / v.zoom, 4 / v.zoom]);
      ctx.strokeStyle = '#fff';
      ctx.stroke(doc.selection.outline);
      ctx.restore();
    }
    if (mv && (mv.dx || mv.dy)) infoLabel(ctx, `Δ ${mv.dx}, ${mv.dy}`, 12, 12);
  },
};
