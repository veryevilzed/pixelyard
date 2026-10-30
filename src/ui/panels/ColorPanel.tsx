import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { rgbaToCss } from '../../core/canvas';
import type { RGBA } from '../../core/types';
import { setBg, setFg, useApp } from '../../store';
import { HexInput, NumberField, Seg } from '../controls';

const useColorTarget = create<{ target: 'fg' | 'bg' }>(() => ({ target: 'fg' }));

export function openColorPicker(target: 'fg' | 'bg') {
  useColorTarget.setState({ target });
  useApp.setState((s) => ({ panels: { ...s.panels, color: true } }));
}

function rgbToHsv([r, g, b]: RGBA): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, max ? d / max : 0, max];
}

function hsvToRgb(h: number, s: number, v: number, a: number): RGBA {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1), a];
}

// Базовая палитра: оттенки серого + насыщенные и пастельные тона
const PALETTE: string[] = [
  '#000000', '#222222', '#444444', '#666666', '#888888', '#aaaaaa', '#cccccc', '#eeeeee', '#ffffff', '#7f4f24', '#b08968', '#e6ccb2',
  '#d62828', '#f77f00', '#fcbf49', '#eae151', '#80b918', '#2a9d8f', '#219ebc', '#3a86ff', '#5e60ce', '#8338ec', '#c9184a', '#ff70a6',
  '#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff', '#1d3557', '#264653', '#3d405b', '#6d597a',
];

export function ColorPanel() {
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
