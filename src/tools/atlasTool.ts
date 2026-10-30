import { atlasFormat } from '../core/atlas';
import { frameAt, frameRect, isAtlas, pageFrames, spriteIdOf } from '../core/atlasDoc';
import { normRect } from '../core/canvas';
import type { Doc } from '../core/doc';
import type { PackedFrame } from '../core/pack';
import { rectToScreen } from '../core/render';
import type { Point } from '../core/types';
import { editSpriteAction, removeSpritesAction } from '../atlasActions';
import { changed, infoLabel, requestRender, type Tool } from './base';

/**
 * Инструмент атласа: подменяет любой инструмент (кроме руки и лупы), когда активен атлас.
 * Клик — выделить спрайт, ⇧/⌘ — добавить/убрать, рамка — несколько, двойной клик — править.
 */

let marquee: { start: Point; end: Point; add: boolean; base: string[] } | null = null;
let hoverId: string | null = null;

/** Точка исходного кадра (до обрезки) → точка атласа с учётом поворота. */
function toAtlas(f: PackedFrame, sx: number, sy: number, dir: 'cw' | 'ccw'): Point {
  const u = sx - f.offX, v = sy - f.offY;
  if (!f.rotated) return { x: f.x + u, y: f.y + v };
  return dir === 'cw' ? { x: f.x + f.h - v, y: f.y + u } : { x: f.x + v, y: f.y + f.w - u };
}

function select(doc: Doc, ids: string[]) {
  doc.atlasSel = ids;
  changed();
}

export const atlasTool: Tool = {
  cursor(p, doc) {
    return p && frameAt(doc, p.x, p.y) ? 'pointer' : 'default';
  },
  down(p, doc) {
    if (!isAtlas(doc)) return;
    const f = frameAt(doc, p.x, p.y);
    const add = p.shift || p.meta || p.ctrl;
    if (f) {
      const id = spriteIdOf(f);
      if (add) select(doc, doc.atlasSel.includes(id) ? doc.atlasSel.filter((x) => x !== id) : [...doc.atlasSel, id]);
      else if (!doc.atlasSel.includes(id) || doc.atlasSel.length > 1) select(doc, [id]);
      return;
    }
    marquee = { start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, add, base: add ? doc.atlasSel : [] };
    if (!add) select(doc, []);
  },
  drag(p, doc) {
    if (!marquee) return;
    marquee.end = { x: p.x, y: p.y };
    const r = normRect(marquee.start.x, marquee.start.y, p.x, p.y);
    const hit = pageFrames(doc)
      .filter((f) => {
        const q = frameRect(f);
        return q.x < r.x + r.w && q.x + q.w > r.x && q.y < r.y + r.h && q.y + q.h > r.y;
      })
      .map(spriteIdOf);
    doc.atlasSel = [...new Set([...marquee.base, ...hit])];
    changed();
  },
  up() {
    marquee = null;
    requestRender();
  },
  dblclick(p, doc) {
    const f = frameAt(doc, p.x, p.y);
    if (f) void editSpriteAction(doc, spriteIdOf(f));
  },
  hover(p, doc) {
    const f = frameAt(doc, p.x, p.y);
    const id = f ? spriteIdOf(f) : null;
    if (id !== hoverId) {
      hoverId = id;
      requestRender();
    }
  },
  key(e, doc) {
    if (!isAtlas(doc)) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && doc.atlasSel.length) {
      removeSpritesAction(doc, doc.atlasSel);
      return true;
    }
    if (e.key === 'Escape' && doc.atlasSel.length) {
      select(doc, []);
      return true;
    }
    if (e.key === 'Enter' && doc.atlasSel.length === 1) {
      void editSpriteAction(doc, doc.atlasSel[0]);
      return true;
    }
    return false;
  },
  deactivate() {
    marquee = null;
    hoverId = null;
  },
  overlay(ctx, v, doc) {
    if (!isAtlas(doc)) return;
    const sel = new Set(doc.atlasSel);
    const dir = atlasFormat(doc.atlas).rotation === 'ccw' ? 'ccw' : 'cw';
    const byId = new Map(doc.atlas.sprites.map((s) => [s.id, s]));
    ctx.save();
    ctx.lineWidth = 1;
    let hovered: PackedFrame | null = null;
    for (const f of pageFrames(doc)) {
      const id = spriteIdOf(f);
      const r = rectToScreen(v, frameRect(f));
      const on = sel.has(id);
      if (id === hoverId) hovered = f;
      if (on) {
        ctx.fillStyle = 'rgba(255,140,0,0.16)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.strokeStyle = on ? '#ff8c00' : id === hoverId ? 'rgba(255,255,255,0.9)' : 'rgba(0,170,255,0.55)';
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      if (f.rotated && r.w > 14 && r.h > 14) {
        ctx.fillStyle = on ? '#ff8c00' : 'rgba(0,170,255,0.9)';
        ctx.font = '11px -apple-system, system-ui, sans-serif';
        ctx.fillText('↻', r.x + 3, r.y + 12);
      }
      const sp = byId.get(id);
      if (on && sp) {
        // 9-slice и опорная точка — в координатах исходного кадра
        const k = f.srcW / Math.max(1, sp.image.width);
        const line = (a: Point, b: Point) => {
          const A = rectToScreen(v, { ...toAtlas(f, a.x, a.y, dir), w: 0, h: 0 }), B = rectToScreen(v, { ...toAtlas(f, b.x, b.y, dir), w: 0, h: 0 });
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        if (sp.nine) {
          ctx.strokeStyle = 'rgba(0,255,170,0.9)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          const n = sp.nine;
          for (const x of [n.left * k, f.srcW - n.right * k]) line({ x, y: 0 }, { x, y: f.srcH });
          for (const y of [n.top * k, f.srcH - n.bottom * k]) line({ x: 0, y }, { x: f.srcW, y });
          ctx.setLineDash([]);
        }
        const pv = rectToScreen(v, { ...toAtlas(f, sp.pivotX * f.srcW, sp.pivotY * f.srcH, dir), w: 0, h: 0 });
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pv.x, pv.y, 4, 0, Math.PI * 2);
        ctx.moveTo(pv.x - 7, pv.y);
        ctx.lineTo(pv.x + 7, pv.y);
        ctx.moveTo(pv.x, pv.y - 7);
        ctx.lineTo(pv.x, pv.y + 7);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (hovered) {
      const r = rectToScreen(v, frameRect(hovered));
      infoLabel(ctx, `${hovered.name}  ${hovered.w}×${hovered.h}${hovered.rotated ? ' ↻' : ''}`, r.x, r.y + r.h + 4);
    }
    if (marquee) {
      const m = rectToScreen(v, normRect(marquee.start.x, marquee.start.y, marquee.end.x, marquee.end.y));
      ctx.strokeStyle = '#ff8c00';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h);
      ctx.fillStyle = 'rgba(255,140,0,0.08)';
      ctx.fillRect(m.x, m.y, m.w, m.h);
    }
    if (doc.atlasError) {
      infoLabel(ctx, doc.atlasError, 8, 8);
    }
    ctx.restore();
  },
};
