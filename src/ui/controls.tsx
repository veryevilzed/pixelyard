import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hexToRgba, rgbaToCss, rgbaToHex } from '../core/canvas';
import type { RGBA } from '../core/types';

/**
 * Числовое поле. Перетаскивание подписи влево/вправо меняет значение,
 * как в Photoshop. Значение применяется по Enter/blur.
 */
export function NumberField(props: {
  label?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  width?: number;
  title?: string;
}) {
  const { value, onChange, min = -Infinity, max = Infinity, step = 1 } = props;
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(round(value, step)));
  }, [value, step]);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef({ value, step, onChange, clampV });
  live.current = { value, step, onChange, clampV };
  useEffect(() => {
    const el = inputRef.current!;
    // React вешает wheel пассивно — нужен свой слушатель, чтобы отменить прокрутку страницы
    const wheel = (e: WheelEvent) => {
      // колёсико меняет значение только у поля в фокусе, чтобы не мешать прокрутке панелей
      if (document.activeElement !== el) return;
      e.preventDefault();
      const { value: cur, step: st, onChange: change, clampV: clamp } = live.current;
      const v = clamp(round(cur + (e.deltaY < 0 ? st : -st) * (e.shiftKey ? 10 : 1), st));
      setText(String(v));
      change(v);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(v)) onChange(clampV(v));
    else setText(String(value));
  };
  const scrub = (e: React.PointerEvent) => {
    const startX = e.clientX, start = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : 1;
      onChange(clampV(round(start + Math.round((ev.clientX - startX) / 2) * step * k, step)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <span className="field" title={props.title}>
      {props.label !== undefined && (
        <span className="label" onPointerDown={scrub}>
          {props.label}
        </span>
      )}
      <input
        ref={inputRef}
        type="number"
        value={text}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        style={props.width ? { width: props.width } : undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => {
          setText(e.target.value);
          // значение применяется сразу (стрелки, ввод); окончательная проверка — на blur
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(clampV(v));
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = e.shiftKey ? 10 : 1;
            const v = clampV(round(value + (e.key === 'ArrowUp' ? step : -step) * k, step));
            setText(String(v));
            onChange(v);
            e.stopPropagation();
            return;
          }
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setText(String(value));
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {props.suffix && <span className="label static">{props.suffix}</span>}
    </span>
  );
}

function round(v: number, step: number) {
  const digits = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  return Number(v.toFixed(digits));
}

export function SliderField(props: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <span className="field">
      <span className="label static">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: 80 }}
      />
      <NumberField value={props.value} onChange={props.onChange} min={props.min} max={props.max} step={props.step} width={48} />
      {props.suffix && <span className="label static">{props.suffix}</span>}
    </span>
  );
}

export function Check(props: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Seg<T extends string>(props: { value: T; options: { id: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="seg">
      {props.options.map((o) => (
        <button key={o.id} className={o.id === props.value ? 'on' : ''} title={o.title} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** Цветной квадрат с системным выбором цвета и HEX-полем. */
export function ColorField(props: { value: RGBA; onChange: (c: RGBA) => void; showHex?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="field">
      <span className="color-chip" onClick={() => ref.current?.click()}>
        <div style={{ background: rgbaToCss(props.value) }} />
      </span>
      <input
        ref={ref}
        type="color"
        value={rgbaToHex(props.value)}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        onChange={(e) => {
          const c = hexToRgba(e.target.value, props.value[3]);
          if (c) props.onChange(c);
        }}
      />
      {props.showHex && <HexInput value={props.value} onChange={props.onChange} />}
    </span>
  );
}

export function HexInput(props: { value: RGBA; onChange: (c: RGBA) => void }) {
  const [text, setText] = useState(rgbaToHex(props.value));
  useEffect(() => {
    setText(rgbaToHex(props.value));
  }, [props.value]);
  return (
    <input
      type="text"
      value={text}
      style={{ width: 72, fontFamily: 'ui-monospace, Menlo, monospace' }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const c = hexToRgba(text, props.value[3]);
        if (c) props.onChange(c);
        else setText(rgbaToHex(props.value));
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function TextInput(props: { value: string; onChange: (v: string) => void; width?: number | string; placeholder?: string; autoFocus?: boolean }) {
  return (
    <input
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      style={{ width: props.width }}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** Прокручивает строку в видимую область своего списка, не трогая боковую колонку целиком. */
export function scrollIntoList(row: HTMLElement | null | undefined) {
  const list = row?.closest('.panel-body.list') as HTMLElement | null;
  if (!row || !list) return;
  const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
}
