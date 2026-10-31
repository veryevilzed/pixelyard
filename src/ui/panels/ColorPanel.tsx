import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { rgbaToCss } from '../../core/canvas';
import type { RGBA } from '../../core/types';
import { openDialog, setBg, setFg, toast, useApp } from '../../store';
import { HexInput, NumberField, Seg } from '../controls';
import { decodeGpl, encodeGpl, HARMONIES, harmonyColors, harmonyOffsets, hex, hsbToRgb, rgbToHsb, type Harmony, type HSB, type Palette } from '../../core/color';
import { uid } from '../../core/canvas';
import { openFiles, saveFileAs } from '../../core/platform';

const useColorTarget = create<{ target: 'fg' | 'bg'; tab: 'color' | 'harmony' | 'palettes' }>(() => ({ target: 'fg', tab: 'color' }));

/** Клик по образцу цвета в панели инструментов — диалог «Палитра цветов». */
export function openColorPicker(target: 'fg' | 'bg') {
  useColorTarget.setState({ target });
  openDialog({ kind: 'color', target });
}

// ---------- свои палитры ----------

const PAL_KEY = 'pixelyard.palettes';
export const usePalettes = create<{ palettes: Palette[]; activeId: string | null }>(() => {
  try {
    const v = JSON.parse(localStorage.getItem(PAL_KEY) ?? 'null') as { palettes: Palette[]; activeId: string | null } | null;
    if (v?.palettes) return v;
  } catch {
    /* повреждённые данные — с нуля */
  }
  return { palettes: [], activeId: null };
});
usePalettes.subscribe((s) => localStorage.setItem(PAL_KEY, JSON.stringify(s)));

function activePalette(): Palette {
  const st = usePalettes.getState();
  const p = st.palettes.find((x) => x.id === st.activeId) ?? st.palettes[0];
  if (p) return p;
  const created: Palette = { id: uid('pal'), name: 'Моя палитра', colors: [] };
  usePalettes.setState({ palettes: [created], activeId: created.id });
  return created;
}

function updatePalette(id: string, fn: (p: Palette) => Palette) {
  usePalettes.setState((s) => ({ palettes: s.palettes.map((p) => (p.id === id ? fn(p) : p)) }));
}

const same = (a: RGBA, b: RGBA) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Добавить цвета в текущую палитру (повторы пропускаются). */
export function addToPalette(...colors: RGBA[]) {
  const p = activePalette();
  updatePalette(p.id, (x) => ({ ...x, colors: [...x.colors, ...colors.map((c): RGBA => [c[0], c[1], c[2], 255]).filter((c, i, arr) => !x.colors.some((y) => same(y, c)) && arr.findIndex((z) => same(z, c)) === i)] }));
  usePalettes.setState({ activeId: p.id });
}

const rgbToHsv = (c: RGBA) => rgbToHsb(c);
const hsvToRgb = (h: number, s: number, v: number, a: number) => hsbToRgb(h, s, v, a);

// Базовая палитра: оттенки серого + насыщенные и пастельные тона
const PALETTE: string[] = [
  '#000000', '#222222', '#444444', '#666666', '#888888', '#aaaaaa', '#cccccc', '#eeeeee', '#ffffff', '#7f4f24', '#b08968', '#e6ccb2',
  '#d62828', '#f77f00', '#fcbf49', '#eae151', '#80b918', '#2a9d8f', '#219ebc', '#3a86ff', '#5e60ce', '#8338ec', '#c9184a', '#ff70a6',
  '#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff', '#1d3557', '#264653', '#3d405b', '#6d597a',
];

export function ColorPanel() {
  const tab = useColorTarget((s) => s.tab);
  return (
    <>
      <div className="panel-body" style={{ paddingBottom: 0 }}>
        <Seg value={tab} onChange={(t) => useColorTarget.setState({ tab: t })} options={[{ id: 'color', label: 'Цвет' }, { id: 'harmony', label: 'Гармония' }, { id: 'palettes', label: 'Палитры' }]} />
      </div>
      {tab === 'color' && <ColorTab />}
      {tab === 'harmony' && <HarmonyTab />}
      {tab === 'palettes' && <PalettesTab />}
    </>
  );
}

function ColorTab() {
  const target = useColorTarget((s) => s.target);
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  const recent = useApp((s) => s.recentColors);
  const color = target === 'fg' ? fg : bg;
  // во время перетаскивания цвет меняется без записи в «недавние»
  const set = (c: RGBA) => useApp.setState(target === 'fg' ? { fg: c } : { bg: c });
  const remember = () => {
    const s = useApp.getState();
    if (target === 'fg') setFg(s.fg);
    else setBg(s.bg);
  };

  // HSV храним отдельно: у серых цветов тон не выводится из RGB
  const [hsv, setHsv] = useState(() => rgbToHsv(color));
  const lastSet = useRef<RGBA | null>(null);
  useEffect(() => {
    if (lastSet.current && lastSet.current.every((v, i) => v === color[i])) return;
    const next = rgbToHsv(color);
    setHsv((prev) => [next[1] === 0 || next[2] === 0 ? prev[0] : next[0], next[2] === 0 ? prev[1] : next[1], next[2]]);
  }, [color]);

  const apply = (h: number, s: number, v: number, a = color[3]) => {
    setHsv([h, s, v]);
    const c = hsvToRgb(h, s, v, a);
    lastSet.current = c;
    set(c);
  };

  const drag = (el: HTMLElement, e: React.PointerEvent, fn: (fx: number, fy: number) => void) => {
    el.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect();
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      remember();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const [h, s, v] = hsv;
  const pick = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const c: RGBA = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    lastSet.current = null;
    (target === 'fg' ? setFg : setBg)(c);
  };

  return (
    <div className="panel-body">
      <Seg value={target} onChange={(t) => useColorTarget.setState({ target: t })} options={[{ id: 'fg', label: 'Основной' }, { id: 'bg', label: 'Фоновый' }]} />
      <div
        className="sv-box"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h},100%,50%))` }}
        onPointerDown={(e) => drag(e.currentTarget, e, (fx, fy) => apply(h, fx, 1 - fy))}
      >
        <div className="knob" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: rgbaToCss([color[0], color[1], color[2], 255]) }} />
      </div>
      <div className="hue-bar" onPointerDown={(e) => drag(e.currentTarget, e, (fx) => apply(fx * 359.9, s, v))}>
        <div className="knob" style={{ left: `${(h / 360) * 100}%` }} />
      </div>
      <div className="alpha-bar" onPointerDown={(e) => drag(e.currentTarget, e, (fx) => apply(h, s, v, Math.round(fx * 255)))}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: `linear-gradient(to right, transparent, ${rgbaToCss([color[0], color[1], color[2], 255])})` }} />
        <div className="knob" style={{ left: `${(color[3] / 255) * 100}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <HexInput value={color} onChange={(c) => { lastSet.current = null; set(c); }} />
        <NumberField label="R" value={color[0]} min={0} max={255} width={42} onChange={(x) => { lastSet.current = null; set([x, color[1], color[2], color[3]]); }} />
        <NumberField label="G" value={color[1]} min={0} max={255} width={42} onChange={(x) => { lastSet.current = null; set([color[0], x, color[2], color[3]]); }} />
        <NumberField label="B" value={color[2]} min={0} max={255} width={42} onChange={(x) => { lastSet.current = null; set([color[0], color[1], x, color[3]]); }} />
        <NumberField label="A" value={Math.round((color[3] / 255) * 100)} min={0} max={100} width={42} suffix="%" onChange={(x) => apply(h, s, v, Math.round((x / 100) * 255))} />
      </div>
      <div className="palette">
        {PALETTE.map((c) => (
          <div key={c} style={{ background: c }} title={c} onClick={() => pick(c)} />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="palette" title="Недавние цвета">
          {recent.map((c, i) => (
            <div key={i} style={{ background: rgbaToCss(c) }} onClick={() => { lastSet.current = null; set(c); }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- круг гармоний ----------

const WHEEL = 200;

/**
 * Цветовой круг: тон — угол, насыщенность — расстояние от центра, яркость — ползунком.
 * Метки схемы соединены фигурой (треугольник для триады и т.п.); тяните любую метку — вся схема
 * поворачивается вместе с ней.
 */
const BASE_KEY = 'pixelyard.harmonyBase';
const DEFAULT_BASE: HSB = [205, 0.7, 0.9];

/** Начальная точка схемы: основной цвет, если он цветной; иначе — прошлая схема или яркий цвет по умолчанию. */
function initialBase(fg: RGBA): HSB {
  const hsb = rgbToHsb(fg);
  if (hsb[1] >= 0.15 && hsb[2] >= 0.25) return hsb;
  try {
    const v = JSON.parse(localStorage.getItem(BASE_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x)) && v[2] > 0.05) return v as HSB;
  } catch {
    /* нет сохранённой — по умолчанию */
  }
  return DEFAULT_BASE;
}

function HarmonyTab() {
  const fg = useApp((s) => s.fg);
  const [scheme, setScheme] = useState<Harmony>(() => (localStorage.getItem('pixelyard.harmony') as Harmony) || 'triad');
  const [spread, setSpread] = useState(30);
  const [base, setBase] = useState<HSB>(() => initialBase(fg));
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => localStorage.setItem('pixelyard.harmony', scheme), [scheme]);
  useEffect(() => localStorage.setItem(BASE_KEY, JSON.stringify(base)), [base]);
  const colors = harmonyColors(base, scheme, spread);
  const offsets = scheme === 'monochrome' ? [0] : harmonyOffsets(scheme, spread);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    // целое число пикселей: при дробном dpr индексы в ImageData иначе «уплывают»
    const S = Math.round(WHEEL * dpr);
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const R = S / 2;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = x - R + 0.5, dy = y - R + 0.5, d = Math.hypot(dx, dy) / R;
        if (d > 1) continue;
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360 + 90) % 360;
        const col = hsbToRgb(h, d, base[2]);
        const i = (y * S + x) * 4;
        img.data[i] = col[0];
        img.data[i + 1] = col[1];
        img.data[i + 2] = col[2];
        // мягкий край круга
        img.data[i + 3] = d > 0.985 ? Math.round(255 * (1 - d) / 0.015) : 255;
      }
    ctx.putImageData(img, 0, 0);
    // метки схемы и фигура между ними
    const pt = (h: number, s: number) => {
      const a = ((h - 90) * Math.PI) / 180;
      return [R + Math.cos(a) * s * R, R + Math.sin(a) * s * R];
    };
    const pts = scheme === 'monochrome' ? [pt(base[0], base[1])] : offsets.map((o) => pt((base[0] + o + 360) % 360, base[1]));
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (pts.length > 2) ctx.closePath();
    ctx.stroke();
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, (i === 0 ? 8 : 6) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = rgbaToCss(colors[i] ?? colors[0]);
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    });
  }, [base, scheme, spread]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const toHs = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      const dx = ev.clientX - r.left - r.width / 2, dy = ev.clientY - r.top - r.height / 2;
      return { h: ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360, s: Math.min(1, Math.hypot(dx, dy) / (r.width / 2)) };
    };
    // за какую метку взялись — схема поворачивается так, чтобы она шла за мышью
    const p0 = toHs(e);
    let grab = 0, best = Infinity;
    offsets.forEach((o) => {
      const d = Math.abs((((base[0] + o - p0.h) % 360) + 540) % 360 - 180);
      if (d < best) {
        best = d;
        grab = o;
      }
    });
    const go = (ev: { clientX: number; clientY: number }) => {
      const p = toHs(ev);
      setBase((b) => [(p.h - grab + 360) % 360, p.s, b[2]]);
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className="panel-body harmony">
      <select value={scheme} onChange={(e) => setScheme(e.target.value as Harmony)}>
        {HARMONIES.map((h) => (
          <option key={h.id} value={h.id}>{h.label}</option>
        ))}
      </select>
      <div className="harmony-wheel">
        <canvas ref={ref} style={{ width: WHEEL, height: WHEEL }} onPointerDown={onDown} />
      </div>
      <div className="row-fields">
        <span className="label static">Яркость</span>
        <input type="range" min={0} max={100} value={Math.round(base[2] * 100)} onChange={(e) => setBase([base[0], base[1], Number(e.target.value) / 100])} style={{ flex: 1 }} />
      </div>
      {(scheme === 'analogous' || scheme === 'split' || scheme === 'tetrad') && (
        <div className="row-fields">
          <span className="label static">Раствор</span>
          <input type="range" min={10} max={90} value={spread} onChange={(e) => setSpread(Number(e.target.value))} style={{ flex: 1 }} />
          <span className="dim">{spread}°</span>
        </div>
      )}
      <div className="harmony-swatches">
        {colors.map((c, i) => (
          <div key={i} style={{ background: rgbaToCss(c) }} title={`${hex(c)} — клик: основной цвет, ⌥клик: фоновый`} onClick={(e) => (e.altKey ? setBg(c) : setFg(c))} />
        ))}
      </div>
      <div className="row-fields" style={{ flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => setBase(initialBase(fg))} title="Поставить основной цвет в центр схемы (серый не меняет схему)">От основного</button>
        <button className="btn small primary" onClick={() => (addToPalette(...colors), toast(`В палитру «${activePalette().name}»: ${colors.length} цв.`))}>В палитру</button>
      </div>
    </div>
  );
}

// ---------- палитры ----------

function PalettesTab() {
  const { palettes, activeId } = usePalettes();
  const fg = useApp((s) => s.fg);
  const [renaming, setRenaming] = useState(false);
  const p = palettes.find((x) => x.id === activeId) ?? palettes[0];
  const create = () => {
    const np: Palette = { id: uid('pal'), name: `Палитра ${palettes.length + 1}`, colors: [] };
    usePalettes.setState({ palettes: [...palettes, np], activeId: np.id });
  };
  const exportGpl = async () => {
    if (!p) return;
    await saveFileAs(`${p.name}.gpl`, new TextEncoder().encode(encodeGpl(p)), [{ name: 'Палитра GIMP', extensions: ['gpl'] }]);
  };
  const importGpl = async () => {
    const files = await openFiles([{ name: 'Палитра GIMP', extensions: ['gpl'] }]);
    for (const f of files) {
      try {
        const { name, colors } = decodeGpl(new TextDecoder().decode(f.data), f.name.replace(/\.gpl$/i, ''));
        const np: Palette = { id: uid('pal'), name, colors };
        usePalettes.setState((s) => ({ palettes: [...s.palettes, np], activeId: np.id }));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    }
  };
  return (
    <div className="panel-body">
      <div className="row-fields">
        {renaming && p ? (
          <input
            type="text"
            autoFocus
            defaultValue={p.name}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              setRenaming(false);
              const v = e.target.value.trim();
              if (v) updatePalette(p.id, (x) => ({ ...x, name: v }));
            }}
          />
        ) : (
          <select value={p?.id ?? ''} onChange={(e) => usePalettes.setState({ activeId: e.target.value })} style={{ flex: 1, minWidth: 0 }} onDoubleClick={() => setRenaming(true)}>
            {!palettes.length && <option value="">Палитр пока нет</option>}
            {palettes.map((x) => (
              <option key={x.id} value={x.id}>{x.name} ({x.colors.length})</option>
            ))}
          </select>
        )}
        <button className="btn small" onClick={create} title="Новая палитра">＋</button>
      </div>
      {p && (
        <>
          <div className="palette user-palette">
            {p.colors.map((c, i) => (
              <div
                key={i}
                style={{ background: rgbaToCss(c) }}
                title={`${hex(c)} — клик: основной, ⌥клик: фоновый, ⇧клик: убрать`}
                onClick={(e) => {
                  if (e.shiftKey) updatePalette(p.id, (x) => ({ ...x, colors: x.colors.filter((_, j) => j !== i) }));
                  else if (e.altKey) setBg(c);
                  else setFg(c);
                }}
              />
            ))}
            <div className="add" title="Добавить основной цвет" onClick={() => addToPalette(fg)}>＋</div>
          </div>
          <div className="row-fields" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => setRenaming(true)}>Переименовать</button>
            <button className="btn small" onClick={() => void exportGpl()} disabled={!p.colors.length}>Экспорт .gpl</button>
            <button className="btn small" onClick={() => void importGpl()}>Импорт .gpl</button>
            <button
              className="btn small"
              onClick={() => usePalettes.setState((s) => ({ palettes: s.palettes.filter((x) => x.id !== p.id), activeId: s.palettes.find((x) => x.id !== p.id)?.id ?? null }))}
            >
              Удалить
            </button>
          </div>
          <div className="note">Цвета добавляются кнопкой ＋, из «Гармонии» и из диалога цвета. ⇧клик — убрать цвет.</div>
        </>
      )}
      {!p && (
        <div className="row-fields">
          <button className="btn small" onClick={create}>Создать палитру</button>
          <button className="btn small" onClick={() => void importGpl()}>Импорт .gpl</button>
        </div>
      )}
    </div>
  );
}

