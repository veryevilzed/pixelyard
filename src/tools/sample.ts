import { ctx2d } from '../core/canvas';
import type { Doc } from '../core/doc';
import { compositeForView } from '../core/render';
import type { RGBA } from '../core/types';

/** Цвет пикселя документа: сведённый или только активного слоя. */
export function sampleColor(doc: Doc, x: number, y: number, merged: boolean): RGBA | null {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
  const src = merged ? compositeForView(doc) : doc.activeLayer?.canvas;
  if (!src) return null;
  const d = ctx2d(src).getImageData(px, py, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
