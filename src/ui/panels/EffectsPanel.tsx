import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as A from '../../actions';
import { createCanvas, ctx2d } from '../../core/canvas';
import { EFFECT_CATEGORIES, EFFECT_PRESETS, presetParams, thumbParams, type EffectCategory, type EffectPreset } from '../../core/effectPresets';
import { FILTERS } from '../../core/filters';
import { pixelStamp } from '../../core/composite';
import { activeDoc, useApp } from '../../store';
import { changed, requestRender } from '../../tools/base';

/**
 * «Браузер эффектов» (как в Pixelmator): миниатюры активного слоя с готовыми коррекциями.
 * Наведение — предпросмотр на холсте, клик — применить, двойной клик — открыть с настройками.
 */

const THUMB = 76;
const CAT_KEY = 'pixelyard.effectsCategory';

/** Уменьшенная копия слоя (с выделением — только выделенная область). */
function sourceThumb(src: HTMLCanvasElement, area: { x: number; y: number; w: number; h: number }) {
  const s = Math.min(1, (THUMB * 2) / Math.max(area.w, area.h));
  const w = Math.max(1, Math.round(area.w * s)), h = Math.max(1, Math.round(area.h * s));
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, area.x, area.y, area.w, area.h, 0, 0, w, h);
  return { canvas: c, scale: s };
}

function renderThumb(base: { canvas: HTMLCanvasElement; scale: number }, p: EffectPreset): HTMLCanvasElement {
  const f = FILTERS.find((x) => x.id === p.filterId)!;
  const c = createCanvas(base.canvas.width, base.canvas.height);
  const ctx = ctx2d(c);
  const img = ctx2d(base.canvas).getImageData(0, 0, c.width, c.height);
  const res = f.apply(img, thumbParams(p, base.scale)) ?? img;
  ctx.putImageData(res, 0, 0);
  return c;
}

export function EffectsPanel() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const layer = doc?.activeLayer ?? null;
  const [cat, setCat] = useState<EffectCategory | 'all'>(() => (localStorage.getItem(CAT_KEY) as EffectCategory | 'all') || 'all');
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const hovering = useRef<string | null>(null);
  const presets = EFFECT_PRESETS.filter((p) => cat === 'all' || p.category === cat);

  useEffect(() => localStorage.setItem(CAT_KEY, cat), [cat]);

  // миниатюры пересчитываются при смене слоя/пикселей (с задержкой, чтобы не мешать рисованию)
  // пересчёт — только при смене пикселей слоя, выделения или раздела (не при любой правке документа)
  const sel = doc?.selection?.bounds;
  const key = doc && layer ? `${doc.id}:${layer.id}:${pixelStamp([layer])}:${sel ? `${sel.x},${sel.y},${sel.w},${sel.h}` : ''}:${cat}:${doc.editingMask}` : '';
  useEffect(() => {
    if (!doc || !layer) return setThumbs(new Map());
    let alive = true;
    const t = setTimeout(() => {
      // во время мазка или предпросмотра — позже (ключ сменится после него)
      if (doc.preview && !previewOwned) return;
      const src = doc.editSource(layer);
      const b = doc.selection?.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
      const base = sourceThumb(src, b);
      const next = new Map<string, string>();
      // по кусочку за кадр — панель не замирает на больших списках
      const list = [...presets];
      const step = () => {
        if (!alive) return;
        const t0 = performance.now();
        while (list.length && performance.now() - t0 < 12) {
          const p = list.shift()!;
          try {
            next.set(p.id, renderThumb(base, p).toDataURL());
          } catch {
            /* эффект не применим к этому слою — без миниатюры */
          }
        }
        setThumbs(new Map(next));
        if (list.length) requestAnimationFrame(step);
      };
      step();
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // предпросмотр на холсте при наведении
  const preview = (p: EffectPreset | null) => {
    const d = activeDoc();
    const l = d?.activeLayer;
    if (!d || !l) return;
    hovering.current = p?.id ?? null;
    if (!p) {
      if (d.preview?.layerId === l.id && previewOwned) {
        d.preview = null;
        previewOwned = false;
        changed();
      }
      return;
    }
    // чужой предпросмотр (инструмент что-то показывает) не трогаем
    if (d.preview && !previewOwned) return;
    setTimeout(() => {
      if (hovering.current !== p.id) return;
      void A.filterResultAsync(d, d.editSource(l), p.filterId, presetParams(p)).then(({ canvas }) => {
        // курсор уже ушёл на другой эффект или с панели
        if (hovering.current !== p.id || (d.preview && !previewOwned)) return;
        d.preview = { layerId: l.id, draw: (ctx) => ctx.drawImage(canvas, 0, 0) };
        previewOwned = true;
        requestRender();
      });
    }, 120);
  };

  const apply = (p: EffectPreset) => {
    preview(null);
    A.applyFilter(p.filterId, presetParams(p));
  };

  if (!doc) return <div className="panel-body note">Нет документа</div>;
  if (!layer) return <div className="panel-body note">Выберите слой</div>;
  const enhance = EFFECT_PRESETS[0];
  return (
    <div className="panel-body effects">
      <div className="row-fields">
        <button className="btn small primary" title="Автоулучшение активного слоя (⇧⌘A)" onClick={() => apply(enhance)} onMouseEnter={() => preview(enhance)} onMouseLeave={() => preview(null)}>
          <Sparkles size={12} /> Автоулучшение
        </button>
        <select value={cat} onChange={(e) => setCat(e.target.value as EffectCategory | 'all')} style={{ flex: 1, minWidth: 0 }}>
          {EFFECT_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>
      <div className="effects-grid" onMouseLeave={() => preview(null)}>
        {presets.map((p) => (
          <button
            key={p.id}
            className="effect-tile"
            title={`${p.label} — клик: применить, двойной клик: с настройками${doc.selection ? ' (к выделению)' : ''}`}
            onMouseEnter={() => preview(p)}
            onClick={(e) => e.detail === 1 && apply(p)}
            onDoubleClick={() => {
              // первый клик уже применил эффект — откатываем и открываем с настройками
              const f = FILTERS.find((x) => x.id === p.filterId)!;
              if (!f.params.length) return;
              const d = activeDoc();
              if (d?.undoStack[d.undoStack.length - 1]?.label === f.label.replace('…', '')) d.undo();
              preview(null);
              A.runFilter(p.filterId);
            }}
          >
            {thumbs.get(p.id) ? <img src={thumbs.get(p.id)} alt="" /> : <span className="effect-ph" />}
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Предпросмотр на холсте поставлен этой панелью (а не инструментом). */
let previewOwned = false;
