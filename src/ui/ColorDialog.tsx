import { useEffect, useMemo, useRef, useState } from 'react';
import { rgbaToCss } from '../core/canvas';
import { cmykToRgb, hex, hsbToRgb, hslToRgb, labToRgb, parseHex, rgbToCmyk, rgbToHsb, rgbToHsl, rgbToLab, type HSB } from '../core/color';
import type { RGBA } from '../core/types';
import { activeDoc, app, closeDialog, setBg, setFg, toast } from '../store';
import { setPickHook } from '../tools/base';
import { sampleColor } from '../tools/sample';
import { addToPalette } from './panels/ColorPanel';
import { NumberField } from './controls';
import { Modal } from './Dialogs';

/**
 * «Палитра цветов» как в Photoshop: квадрат + полоса, на полосе — выбранный канал
 * (H, S, B, R, G, B, L, a, b), остальные два — в квадрате. Поля всех моделей, HEX, альфа,
 * старый/новый цвет, пипетка с холста.
 */

type Channel = 'h' | 's' | 'v' | 'r' | 'g' | 'b' | 'L' | 'A' | 'B';

const CH_LABEL: Record<Channel, string> = { h: 'H', s: 'S', v: 'B', r: 'R', g: 'G', b: 'B', L: 'L', A: 'a', B: 'b' };

/** Рабочий цвет: HSB храним отдельно, чтобы у серых не терялся тон. */
interface Work {
  rgb: RGBA;
  hsb: HSB;
}

const fromRgb = (rgb: RGBA, prev?: HSB): Work => {
  const h = rgbToHsb(rgb);
  // у серого тон и насыщенность не определены — оставляем прежние
  if (prev && (h[1] === 0 || h[2] === 0)) return { rgb, hsb: [prev[0], h[2] === 0 ? prev[1] : h[1], h[2]] };
  return { rgb, hsb: h };
};
const fromHsb = (hsb: HSB, a: number): Work => ({ rgb: hsbToRgb(hsb[0], hsb[1], hsb[2], a), hsb });

/** Цвет в точке поля: slider — значение канала полосы (0..1), fx/fy — квадрат (0..1, y вниз). */
function colorAt(ch: Channel, w: Work, sl: number, fx: number, fy: number): Work {
  const a = w.rgb[3];
  switch (ch) {
    case 'h': return fromHsb([sl * 360, fx, 1 - fy], a);
    case 's': return fromHsb([fx * 360, sl, 1 - fy], a);
    case 'v': return fromHsb([fx * 360, 1 - fy, sl], a);
    case 'r': return fromRgb([Math.round(sl * 255), Math.round((1 - fy) * 255), Math.round(fx * 255), a], w.hsb);
    case 'g': return fromRgb([Math.round((1 - fy) * 255), Math.round(sl * 255), Math.round(fx * 255), a], w.hsb);
    case 'b': return fromRgb([Math.round(fx * 255), Math.round((1 - fy) * 255), Math.round(sl * 255), a], w.hsb);
    case 'L': return fromRgb(labToRgb(sl * 100, fx * 255 - 128, (1 - fy) * 255 - 128, a), w.hsb);
    case 'A': return fromRgb(labToRgb((1 - fy) * 100, sl * 255 - 128, fx * 255 - 128, a), w.hsb);
    case 'B': return fromRgb(labToRgb((1 - fy) * 100, fx * 255 - 128, sl * 255 - 128, a), w.hsb);
  }
}

/** Положение текущего цвета: значение полосы и точка квадрата. */
function positionOf(ch: Channel, w: Work): { sl: number; fx: number; fy: number } {
  const [h, s, v] = w.hsb;
  const [r, g, b] = w.rgb;
  const [L, A, B] = rgbToLab(w.rgb);
  switch (ch) {
    case 'h': return { sl: h / 360, fx: s, fy: 1 - v };
    case 's': return { sl: s, fx: h / 360, fy: 1 - v };
    case 'v': return { sl: v, fx: h / 360, fy: 1 - s };
    case 'r': return { sl: r / 255, fx: b / 255, fy: 1 - g / 255 };
    case 'g': return { sl: g / 255, fx: b / 255, fy: 1 - r / 255 };
    case 'b': return { sl: b / 255, fx: r / 255, fy: 1 - g / 255 };
    case 'L': return { sl: L / 100, fx: (A + 128) / 255, fy: 1 - (B + 128) / 255 };
    case 'A': return { sl: (A + 128) / 255, fx: (B + 128) / 255, fy: 1 - L / 100 };
    case 'B': return { sl: (B + 128) / 255, fx: (A + 128) / 255, fy: 1 - L / 100 };
  }
}

const SQ = 256, SL_W = 22;

export function ColorDialog({ target }: { target: 'fg' | 'bg' }) {
  const initial = target === 'fg' ? app().fg : app().bg;
  const [w, setW] = useState<Work>(() => fromRgb(initial));
  const [ch, setCh] = useState<Channel>(() => (localStorage.getItem('pixelyard.colorChannel') as Channel) || 'h');
  const [picking, setPicking] = useState(false);
  const sqRef = useRef<HTMLCanvasElement>(null);
  const slRef = useRef<HTMLCanvasElement>(null);
  const pos = useMemo(() => positionOf(ch, w), [ch, w]);
  useEffect(() => localStorage.setItem('pixelyard.colorChannel', ch), [ch]);

  // квадрат перерисовывается, когда меняется значение полосы (или канал)
  const slKey = Math.round(pos.sl * 1000);
  useEffect(() => {
    const c = sqRef.current!;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(SQ, SQ);
    const d = img.data;
    for (let y = 0; y < SQ; y++)
      for (let x = 0; x < SQ; x++) {
        const col = colorAt(ch, w, pos.sl, x / (SQ - 1), y / (SQ - 1)).rgb;
        const i = (y * SQ + x) * 4;
        d[i] = col[0];
        d[i + 1] = col[1];
        d[i + 2] = col[2];
        d[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch, slKey, ch === 'h' || ch === 's' || ch === 'v' ? 0 : w.rgb.join()]);

  // полоса зависит от точки квадрата
  const sqKey = `${Math.round(pos.fx * 255)}:${Math.round(pos.fy * 255)}`;
  useEffect(() => {
    const c = slRef.current!;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(1, SQ);
    for (let y = 0; y < SQ; y++) {
      // для тона полоса — полный спектр, независимо от квадрата (как в Photoshop)
      const col = ch === 'h' ? hsbToRgb((1 - y / (SQ - 1)) * 360, 1, 1) : colorAt(ch, w, 1 - y / (SQ - 1), pos.fx, pos.fy).rgb;
      img.data.set([col[0], col[1], col[2], 255], y * 4);
    }
    ctx.putImageData(img, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch, sqKey]);

  const drag = (el: HTMLElement, e: React.PointerEvent, fn: (fx: number, fy: number) => void) => {
    el.setPointerCapture(e.pointerId);
    const go = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
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

  // пипетка: клик по холсту берёт цвет (диалог прозрачен для кликов по холсту)
  useEffect(() => {
    if (!picking) return;
    setPickHook((x, y) => {
      const doc = activeDoc();
      const c = doc && sampleColor(doc, x, y, true);
      if (c) setW((p) => fromRgb([c[0], c[1], c[2], p.rgb[3]], p.hsb));
      setPicking(false);
    });
    return () => setPickHook(null);
  }, [picking]);

  const ok = () => {
    (target === 'fg' ? setFg : setBg)(w.rgb);
    closeDialog();
  };
  const setRgb = (rgb: RGBA) => setW((p) => fromRgb(rgb, p.hsb));
  const a = w.rgb[3];
  const [hh, ss, vv] = w.hsb;
  const hsl = rgbToHsl(w.rgb);
  const lab = rgbToLab(w.rgb);
  const cmyk = rgbToCmyk(w.rgb);
  const opaque = (c: RGBA) => rgbaToCss([c[0], c[1], c[2], 255]);

  const radio = (c: Channel) => (
    <input type="radio" name="ch" checked={ch === c} onChange={() => setCh(c)} title={`Канал ${CH_LABEL[c]} на полосе`} />
  );
  const row = (c: Channel | null, label: string, value: number, max: number, onChange: (v: number) => void, suffix?: string, step = 1, min = 0) => (
    <div className="cd-row">
      {c ? radio(c) : <span className="cd-radio-gap" />}
      <NumberField label={label} value={value} min={min} max={max} step={step} width={46} onChange={onChange} suffix={suffix} />
    </div>
  );

  return (
    <Modal
      title={target === 'fg' ? 'Палитра цветов — основной цвет' : 'Палитра цветов — фоновый цвет'}
      onClose={closeDialog}
      seeThrough
      width={640}
      footer={
        <>
          <span className="left">
            <button className={`btn ${picking ? 'primary' : ''}`} onClick={() => setPicking(!picking)} title="Взять цвет с холста">
              {picking ? 'Кликните по холсту…' : 'Пипетка'}
            </button>
            <button
              className="btn"
              onClick={() => {
                addToPalette(w.rgb);
                toast(`${hex(w.rgb)} добавлен в палитру`);
              }}
            >
              В палитру
            </button>
          </span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      <div className="cd-layout">
        <div className="cd-square" onPointerDown={(e) => drag(e.currentTarget, e, (fx, fy) => setW((p) => colorAt(ch, p, positionOf(ch, p).sl, fx, fy)))}>
          <canvas ref={sqRef} width={SQ} height={SQ} />
          <div className="cd-ring" style={{ left: `${pos.fx * 100}%`, top: `${pos.fy * 100}%`, borderColor: hsl[2] > 0.6 ? '#000' : '#fff' }} />
        </div>
        <div
          className="cd-slider"
          onPointerDown={(e) =>
            drag(e.currentTarget, e, (_fx, fy) =>
              setW((p) => {
                const ps = positionOf(ch, p);
                return colorAt(ch, p, 1 - fy, ps.fx, ps.fy);
              }),
            )
          }
        >
          <canvas ref={slRef} width={1} height={SQ} style={{ width: SL_W, height: SQ }} />
          <div className="cd-arrow" style={{ top: `${(1 - pos.sl) * 100}%` }} />
        </div>
        <div className="cd-fields">
          <div className="cd-compare">
            <div style={{ background: opaque(w.rgb) }} title="Новый" />
            <div style={{ background: opaque(initial) }} title="Прежний — клик вернёт" onClick={() => setW(fromRgb(initial))} />
            <span>новый / прежний</span>
          </div>
          <div className="cd-cols">
            <div>
              {row('h', 'H', Math.round(hh), 360, (v) => setW(fromHsb([v % 360, ss, vv], a)), '°')}
              {row('s', 'S', Math.round(ss * 100), 100, (v) => setW(fromHsb([hh, v / 100, vv], a)), '%')}
              {row('v', 'B', Math.round(vv * 100), 100, (v) => setW(fromHsb([hh, ss, v / 100], a)), '%')}
              <div className="cd-gap" />
              {row('r', 'R', w.rgb[0], 255, (v) => setRgb([v, w.rgb[1], w.rgb[2], a]))}
              {row('g', 'G', w.rgb[1], 255, (v) => setRgb([w.rgb[0], v, w.rgb[2], a]))}
              {row('b', 'B', w.rgb[2], 255, (v) => setRgb([w.rgb[0], w.rgb[1], v, a]))}
            </div>
            <div>
              {row('L', 'L', Math.round(lab[0]), 100, (v) => setRgb(labToRgb(v, lab[1], lab[2], a)))}
              {row('A', 'a', Math.round(lab[1]), 127, (v) => setRgb(labToRgb(lab[0], v, lab[2], a)), undefined, 1, -128)}
              {row('B', 'b', Math.round(lab[2]), 127, (v) => setRgb(labToRgb(lab[0], lab[1], v, a)), undefined, 1, -128)}
              <div className="cd-gap" />
              {row(null, 'C', Math.round(cmyk[0] * 100), 100, (v) => setRgb(cmykToRgb(v / 100, cmyk[1], cmyk[2], cmyk[3], a)), '%')}
              {row(null, 'M', Math.round(cmyk[1] * 100), 100, (v) => setRgb(cmykToRgb(cmyk[0], v / 100, cmyk[2], cmyk[3], a)), '%')}
              {row(null, 'Y', Math.round(cmyk[2] * 100), 100, (v) => setRgb(cmykToRgb(cmyk[0], cmyk[1], v / 100, cmyk[3], a)), '%')}
              {row(null, 'K', Math.round(cmyk[3] * 100), 100, (v) => setRgb(cmykToRgb(cmyk[0], cmyk[1], cmyk[2], v / 100, a)), '%')}
            </div>
          </div>
          <div className="cd-row">
            <span className="cd-radio-gap" />
            <NumberField label="HSL: S" value={Math.round(hsl[1] * 100)} min={0} max={100} width={38} onChange={(v) => setRgb(hslToRgb(hsl[0], v / 100, hsl[2], a))} suffix="%" />
            <NumberField label="L" value={Math.round(hsl[2] * 100)} min={0} max={100} width={38} onChange={(v) => setRgb(hslToRgb(hsl[0], hsl[1], v / 100, a))} suffix="%" />
          </div>
          <div className="cd-row">
            <span className="cd-radio-gap" />
            <span className="label static">#</span>
            <HexField value={hex(w.rgb).slice(1)} onChange={(t) => {
              const c = parseHex(t, a);
              if (c) setRgb(c);
            }} />
            <NumberField label="Альфа" value={Math.round((a / 255) * 100)} min={0} max={100} width={40} onChange={(v) => setW((p) => ({ ...p, rgb: [p.rgb[0], p.rgb[1], p.rgb[2], Math.round((v / 100) * 255)] }))} suffix="%" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function HexField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      value={text}
      maxLength={7}
      style={{ width: 70, fontFamily: 'ui-monospace, Menlo, monospace' }}
      onChange={(e) => {
        setText(e.target.value);
        if (parseHex(e.target.value)) onChange(e.target.value);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
