import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as A from '../actions';
import { colorRangeMask } from '../core/flood';
import { selectionFromMask } from '../core/selection';
import { BLEND_MODES, DEFAULT_EFFECTS, type BlendMode, type Layer, type LayerEffects, type RGBA, type SelectMode } from '../core/types';
import { activeDoc, closeDialog, useApp } from '../store';
import { changed, requestRender, setPickHook } from '../tools/base';
import { sampleColor } from '../tools/sample';
import { Check, ColorField, NumberField, Seg } from './controls';
import { Modal } from './Dialogs';
import { PatternPicker } from './PatternPicker';

// ---------- стиль слоя ----------

type FxKey = keyof LayerEffects;

const FX_LIST: { key: FxKey; label: string }[] = [
  { key: 'stroke', label: 'Обводка' },
  { key: 'innerShadow', label: 'Внутренняя тень' },
  { key: 'innerGlow', label: 'Внутреннее свечение' },
  { key: 'colorOverlay', label: 'Наложение цвета' },
  { key: 'gradientOverlay', label: 'Наложение градиента' },
  { key: 'patternOverlay', label: 'Наложение узора' },
  { key: 'outerGlow', label: 'Внешнее свечение' },
  { key: 'dropShadow', label: 'Тень' },
];

function RangeRow(props: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="range-row">
      <span className="lbl">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <NumberField value={props.value} min={props.min} max={props.max} step={props.step ?? 1} width={58} suffix={props.suffix} onChange={props.onChange} />
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="range-row">
      <span className="lbl">{label}</span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', gridColumn: '2 / 4' }}>{children}</span>
    </div>
  );
}

function BlendSelect({ value, onChange }: { value: BlendMode; onChange: (b: BlendMode) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as BlendMode)}>
      {BLEND_MODES.map((b) => (
        <option key={b.id} value={b.id}>{b.label}</option>
      ))}
    </select>
  );
}

/** Угол «света» — круглый регулятор как в Photoshop. */
function AngleDial({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const set = (e: React.PointerEvent | PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const a = Math.round((Math.atan2(-(e.clientY - r.top - r.height / 2), e.clientX - r.left - r.width / 2) * 180) / Math.PI);
    onChange(a);
  };
  const rad = (value * Math.PI) / 180;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--bg1)', position: 'relative', touchAction: 'none' }}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          set(e, el);
          const mv = (ev: PointerEvent) => set(ev, el);
          const up = () => {
            el.removeEventListener('pointermove', mv);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', mv);
          el.addEventListener('pointerup', up);
        }}
      >
        <span style={{ position: 'absolute', left: 12, top: 12, width: 11, height: 1.5, background: 'var(--text)', transformOrigin: '0 50%', transform: `rotate(${-rad}rad)` }} />
      </span>
      <NumberField value={value} min={-180} max={180} width={52} suffix="°" onChange={onChange} />
    </span>
  );
}

export function LayerStyleDialog() {
  const doc = activeDoc()!;
  const original = useRef<{ layers: Layer[]; layer: Layer } | null>(null);
  if (!original.current && doc.activeLayer) original.current = { layers: doc.layers, layer: doc.activeLayer };
  const base = original.current!.layer;
  const [fx, setFx] = useState<LayerEffects>(() => ({ ...structuredClone(DEFAULT_EFFECTS), ...structuredClone(base.effects) }));
  const [blend, setBlend] = useState<BlendMode>(base.blend);
  const [opacity, setOpacity] = useState(Math.round(base.opacity * 100));
  const [fill, setFill] = useState(Math.round(base.fillOpacity * 100));
  const [clip, setClip] = useState(base.clip);
  const [sel, setSel] = useState<FxKey | 'blending'>(() => FX_LIST.find((f) => base.effects[f.key].enabled)?.key ?? 'blending');

  const patch = (): Partial<Layer> => ({ effects: fx, blend, opacity: opacity / 100, fillOpacity: fill / 100, clip });

  // живой просмотр: подменяем объект слоя без записи в историю
  useEffect(() => {
    const o = original.current!;
    doc.layers = o.layers.map((l) => (l.id === o.layer.id ? { ...l, ...patch() } : l));
    doc.rev++;
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fx, blend, opacity, fill, clip]);

  const restore = () => {
    doc.layers = original.current!.layers;
    doc.rev++;
  };
  const cancel = () => {
    restore();
    changed();
    closeDialog();
  };
  const ok = () => {
    restore();
    doc.updateLayer(base.id, patch(), 'Стиль слоя');
    changed();
    closeDialog();
  };

  const upd = <K extends FxKey>(key: K, p: Partial<LayerEffects[K]>) => setFx({ ...fx, [key]: { ...fx[key], ...p } });
  const toggle = (key: FxKey, on: boolean) => {
    upd(key, { enabled: on } as Partial<LayerEffects[typeof key]>);
    if (on) setSel(key);
  };

  let body: ReactNode = null;
  if (sel === 'blending') {
    body = (
      <>
        <Line label="Режим наложения"><BlendSelect value={blend} onChange={setBlend} /></Line>
        <RangeRow label="Непрозрачность" value={opacity} min={0} max={100} suffix="%" onChange={setOpacity} />
        <RangeRow label="Заливка" value={fill} min={0} max={100} suffix="%" onChange={setFill} />
        <span className="note">«Заливка» гасит пиксели слоя, оставляя эффекты: например, только обводка или тень.</span>
        <Line label=""><Check label="Обтравочная маска (по слою ниже)" checked={clip} onChange={setClip} /></Line>
      </>
    );
  } else if (sel === 'dropShadow' || sel === 'innerShadow') {
    const s = fx[sel];
    body = (
      <>
        <Line label="Цвет"><ColorField value={s.color} onChange={(color) => upd(sel, { color })} showHex /></Line>
        <RangeRow label="Непрозрачность" value={s.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd(sel, { opacity })} />
        <Line label="Угол"><AngleDial value={s.angle} onChange={(angle) => upd(sel, { angle })} /></Line>
        <RangeRow label="Смещение" value={s.distance} min={0} max={200} suffix="px" onChange={(distance) => upd(sel, { distance })} />
        <RangeRow label="Размах" value={s.spread} min={0} max={100} suffix="%" onChange={(spread) => upd(sel, { spread })} />
        <RangeRow label="Размер (размытие)" value={s.size} min={0} max={100} suffix="px" onChange={(size) => upd(sel, { size })} />
      </>
    );
  } else if (sel === 'outerGlow' || sel === 'innerGlow') {
    const g = fx[sel];
    body = (
      <>
        <Line label="Цвет"><ColorField value={g.color} onChange={(color) => upd(sel, { color })} showHex /></Line>
        <RangeRow label="Непрозрачность" value={g.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd(sel, { opacity })} />
        <RangeRow label="Размах" value={g.spread} min={0} max={100} suffix="%" onChange={(spread) => upd(sel, { spread })} />
        <RangeRow label="Размер" value={g.size} min={0} max={100} suffix="px" onChange={(size) => upd(sel, { size })} />
      </>
    );
  } else if (sel === 'colorOverlay') {
    const c = fx.colorOverlay;
    body = (
      <>
        <Line label="Цвет"><ColorField value={c.color} onChange={(color) => upd('colorOverlay', { color })} showHex /></Line>
        <Line label="Режим"><BlendSelect value={c.blend} onChange={(b) => upd('colorOverlay', { blend: b })} /></Line>
        <RangeRow label="Непрозрачность" value={c.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd('colorOverlay', { opacity })} />
      </>
    );
  } else if (sel === 'gradientOverlay') {
    const g = fx.gradientOverlay;
    body = (
      <>
        <Line label="Цвета">
          <ColorField value={g.from} onChange={(from) => upd('gradientOverlay', { from })} />
          <span style={{ flex: 1, height: 18, borderRadius: 4, border: '1px solid var(--line)', background: `linear-gradient(to right, rgba(${g.from.join(',')}), rgba(${g.to.join(',')}))` }} />
          <ColorField value={g.to} onChange={(to) => upd('gradientOverlay', { to })} />
          <button className="btn" onClick={() => upd('gradientOverlay', { from: g.to, to: g.from })}>⇄</button>
        </Line>
        <Line label="Прозрачность концов">
          <Check label="Начало прозрачное" checked={g.from[3] === 0} onChange={(v) => upd('gradientOverlay', { from: [g.from[0], g.from[1], g.from[2], v ? 0 : 255] as RGBA })} />
          <Check label="Конец прозрачный" checked={g.to[3] === 0} onChange={(v) => upd('gradientOverlay', { to: [g.to[0], g.to[1], g.to[2], v ? 0 : 255] as RGBA })} />
        </Line>
        <Line label="Стиль"><Seg value={g.kind} onChange={(kind) => upd('gradientOverlay', { kind })} options={[{ id: 'linear', label: 'Линейный' }, { id: 'radial', label: 'Радиальный' }]} /></Line>
        <Line label="Режим"><BlendSelect value={g.blend} onChange={(b) => upd('gradientOverlay', { blend: b })} /></Line>
        <RangeRow label="Непрозрачность" value={g.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd('gradientOverlay', { opacity })} />
        {g.kind === 'linear' && <Line label="Угол"><AngleDial value={g.angle} onChange={(angle) => upd('gradientOverlay', { angle })} /></Line>}
        <RangeRow label="Масштаб" value={g.scale} min={10} max={150} suffix="%" onChange={(scale) => upd('gradientOverlay', { scale })} />
        <Line label=""><Check label="Инверсия" checked={g.reverse} onChange={(reverse) => upd('gradientOverlay', { reverse })} /></Line>
      </>
    );
  } else if (sel === 'patternOverlay') {
    const po = fx.patternOverlay;
    body = (
      <>
        <PatternPicker value={po.patternId} onChange={(patternId) => upd('patternOverlay', { patternId })} />
        <Line label="Режим"><BlendSelect value={po.blend} onChange={(b) => upd('patternOverlay', { blend: b })} /></Line>
        <RangeRow label="Непрозрачность" value={po.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd('patternOverlay', { opacity })} />
        <RangeRow label="Масштаб" value={po.scale} min={10} max={1000} suffix="%" onChange={(scale) => upd('patternOverlay', { scale })} />
        <span className="note">Свой узор: выделите область → «Правка → Определить узор».</span>
      </>
    );
  } else if (sel === 'stroke') {
    const s = fx.stroke;
    body = (
      <>
        <RangeRow label="Размер" value={s.size} min={1} max={100} suffix="px" onChange={(size) => upd('stroke', { size })} />
        <Line label="Положение"><Seg value={s.position} onChange={(position) => upd('stroke', { position })} options={[{ id: 'outside', label: 'Снаружи' }, { id: 'center', label: 'По центру' }, { id: 'inside', label: 'Внутри' }]} /></Line>
        <Line label="Цвет"><ColorField value={s.color} onChange={(color) => upd('stroke', { color })} showHex /></Line>
        <RangeRow label="Непрозрачность" value={s.opacity} min={0} max={100} suffix="%" onChange={(opacity) => upd('stroke', { opacity })} />
      </>
    );
  }

  return (
    <Modal
      seeThrough
      title={`Стиль слоя — ${base.name}`}
      onClose={cancel}
      width={680}
      footer={
        <>
          <span className="left">
            <button className="btn" onClick={() => setFx(structuredClone(base.effects))}>Сбросить изменения</button>
          </span>
          <button className="btn" onClick={cancel}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      <div className="fx-layout">
        <div className="fx-list">
          <div className={`head ${sel === 'blending' ? 'on' : ''}`} onClick={() => setSel('blending')}>Параметры наложения</div>
          {FX_LIST.map((f) => (
            <label key={f.key} className={sel === f.key ? 'on' : ''} onClick={() => setSel(f.key)}>
              <input type="checkbox" checked={fx[f.key].enabled} onChange={(e) => toggle(f.key, e.target.checked)} onClick={(e) => e.stopPropagation()} />
              {f.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>{sel === 'blending' ? 'Параметры наложения' : FX_LIST.find((f) => f.key === sel)?.label}</div>
          {sel !== 'blending' && !fx[sel].enabled && <span className="note">Эффект выключен — отметьте галочку слева.</span>}
          {body}
        </div>
      </div>
    </Modal>
  );
}

// ---------- цветовой диапазон ----------

export function ColorRangeDialog() {
  const doc = activeDoc()!;
  const fg = useApp((s) => s.fg);
  const [color, setColor] = useState<RGBA>(fg);
  const [tolerance, setTolerance] = useState(32);
  const [softness, setSoftness] = useState(16);
  const [merged, setMerged] = useState(true);
  const [mode, setMode] = useState<SelectMode>('replace');
  const orig = useRef(doc.selection);

  // клик по холсту при открытом диалоге берёт цвет пипеткой (⇧ — добавить, ⌥ — вычесть)
  useEffect(() => {
    setPickHook((x, y, p) => {
      const c = sampleColor(doc, x, y, merged);
      if (!c) return;
      setColor(c);
      if (p.shift) setMode('add');
      else if (p.alt) setMode('subtract');
    });
    return () => setPickHook(null);
  }, [doc, merged]);

  // превью выделения без записи в историю
  useEffect(() => {
    const t = setTimeout(() => {
      const src = merged ? doc.composite() : doc.activeLayer?.canvas;
      if (!src) return;
      const mask = colorRangeMask(src, color, tolerance, softness);
      const base = mode === 'replace' ? null : orig.current;
      if (!base) doc.selection = selectionFromMask(mask);
      else {
        const m = document.createElement('canvas');
        m.width = doc.width;
        m.height = doc.height;
        const ctx = m.getContext('2d')!;
        ctx.drawImage(base.mask, 0, 0);
        ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
        ctx.drawImage(mask, 0, 0);
        doc.selection = selectionFromMask(m);
      }
      changed();
    }, 60);
    return () => clearTimeout(t);
  }, [doc, color, tolerance, softness, merged, mode]);

  const cancel = () => {
    doc.selection = orig.current;
    changed();
    closeDialog();
  };
  const ok = () => {
    doc.selection = orig.current;
    A.selectByColor(color, tolerance, softness, merged, mode);
    closeDialog();
  };
  const sel = doc.selection?.bounds;
  return (
    <Modal
      seeThrough
      title="Цветовой диапазон"
      onClose={cancel}
      width={480}
      footer={
        <>
          <span className="left note">{sel ? `Выделено: ${sel.w} × ${sel.h}` : 'Ничего не выделено'}</span>
          <button className="btn" onClick={cancel}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      <span className="note">Кликните по холсту, чтобы взять цвет. Выделяются все пиксели этого цвета по всему изображению.</span>
      <Line label="Цвет">
        <ColorField value={color} onChange={setColor} showHex />
        <button className="btn" onClick={() => setColor(useApp.getState().fg)}>Основной</button>
        <button className="btn" onClick={() => setColor(useApp.getState().bg)}>Фоновый</button>
        <button className="btn" onClick={() => setColor([0, 0, 0, 0])}>Прозрачный</button>
      </Line>
      <RangeRow label="Допуск" value={tolerance} min={0} max={255} onChange={setTolerance} />
      <RangeRow label="Мягкость края" value={softness} min={0} max={128} onChange={setSoftness} />
      <Line label="Источник"><Seg value={merged ? 'm' : 'l'} onChange={(v) => setMerged(v === 'm')} options={[{ id: 'm', label: 'Все видимые слои' }, { id: 'l', label: 'Активный слой' }]} /></Line>
      <Line label="Режим">
        <Seg value={mode} onChange={setMode} options={[{ id: 'replace', label: 'Новое' }, { id: 'add', label: 'Добавить' }, { id: 'subtract', label: 'Вычесть' }, { id: 'intersect', label: 'Пересечь' }]} />
      </Line>
    </Modal>
  );
}

// ---------- резы с шагом ----------

export function CutStepDialog() {
  const doc = activeDoc()!;
  const prefs = useApp((s) => s.prefs);
  const [mode, setMode] = useState<'step' | 'count'>('count');
  const [sx, setSx] = useState(prefs.gridW);
  const [sy, setSy] = useState(prefs.gridH);
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  const ok = () => {
    if (mode === 'step') A.cutEvery(sx, sy);
    else A.cutEvery(cols > 1 ? doc.width / cols : 0, rows > 1 ? doc.height / rows : 0);
    closeDialog();
  };
  return (
    <Modal title="Нож: резы с шагом" onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>Разрезать</button></>}>
      <Line label="Как"><Seg value={mode} onChange={setMode} options={[{ id: 'count', label: 'На N частей' }, { id: 'step', label: 'Каждые N px' }]} /></Line>
      {mode === 'count' ? (
        <Line label="Колонки × строки">
          <NumberField value={cols} min={1} max={256} onChange={setCols} />
          <NumberField value={rows} min={1} max={256} onChange={setRows} />
        </Line>
      ) : (
        <Line label="Шаг X × Y">
          <NumberField value={sx} min={0} onChange={setSx} suffix="px" />
          <NumberField value={sy} min={0} onChange={setSy} suffix="px" />
        </Line>
      )}
      <span className="note">Линии потом можно двигать и удалять инструментом «Нож» (⇧K). Существующие резы будут заменены.</span>
    </Modal>
  );
}

// ---------- выполнить заливку ----------

export function FillDialog() {
  const doc = activeDoc()!;
  const layer = doc.activeLayer!;
  const fillSource = useApp((s) => s.opts.fillSource);
  const fillPattern = useApp((s) => s.opts.fillPattern);
  const [p, setP] = useState<A.FillParams>({
    source: fillSource === 'pattern' ? 'pattern' : 'fg',
    color: useApp.getState().fg,
    patternId: fillPattern,
    patternScale: 100,
    opacity: 100,
    blend: 'normal',
    preserveAlpha: false,
  });
  const set = (x: Partial<A.FillParams>) => setP({ ...p, ...x });

  useEffect(() => {
    const fill = A.fillCanvas(doc, p);
    doc.preview = fill
      ? {
          layerId: layer.id,
          draw: (ctx, l) => {
            ctx.drawImage(l.canvas, 0, 0);
            A.drawFill(ctx, l.canvas, fill, p, doc.selection);
          },
        }
      : null;
    requestRender();
  }, [p, doc, layer]);
  useEffect(() => () => {
    doc.preview = null;
    requestRender();
  }, [doc]);

  const ok = () => {
    doc.preview = null;
    A.applyFill(p);
    closeDialog();
  };
  return (
    <Modal
      seeThrough
      title="Выполнить заливку"
      onClose={closeDialog}
      width={460}
      footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>OK</button></>}
    >
      <span className="note">{doc.selection ? 'Заливается выделенная область' : 'Заливается весь слой'} «{layer.name}»{doc.editingMask ? ' (маска)' : ''}</span>
      <Line label="Содержимое">
        <select value={p.source} onChange={(e) => set({ source: e.target.value as A.FillParams['source'] })}>
          <option value="fg">Основной цвет</option>
          <option value="bg">Фоновый цвет</option>
          <option value="color">Другой цвет…</option>
          <option value="pattern">Узор</option>
          <option value="transparent">Прозрачность (стереть)</option>
        </select>
        {p.source === 'color' && <ColorField value={p.color} onChange={(color) => set({ color })} showHex />}
      </Line>
      {p.source === 'pattern' && (
        <>
          <PatternPicker value={p.patternId} onChange={(patternId) => set({ patternId })} />
          <RangeRow label="Масштаб узора" value={p.patternScale} min={10} max={1000} suffix="%" onChange={(patternScale) => set({ patternScale })} />
        </>
      )}
      <Line label="Режим"><BlendSelect value={p.blend} onChange={(blend) => set({ blend })} /></Line>
      <RangeRow label="Непрозрачность" value={p.opacity} min={1} max={100} suffix="%" onChange={(opacity) => set({ opacity })} />
      <Line label=""><Check label="Сохранять прозрачность (только по существующим пикселям)" checked={p.preserveAlpha} onChange={(preserveAlpha) => set({ preserveAlpha })} /></Line>
    </Modal>
  );
}

// ---------- новая направляющая ----------

export function NewGuideDialog() {
  const doc = activeDoc()!;
  const [axis, setAxis] = useState<'x' | 'y'>('x');
  const [v, setV] = useState(Math.round(doc.width / 2));
  const ok = () => {
    A.addGuide(axis, Math.round(v));
    closeDialog();
  };
  return (
    <Modal title="Новая направляющая" onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>OK</button></>}>
      <Line label="Ориентация">
        <Seg value={axis} onChange={(a) => { setAxis(a); setV(Math.round((a === 'x' ? doc.width : doc.height) / 2)); }} options={[{ id: 'x', label: 'Вертикальная' }, { id: 'y', label: 'Горизонтальная' }]} />
      </Line>
      <Line label="Положение"><NumberField value={v} onChange={setV} suffix="px" /></Line>
      <span className="note">Направляющие также вытягиваются мышью из линеек (⌘R). Двигать — инструментом «Перемещение» или с ⌘, удалить — утащить на линейку.</span>
    </Modal>
  );
}
