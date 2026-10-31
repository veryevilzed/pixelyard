import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as A from '../actions';
import { DEFAULT_EXPORT, runExport, type ExportOptions } from '../core/export';
import { defaultParams, FILTERS, histogram, type Params } from '../core/filters';
import { autoSlices, gridSlices, type AutoOptions, type GridOptions } from '../core/slicing';
import type { RGBA, Slice } from '../core/types';
import { formatShortcut, MENUS, type MenuEntry } from '../menu';
import { isTauri } from '../core/platform';
import { APP_NAME, APP_VERSION, BUILD_COMMIT, BUILD_DATE } from '../version';
import { activeDoc, closeDialog, openDialog, setPrefs, toast, useApp, type DialogState } from '../store';
import { changed, requestRender } from '../tools/base';
import { Check, ColorField, NumberField, Seg, TextInput } from './controls';
import { ColorRangeDialog, CutStepDialog, FillDialog, LayerStyleDialog, NewGuideDialog } from './StyleDialogs';
import { CurvesDialog } from './CurvesDialog';
import { BMFontDialog, SpriteSheetDialog } from './PackDialogs';
import { IconDialog } from './IconDialog';
import { PdfExportDialog, PdfImportDialog } from './PdfDialogs';
import { PrintDialog } from './PrintDialog';
import { ColorDialog } from './ColorDialog';
import { ScanDialog } from './ScanDialog';

export function Modal(props: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; seeThrough?: boolean; width?: number }) {
  const [off, setOff] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  });
  // окно можно двигать за заголовок — чтобы видеть превью под ним
  const dragHead = (e: React.PointerEvent) => {
    const sx = e.clientX - off.x, sy = e.clientY - off.y;
    const move = (ev: PointerEvent) => setOff({ x: ev.clientX - sx, y: ev.clientY - sy });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`modal-back ${props.seeThrough ? 'transparent' : ''}`} onMouseDown={(e) => !props.seeThrough && e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ transform: `translate(${off.x}px, ${off.y}px)`, width: props.width }}>
        <div className="modal-head" onPointerDown={dragHead}>
          {props.title}
        </div>
        <div className="modal-body">{props.children}</div>
        <div className="modal-foot">{props.footer}</div>
      </div>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <span className="lbl">{label}</span>
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</span>
  </>
);

// ---------- новый документ ----------

const PRESETS = [
  { label: '32×32', w: 32, h: 32 },
  { label: '64×64', w: 64, h: 64 },
  { label: '128×128', w: 128, h: 128 },
  { label: '256×256', w: 256, h: 256 },
  { label: '512×512', w: 512, h: 512 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '2048×2048', w: 2048, h: 2048 },
  { label: 'HD 1280×720', w: 1280, h: 720 },
  { label: 'Full HD', w: 1920, h: 1080 },
  { label: '4K', w: 3840, h: 2160 },
  { label: 'Иконка iOS 1024', w: 1024, h: 1024 },
];

function NewDialog() {
  const [name, setName] = useState('Без названия');
  const [w, setW] = useState(512);
  const [h, setH] = useState(512);
  const [fill, setFill] = useState<'transparent' | 'white' | 'bg' | 'fg'>('transparent');
  // размер картинки в буфере обмена — для кнопки «Из буфера обмена»
  const [clip, setClip] = useState<{ w: number; h: number; url: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void A.clipboardImage().then((c) => {
      if (!alive || !c) return;
      // миниатюра: уменьшенная копия, чтобы не тащить огромный скриншот в data-URL
      const k = Math.min(1, 320 / c.width, 200 / c.height);
      const t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(c.width * k));
      t.height = Math.max(1, Math.round(c.height * k));
      const tc = t.getContext('2d')!;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(c, 0, 0, t.width, t.height);
      setClip({ w: c.width, h: c.height, url: t.toDataURL() });
    });
    return () => {
      alive = false;
    };
  }, []);
  const ok = () => {
    A.newDocument(`${name || 'Без названия'}.psd`, Math.round(w), Math.round(h), fill);
    closeDialog();
  };
  const fromClipboard = () => {
    closeDialog();
    void A.pasteAsNewDoc(name && name !== 'Без названия' ? name : 'Из буфера');
  };
  return (
    <Modal title="Новый документ" onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>Создать</button></>}>
      <div className="form-grid">
        <Row label="Имя"><TextInput value={name} onChange={setName} width={220} autoFocus /></Row>
        <Row label="Ширина"><NumberField value={w} onChange={setW} min={1} max={16384} suffix="px" /></Row>
        <Row label="Высота"><NumberField value={h} onChange={setH} min={1} max={16384} suffix="px" /></Row>
        <Row label="Фон">
          <Seg value={fill} onChange={setFill} options={[{ id: 'transparent', label: 'Прозрачный' }, { id: 'white', label: 'Белый' }, { id: 'bg', label: 'Фоновый цвет' }, { id: 'fg', label: 'Основной цвет' }]} />
        </Row>
      </div>
      {clip && (
        <div className="clip-preview" onClick={fromClipboard} title="Создать документ из буфера обмена">
          <img src={clip.url} alt="" />
          <div>
            <b>В буфере обмена</b>
            <span>{clip.w} × {clip.h} px</span>
            <button className="btn primary" onClick={(e) => (e.stopPropagation(), fromClipboard())}>Создать из буфера</button>
            <button className="btn" onClick={(e) => (e.stopPropagation(), setW(clip.w), setH(clip.h))}>Только размер</button>
          </div>
        </div>
      )}
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="btn" onClick={() => { setW(p.w); setH(p.h); }}>{p.label}</button>
        ))}
      </div>
    </Modal>
  );
}

// ---------- размер изображения ----------

function ImageSizeDialog() {
  const doc = activeDoc()!;
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [keep, setKeep] = useState(true);
  const [smooth, setSmooth] = useState(true);
  const ratio = doc.width / doc.height;
  const ok = () => {
    A.resizeImage(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), smooth);
    closeDialog();
  };
  return (
    <Modal title="Размер изображения" onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>OK</button></>}>
      <div className="form-grid">
        <Row label="Ширина">
          <NumberField value={w} min={1} max={16384} suffix="px" onChange={(v) => { setW(v); if (keep) setH(Math.round(v / ratio)); }} />
          <NumberField value={Math.round((w / doc.width) * 1000) / 10} step={0.1} suffix="%" onChange={(v) => { const nw = Math.round((doc.width * v) / 100); setW(nw); if (keep) setH(Math.round(nw / ratio)); }} />
        </Row>
        <Row label="Высота">
          <NumberField value={h} min={1} max={16384} suffix="px" onChange={(v) => { setH(v); if (keep) setW(Math.round(v * ratio)); }} />
          <NumberField value={Math.round((h / doc.height) * 1000) / 10} step={0.1} suffix="%" onChange={(v) => { const nh = Math.round((doc.height * v) / 100); setH(nh); if (keep) setW(Math.round(nh * ratio)); }} />
        </Row>
        <Row label=""><Check label="Сохранять пропорции" checked={keep} onChange={setKeep} /></Row>
        <Row label="Интерполяция">
          <Seg value={smooth ? 's' : 'n'} onChange={(v) => setSmooth(v === 's')} options={[{ id: 's', label: 'Сглаживание' }, { id: 'n', label: 'Ближайший сосед (пиксель-арт)' }]} />
        </Row>
        <Row label="">
          <span className="presets">
            {[0.25, 0.5, 2, 3, 4].map((k) => (
              <button key={k} className="btn" onClick={() => { setW(Math.round(doc.width * k)); setH(Math.round(doc.height * k)); }}>×{k}</button>
            ))}
          </span>
        </Row>
      </div>
    </Modal>
  );
}

// ---------- размер холста ----------

function CanvasSizeDialog() {
  const doc = activeDoc()!;
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [anchor, setAnchor] = useState(4);
  const ok = () => {
    A.resizeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), anchor);
    closeDialog();
  };
  return (
    <Modal title="Размер холста" onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>OK</button></>}>
      <div className="form-grid">
        <Row label="Текущий">{doc.width} × {doc.height} px</Row>
        <Row label="Ширина"><NumberField value={w} min={1} max={16384} suffix="px" onChange={setW} /></Row>
        <Row label="Высота"><NumberField value={h} min={1} max={16384} suffix="px" onChange={setH} /></Row>
        <Row label="Расположение">
          <div className="anchor-grid">
            {Array.from({ length: 9 }, (_, i) => (
              <button key={i} className={anchor === i ? 'on' : ''} onClick={() => setAnchor(i)} />
            ))}
          </div>
        </Row>
        <Row label="">
          <span className="presets">
            <button className="btn" onClick={() => { const p = 2 ** Math.ceil(Math.log2(Math.max(w, h))); setW(p); setH(p); }}>До степени двойки</button>
            <button className="btn" onClick={() => { setW(w + 2); setH(h + 2); }}>+1px со всех сторон</button>
          </span>
        </Row>
      </div>
    </Modal>
  );
}

// ---------- фильтры ----------

function FilterDialog({ filterId }: { filterId: string }) {
  const f = FILTERS.find((x) => x.id === filterId)!;
  const doc = activeDoc()!;
  const [params, setParams] = useState<Params>(() => defaultParams(f));
  const [preview, setPreview] = useState(true);
  const resultRef = useRef<HTMLCanvasElement | null>(null);
  const layer = doc.activeLayer!;

  useEffect(() => {
    if (!preview) {
      doc.preview = null;
      requestRender();
      return;
    }
    // считаем с задержкой: тяжёлые фильтры не должны тормозить слайдеры
    const t = setTimeout(() => {
      resultRef.current = A.filterResult(doc, doc.editSource(layer), filterId, params);
      doc.preview = { layerId: layer.id, draw: (ctx) => resultRef.current && ctx.drawImage(resultRef.current, 0, 0) };
      requestRender();
    }, 50);
    return () => clearTimeout(t);
  }, [params, preview, doc, layer, filterId]);

  useEffect(() => () => {
    doc.preview = null;
    requestRender();
  }, [doc]);

  const ok = () => {
    doc.preview = null;
    A.applyFilter(filterId, params);
    closeDialog();
  };
  return (
    <Modal
      seeThrough
      title={f.label.replace('…', '')}
      onClose={closeDialog}
      width={460}
      footer={
        <>
          <span className="left"><Check label="Просмотр" checked={preview} onChange={setPreview} /></span>
          <button className="btn" onClick={() => setParams(defaultParams(f))}>Сброс</button>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      {doc.selection && <span className="note">Применяется только к выделенной области</span>}
      {(filterId === 'levels' || filterId === 'shadows-highlights' || filterId === 'brightness-contrast') && <Histogram source={doc.editSource(layer)} />}
      {f.params.map((p) => (
        <div key={p.key} className="range-row">
          <span className="lbl">{p.label}</span>
          {p.type === 'range' && (
            <>
              <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={params[p.key] as number} onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })} />
              <NumberField value={params[p.key] as number} min={p.min} max={p.max} step={p.step ?? 1} width={58} onChange={(v) => setParams({ ...params, [p.key]: v })} />
            </>
          )}
          {p.type === 'check' && <Check label="" checked={params[p.key] as boolean} onChange={(v) => setParams({ ...params, [p.key]: v })} />}
          {p.type === 'select' && (
            <span style={{ gridColumn: '2 / 4' }}>
              <Seg value={params[p.key] as string} onChange={(v) => setParams({ ...params, [p.key]: v })} options={p.options} />
            </span>
          )}
          {p.type === 'color' && (
            <span style={{ display: 'flex', gap: 6 }}>
              <ColorField value={params[p.key] as RGBA} onChange={(c) => setParams({ ...params, [p.key]: c })} showHex />
              <button className="btn" onClick={() => setParams({ ...params, [p.key]: useApp.getState().fg })}>Основной</button>
            </span>
          )}
        </div>
      ))}
    </Modal>
  );
}

/** Гистограмма яркости и каналов слоя (для уровней и кривых). */
export function Histogram({ source, height = 90, channel = 'all' }: { source: HTMLCanvasElement; height?: number; channel?: 'all' | 'r' | 'g' | 'b' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hist = useMemo(() => histogram(source.getContext('2d')!.getImageData(0, 0, source.width, source.height)), [source]);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 256, height);
    const draw = (h: Uint32Array, color: string) => {
      // логарифмическая шкала — иначе один пик съедает весь график
      const max = Math.log1p(Math.max(...h));
      ctx.fillStyle = color;
      for (let i = 0; i < 256; i++) {
        const v = (Math.log1p(h[i]) / (max || 1)) * height;
        ctx.fillRect(i, height - v, 1, v);
      }
    };
    ctx.globalCompositeOperation = 'lighter';
    if (channel === 'all') {
      draw(hist.r, 'rgba(255,60,60,0.55)');
      draw(hist.g, 'rgba(60,255,60,0.55)');
      draw(hist.b, 'rgba(70,110,255,0.6)');
    } else draw(hist[channel], channel === 'r' ? 'rgba(255,60,60,0.8)' : channel === 'g' ? 'rgba(60,255,60,0.8)' : 'rgba(70,110,255,0.85)');
  }, [hist, height, channel]);
  return <canvas ref={ref} width={256} height={height} className="histogram" />;
}

// ---------- нарезка ----------

/** Подменяет слайсы документа превью-результатом, пока открыт диалог. */
function useSlicePreview(compute: () => Slice[], replace: boolean, deps: unknown[]) {
  const doc = activeDoc()!;
  const orig = useRef(doc.slices);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      const res = compute();
      doc.slices = replace ? res : [...orig.current, ...res];
      setCount(res.length);
      changed();
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, replace]);
  useEffect(() => () => {
    if (doc.slices !== orig.current) {
      doc.slices = orig.current;
      changed();
    }
  }, [doc]);
  const apply = (label: string) => {
    const result = doc.slices;
    doc.slices = orig.current;
    doc.setSlices(result, label);
    orig.current = doc.slices;
    toast(`Слайсов: ${count}`);
    changed();
    closeDialog();
  };
  return { count, apply };
}

function GridSliceDialog() {
  const doc = activeDoc()!;
  const prefs = useApp((s) => s.prefs);
  const [o, setO] = useState<GridOptions>({
    mode: 'size', cols: 4, rows: 4, cellW: prefs.gridW, cellH: prefs.gridH, offsetX: 0, offsetY: 0, gapX: 0, gapY: 0, skipEmpty: true, prefix: 'tile_',
  });
  const [replace, setReplace] = useState(true);
  const set = (p: Partial<GridOptions>) => setO({ ...o, ...p });
  const src = useMemo(() => doc.composite(), [doc]);
  const { count, apply } = useSlicePreview(() => gridSlices(doc.width, doc.height, o, src), replace, [o]);
  return (
    <Modal seeThrough title="Нарезать сеткой" onClose={closeDialog} footer={<><span className="left note">Будет слайсов: {count}</span><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={() => apply('Нарезка сеткой')}>Нарезать</button></>}>
      <div className="form-grid">
        <Row label="Режим"><Seg value={o.mode} onChange={(mode) => set({ mode })} options={[{ id: 'size', label: 'По размеру ячейки' }, { id: 'count', label: 'По количеству' }]} /></Row>
        {o.mode === 'count' ? (
          <Row label="Колонки × строки"><NumberField value={o.cols} min={1} max={512} onChange={(cols) => set({ cols })} /><NumberField value={o.rows} min={1} max={512} onChange={(rows) => set({ rows })} /></Row>
        ) : (
          <Row label="Ячейка"><NumberField value={o.cellW} min={1} onChange={(cellW) => set({ cellW })} suffix="×" /><NumberField value={o.cellH} min={1} onChange={(cellH) => set({ cellH })} suffix="px" /></Row>
        )}
        <Row label="Отступ от края"><NumberField label="X" value={o.offsetX} min={0} onChange={(offsetX) => set({ offsetX })} /><NumberField label="Y" value={o.offsetY} min={0} onChange={(offsetY) => set({ offsetY })} /></Row>
        <Row label="Промежуток"><NumberField label="X" value={o.gapX} min={0} onChange={(gapX) => set({ gapX })} /><NumberField label="Y" value={o.gapY} min={0} onChange={(gapY) => set({ gapY })} /></Row>
        <Row label="Префикс имени"><TextInput value={o.prefix} onChange={(prefix) => set({ prefix })} width={140} /></Row>
        <Row label=""><Check label="Пропускать пустые ячейки" checked={o.skipEmpty} onChange={(skipEmpty) => set({ skipEmpty })} /></Row>
        <Row label=""><Check label="Заменить существующие слайсы" checked={replace} onChange={setReplace} /></Row>
        <Row label="">
          <button className="btn" onClick={() => { setPrefs({ grid: true, gridW: o.mode === 'size' ? o.cellW : Math.floor(doc.width / o.cols), gridH: o.mode === 'size' ? o.cellH : Math.floor(doc.height / o.rows) }); }}>Показать как сетку</button>
        </Row>
      </div>
    </Modal>
  );
}

function AutoSliceDialog() {
  const doc = activeDoc()!;
  const [o, setO] = useState<AutoOptions>({ alphaThreshold: 0, mergeDistance: 0, minSize: 2, padding: 0, prefix: 'sprite_' });
  const [from, setFrom] = useState<'merged' | 'layer'>('merged');
  const [replace, setReplace] = useState(true);
  const set = (p: Partial<AutoOptions>) => setO({ ...o, ...p });
  const src = useMemo(() => (from === 'layer' && doc.activeLayer ? doc.activeLayer.canvas : doc.composite()), [doc, from]);
  const { count, apply } = useSlicePreview(() => autoSlices(src, o), replace, [o, src]);
  return (
    <Modal seeThrough title="Авто-нарезка по прозрачности" onClose={closeDialog} footer={<><span className="left note">Найдено объектов: {count}</span><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={() => apply('Авто-нарезка')}>Нарезать</button></>}>
      <span className="note">Находит отдельные объекты на прозрачном фоне. Если фон сплошной — сначала удалите его (волшебная палочка → Delete или «Цвет в прозрачность»).</span>
      <div className="form-grid">
        <Row label="Источник"><Seg value={from} onChange={setFrom} options={[{ id: 'merged', label: 'Все видимые слои' }, { id: 'layer', label: 'Активный слой' }]} /></Row>
        <Row label="Порог альфы"><NumberField value={o.alphaThreshold} min={0} max={254} onChange={(alphaThreshold) => set({ alphaThreshold })} /></Row>
        <Row label="Объединять ближе"><NumberField value={o.mergeDistance} min={0} max={256} suffix="px" onChange={(mergeDistance) => set({ mergeDistance })} /></Row>
        <Row label="Мин. размер"><NumberField value={o.minSize} min={1} max={4096} suffix="px" onChange={(minSize) => set({ minSize })} /></Row>
        <Row label="Поля вокруг"><NumberField value={o.padding} min={0} max={256} suffix="px" onChange={(padding) => set({ padding })} /></Row>
        <Row label="Префикс имени"><TextInput value={o.prefix} onChange={(prefix) => set({ prefix })} width={140} /></Row>
        <Row label=""><Check label="Заменить существующие слайсы" checked={replace} onChange={setReplace} /></Row>
      </div>
    </Modal>
  );
}

// ---------- экспорт ----------

const SCALE_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

function ExportDialog({ d }: { d: Extract<DialogState, { kind: 'export' }> }) {
  const doc = activeDoc()!;
  const initialSource = d.source ?? (doc.slices.length ? 'slices' : doc.layers.length > 1 ? 'layers' : 'merged');
  const stored = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('pixelyard.export') ?? '{}') as Partial<ExportOptions>;
    } catch {
      return {};
    }
  }, []);
  const [o, setO] = useState<ExportOptions>(() => ({
    ...DEFAULT_EXPORT,
    ...stored,
    // раньше «атлас» был вариантом вывода — теперь это отдельный диалог «Спрайтшит»
    output: stored.output === 'zip' ? 'zip' : 'folder',
    source: initialSource,
    ids: d.ids ?? (initialSource === 'slices' ? doc.slices.map((s) => s.id) : doc.layers.filter((l) => l.visible).map((l) => l.id)),
  }));
  const [progress, setProgress] = useState<string | null>(null);
  const set = (p: Partial<ExportOptions>) => setO({ ...o, ...p });
  const items = o.source === 'layers' ? [...doc.layers].reverse().map((l) => ({ id: l.id, name: l.name, extra: l.visible ? '' : 'скрыт' })) : o.source === 'slices' ? doc.slices.map((s) => ({ id: s.id, name: s.name, extra: `${s.w}×${s.h}` })) : [];

  const changeSource = (source: ExportOptions['source']) =>
    set({ source, ids: source === 'slices' ? doc.slices.map((s) => s.id) : source === 'layers' ? doc.layers.filter((l) => l.visible).map((l) => l.id) : [] });

  const run = async () => {
    const { ids: _ids, source: _src, ...persist } = o;
    localStorage.setItem('pixelyard.export', JSON.stringify(persist));
    setProgress('Подготовка…');
    try {
      const res = await runExport(doc, o, (n, t) => setProgress(`Экспорт ${n} / ${t}…`));
      if (res) {
        toast(`Экспортировано файлов: ${res.files} → ${res.target}`);
        closeDialog();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setProgress(null);
    }
  };

  const canRun = (o.source === 'merged' || o.ids.length > 0) && !progress;
  return (
    <Modal
      title="Экспорт"
      onClose={closeDialog}
      width={560}
      footer={
        <>
          <span className="left note">{progress ?? (isTauri ? '' : 'В браузере несколько файлов скачиваются ZIP-архивом')}</span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" disabled={!canRun} onClick={() => void run()}>
            {o.output === 'folder' ? 'Выбрать папку и экспортировать' : 'Экспортировать'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Row label="Что">
          <Seg value={o.source} onChange={changeSource} options={[{ id: 'layers', label: `Слои (${doc.layers.length})` }, { id: 'slices', label: `Слайсы (${doc.slices.length})` }, { id: 'merged', label: 'Всё изображение' }]} />
        </Row>
        {items.length > 0 && (
          <>
            <span className="lbl">
              <span className="presets" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => set({ ids: items.map((i) => i.id) })}>Все</button>
                <button className="btn" onClick={() => set({ ids: [] })}>Ничего</button>
              </span>
            </span>
            <div className="check-list">
              {items.map((it) => (
                <label key={it.id}>
                  <input type="checkbox" checked={o.ids.includes(it.id)} onChange={(e) => set({ ids: e.target.checked ? [...o.ids, it.id] : o.ids.filter((x) => x !== it.id) })} />
                  <span style={{ flex: 1 }}>{it.name}</span>
                  <span className="note">{it.extra}</span>
                </label>
              ))}
            </div>
          </>
        )}
        {o.source === 'slices' && (
          <Row label="Резать из"><Seg value={o.sliceFrom} onChange={(sliceFrom) => set({ sliceFrom })} options={[{ id: 'merged', label: 'Видимых слоёв' }, { id: 'layer', label: 'Активного слоя' }]} /></Row>
        )}
        <Row label="Формат">
          <Seg value={o.format} onChange={(format) => set({ format })} options={[{ id: 'png', label: 'PNG' }, { id: 'webp', label: 'WebP' }, { id: 'jpg', label: 'JPG' }, { id: 'tiff', label: 'TIFF' }]} />
          {(o.format === 'jpg' || o.format === 'webp') && <NumberField label="Качество" value={o.quality} min={1} max={100} onChange={(quality) => set({ quality })} />}
          {o.format === 'webp' && o.quality >= 100 && <span className="note">без потерь</span>}
        </Row>
        <Row label="Обработка">
          <Check label="Обрезать по содержимому" checked={o.trim} onChange={(trim) => set({ trim })} />
          <NumberField label="Поля" value={o.padding} min={0} max={512} suffix="px" onChange={(padding) => set({ padding })} />
        </Row>
        <Row label="Масштабы">
          {SCALE_OPTIONS.map((s) => (
            <Check key={s} label={`@${s}x`} checked={o.scales.includes(s)} onChange={(v) => set({ scales: v ? [...o.scales, s].sort((a, b) => a - b) : o.scales.filter((x) => x !== s) })} />
          ))}
        </Row>
        <Row label=""><Check label="Сглаживание при масштабировании (выкл. для пиксель-арта)" checked={o.smoothScale} onChange={(smoothScale) => set({ smoothScale })} /></Row>
        <Row label="Куда">
          <Seg value={o.output} onChange={(output) => set({ output })} options={[{ id: 'folder', label: 'В папку' }, { id: 'zip', label: 'ZIP-архив' }]} />
          <button className="btn" title="Упаковать выбранное в один атлас с описанием (JSON, Spine, Starling, Cocos, свой формат…)" onClick={() => openDialog({ kind: 'spritesheet', source: o.source === 'merged' ? undefined : o.source, ids: o.ids })}>
            Упаковать в спрайтшит…
          </button>
        </Row>
        <Row label=""><Check label="JSON с координатами (и 9-slice)" checked={o.json} onChange={(json) => set({ json })} /></Row>
        <Row label="Префикс файлов"><TextInput value={o.prefix} onChange={(prefix) => set({ prefix })} width={160} placeholder="без префикса" /></Row>
      </div>
    </Modal>
  );
}

// ---------- изменение выделения ----------

function SelectModifyDialog({ op }: { op: 'grow' | 'shrink' | 'feather' | 'border' }) {
  const [v, setV] = useState(op === 'feather' ? 4 : op === 'border' ? 2 : 1);
  const titles = { grow: 'Расширить выделение', shrink: 'Сжать выделение', feather: 'Растушевка', border: 'Граница' };
  const ok = () => {
    A.modifySelection(op, v);
    closeDialog();
  };
  return (
    <Modal title={titles[op]} onClose={closeDialog} footer={<><button className="btn" onClick={closeDialog}>Отмена</button><button className="btn primary" onClick={ok}>OK</button></>}>
      <div className="form-grid">
        <Row label={op === 'feather' ? 'Радиус' : 'На'}><NumberField value={v} min={1} max={500} suffix="px" onChange={setV} /></Row>
      </div>
    </Modal>
  );
}

function GridSettingsDialog() {
  const prefs = useApp((s) => s.prefs);
  return (
    <Modal title="Сетка" onClose={closeDialog} footer={<button className="btn primary" onClick={closeDialog}>Готово</button>}>
      <div className="form-grid">
        <Row label=""><Check label="Показывать сетку" checked={prefs.grid} onChange={(grid) => setPrefs({ grid })} /></Row>
        <Row label="Шаг"><NumberField label="Ш" value={prefs.gridW} min={1} onChange={(gridW) => setPrefs({ gridW })} /><NumberField label="В" value={prefs.gridH} min={1} onChange={(gridH) => setPrefs({ gridH })} /></Row>
        <Row label=""><Check label="Привязка к сетке" checked={prefs.snap} onChange={(snap) => setPrefs({ snap })} /></Row>
        <Row label="Цвет">
          <Seg value={prefs.gridColor} onChange={(gridColor) => setPrefs({ gridColor })} options={[
            { id: 'rgba(0,180,255,0.35)', label: 'Голубой' }, { id: 'rgba(255,0,200,0.4)', label: 'Пурпурный' }, { id: 'rgba(255,255,255,0.25)', label: 'Белый' }, { id: 'rgba(0,0,0,0.4)', label: 'Чёрный' },
          ]} />
        </Row>
      </div>
    </Modal>
  );
}

function ShortcutsDialog() {
  const rows: { group: string; items: [string, string][] }[] = [
    {
      group: 'Инструменты',
      items: [
        ['Перемещение', 'V'], ['Выделение (прямоуг./овал)', 'M'], ['Лассо / прямолинейное', 'L'], ['Волшебная палочка', 'W'], ['Рамка', 'C'], ['Раскройка', 'K'],
        ['Пипетка', 'I'], ['Кисть', 'B'], ['Карандаш', 'N'], ['Ластик', 'E'], ['Заливка / градиент', 'G'], ['Фигуры', 'U'], ['Текст', 'T'], ['Рука', 'H / пробел'], ['Масштаб', 'Z'],
        ['Размер кисти', '[  ]'], ['Поменять цвета', 'X'], ['Цвета по умолчанию', 'D'], ['Пипетка в кисти/заливке', '⌥ + клик'],
      ],
    },
    {
      group: 'Выделение',
      items: [['Добавить', '⇧ + выделение'], ['Вычесть', '⌥ + выделение'], ['Пересечение', '⇧⌥ + выделение'], ['Квадрат / круг', '⇧ при протягивании'], ['От центра', '⌥ при протягивании']],
    },
  ];
  const collect = (entries: MenuEntry[], out: [string, string][]) => {
    for (const e of entries) {
      if (e === 'sep') continue;
      if ('submenu' in e) collect(e.submenu, out);
      else if (e.shortcut) out.push([e.label, formatShortcut(e.shortcut)]);
    }
  };
  for (const m of MENUS) {
    const items: [string, string][] = [];
    collect(m.items, items);
    if (items.length) rows.push({ group: m.label, items });
  }
  return (
    <Modal title="Горячие клавиши" onClose={closeDialog} width={620} footer={<button className="btn primary" onClick={closeDialog}>Закрыть</button>}>
      <div className="kbd-table">
        {rows.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <h4>{g.group}</h4>
            {g.items.map(([a, b]) => (
              <div key={g.group + a} style={{ display: 'contents' }}>
                <span>{a}</span>
                <span className="k">{b}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function AboutDialog() {
  return (
    <Modal title={`${APP_NAME} ${APP_VERSION}`} onClose={closeDialog} footer={<button className="btn primary" onClick={closeDialog}>OK</button>}>
      <div>Редактор для подготовки игровых и UI-ресурсов: нарезка, слои, экспорт.</div>
      <div className="form-grid">
        <span className="lbl">Версия</span>
        <span>{APP_VERSION}</span>
        <span className="lbl">Сборка</span>
        <span>
          {BUILD_COMMIT} · {BUILD_DATE}
        </span>
        <span className="lbl">Лицензия</span>
        <span>Apache License 2.0</span>
      </div>
      <div className="note">Открывает PNG, JPG, WebP, GIF, BMP, TIFF, TGA, PSD, ICO, SVG, HEIC. Сохраняет PSD со слоями.</div>
    </Modal>
  );
}

export function Dialogs() {
  const d = useApp((s) => s.dialog);
  useApp((s) => s.tick);
  if (!d) return null;
  const needsDoc = !['new', 'shortcuts', 'about', 'grid-settings', 'spritesheet', 'bmfont', 'pdf-import', 'color', 'scan'].includes(d.kind);
  if (needsDoc && !activeDoc()) return null;
  switch (d.kind) {
    case 'new': return <NewDialog />;
    case 'image-size': return <ImageSizeDialog />;
    case 'canvas-size': return <CanvasSizeDialog />;
    case 'filter': return activeDoc()?.activeLayer ? <FilterDialog filterId={d.filterId} /> : null;
    case 'grid-slice': return <GridSliceDialog />;
    case 'auto-slice': return <AutoSliceDialog />;
    case 'export': return <ExportDialog d={d} />;
    case 'select-modify': return <SelectModifyDialog op={d.op} />;
    case 'grid-settings': return <GridSettingsDialog />;
    case 'shortcuts': return <ShortcutsDialog />;
    case 'about': return <AboutDialog />;
    case 'layer-style': return activeDoc()?.activeLayer ? <LayerStyleDialog /> : null;
    case 'color-range': return <ColorRangeDialog />;
    case 'cut-step': return <CutStepDialog />;
    case 'new-guide': return <NewGuideDialog />;
    case 'spritesheet': return <SpriteSheetDialog d={d} />;
    case 'bmfont': return <BMFontDialog key={d.fontId ?? 'new'} fontId={d.fontId} />;
    case 'icon': return <IconDialog />;
    case 'pdf-import': return <PdfImportDialog file={d.file} />;
    case 'pdf-export': return <PdfExportDialog />;
    case 'print': return <PrintDialog />;
    case 'color': return <ColorDialog key={d.target} target={d.target} />;
    case 'scan': return <ScanDialog />;
    case 'curves': return activeDoc()?.activeLayer ? <CurvesDialog /> : null;
    case 'fill': return activeDoc()?.activeLayer ? <FillDialog /> : null;
  }
}
