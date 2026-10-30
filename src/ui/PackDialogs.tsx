import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc } from '../actions';
import {
  customToDef, loadCustomFormats, saveCustomFormats, SPRITE_FORMATS, SPRITE_TEMPLATE_EXAMPLE, SPRITE_VARS, spriteTemplateData,
  type CustomFormat, type FormatDef,
} from '../core/atlasFormats';
import {
  CHARSETS, DEFAULT_FONT, FONT_FORMATS, FONT_VARS, fontTemplateData, gridFont, isEmptyGlyph, packFont, renderFont,
  type FontSettings, type RenderedFont,
} from '../core/bmfont';
import { alphaBounds, createCanvas, ctx2d, cropCanvas, uid } from '../core/canvas';
import { newAtlasAction } from '../atlasActions';
import { splitSpritePath } from '../core/atlas';
import { isAtlas, syncAtlas } from '../core/atlasDoc';
import { renderLayer } from '../core/composite';
import { Doc } from '../core/doc';
import { writeFiles } from '../core/export';
import { decodeToCanvas, encodeCanvas, fileStem, type ImageFormat } from '../core/io';
import type { PackResult } from '../core/pack';
import { openFiles } from '../core/platform';
import { buildSheetFiles, DEFAULT_SHEET, efficiency, packSprites, type SheetOptions, type SpriteSource } from '../core/spritesheet';
import type { Slice } from '../core/types';
import { activeDoc, closeDialog, toast, type DialogState } from '../store';
import { Check, ColorField, NumberField, Seg, TextInput } from './controls';
import { Modal } from './Dialogs';
import { saveFont, useFonts } from '../core/fontLibrary';

// ---------- выбор формата и редактор своих шаблонов ----------

function useFormats(kind: 'sprites' | 'font', builtins: FormatDef[]) {
  const [custom, setCustom] = useState<CustomFormat[]>(() => loadCustomFormats());
  const all = useMemo(() => [...builtins, ...custom.filter((c) => c.kind === kind).map(customToDef)], [builtins, custom, kind]);
  const save = (list: CustomFormat[]) => {
    saveCustomFormats(list);
    setCustom(list);
  };
  return { all, custom, save };
}

function FormatPicker(props: {
  kind: 'sprites' | 'font';
  formats: ReturnType<typeof useFormats>;
  value: string;
  onChange: (id: string) => void;
  extraOptions?: { id: string; label: string }[];
  vars: [string, string][];
  example: string;
}) {
  const { formats, value, onChange } = props;
  const [editing, setEditing] = useState<CustomFormat | null>(null);
  const current = formats.all.find((f) => f.id === value);
  const isCustom = formats.custom.some((c) => c.id === value);
  const startNew = (base?: FormatDef) =>
    setEditing({
      id: uid('fmt'),
      label: base ? `${base.label.replace(/ \(свой\)$/, '')} — копия` : 'Мой формат',
      ext: base?.ext ?? (props.kind === 'font' ? 'fnt' : 'json'),
      kind: props.kind,
      template: base?.template ?? props.example,
    });
  return (
    <>
      <div className="range-row">
        <span className="lbl">Формат описания</span>
        <span style={{ gridColumn: '2 / 4', display: 'flex', gap: 6 }}>
          <select value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            {props.extraOptions?.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
            {formats.all.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
          <button className="btn" title="Создать свой формат по шаблону" onClick={() => startNew(current?.template ? current : undefined)}>Свой…</button>
          {isCustom && (
            <button className="btn" onClick={() => setEditing({ ...formats.custom.find((c) => c.id === value)! })}>Изменить</button>
          )}
        </span>
      </div>
      {editing && (
        <div className="template-editor">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <TextInput value={editing.label} onChange={(label) => setEditing({ ...editing, label })} width={200} placeholder="Название формата" />
            <span className="note">расширение .</span>
            <TextInput value={editing.ext} onChange={(ext) => setEditing({ ...editing, ext: ext.replace(/^\.+/, '') })} width={60} />
          </div>
          <textarea
            className="template-text"
            spellCheck={false}
            value={editing.template}
            onChange={(e) => setEditing({ ...editing, template: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <details>
            <summary className="note">Переменные шаблона</summary>
            <div className="kbd-table" style={{ fontSize: 11 }}>
              {props.vars.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <code>{k}</code>
                  <span className="note" style={{ textAlign: 'left' }}>{v}</span>
                </div>
              ))}
            </div>
          </details>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {formats.custom.some((c) => c.id === editing.id) && (
              <button
                className="btn"
                onClick={() => {
                  formats.save(formats.custom.filter((c) => c.id !== editing.id));
                  setEditing(null);
                  onChange(formats.all[0].id);
                }}
              >
                Удалить
              </button>
            )}
            <button className="btn" onClick={() => setEditing(null)}>Отмена</button>
            <button
              className="btn primary"
              onClick={() => {
                const list = formats.custom.some((c) => c.id === editing.id) ? formats.custom.map((c) => (c.id === editing.id ? editing : c)) : [...formats.custom, editing];
                formats.save(list);
                onChange(editing.id);
                setEditing(null);
              }}
            >
              Сохранить формат
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function RangeRow(props: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="range-row">
      <span className="lbl">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <NumberField value={props.value} min={props.min} max={props.max} step={props.step} width={52} suffix={props.suffix} onChange={props.onChange} />
    </div>
  );
}

export function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="range-row">
      <span className="lbl">{label}</span>
      <span style={{ gridColumn: '2 / 4', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{children}</span>
    </div>
  );
}

/** Размер блока — превью перерисовываются, когда раскладка диалога устоялась или изменилась. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Превью атласа: шахматка, картинка по размеру окна, рамки кадров. */
function AtlasPreview({ canvas, frames, info }: { canvas: HTMLCanvasElement | null; frames?: { name: string; x: number; y: number; w: number; h: number }[]; info: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showFrames, setShowFrames] = useState(true);
  const layout = useRef({ k: 1, ox: 0, oy: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const boxSize = useBoxSize(boxRef);
  useEffect(() => {
    const c = ref.current!;
    const box = c.parentElement!.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = box.width * dpr;
    c.height = box.height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (!canvas) return;
    const k = Math.min((box.width - 16) / canvas.width, (box.height - 16) / canvas.height, 4);
    const w = canvas.width * k, h = canvas.height * k;
    const ox = (box.width - w) / 2, oy = (box.height - h) / 2;
    layout.current = { k, ox, oy };
    for (let y = 0; y < h; y += 8)
      for (let x = 0; x < w; x += 8) {
        ctx.fillStyle = ((x + y) / 8) % 2 ? '#2e2e33' : '#3a3a40';
        ctx.fillRect(ox + x, oy + y, Math.min(8, w - x), Math.min(8, h - y));
      }
    ctx.imageSmoothingEnabled = k < 1;
    ctx.drawImage(canvas, ox, oy, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1);
    if (showFrames && frames) {
      for (const f of frames) {
        if (!f.w) continue;
        ctx.strokeStyle = f.name === hover ? '#ffb02e' : 'rgba(80,170,255,0.55)';
        ctx.strokeRect(ox + f.x * k + 0.5, oy + f.y * k + 0.5, f.w * k - 1, f.h * k - 1);
      }
    }
  }, [canvas, frames, hover, showFrames, boxSize]);
  return (
    <div className="atlas-preview-wrap">
      <div
        ref={boxRef}
        className="atlas-preview"
        onMouseMove={(e) => {
          if (!frames) return;
          const r = e.currentTarget.getBoundingClientRect();
          const { k, ox, oy } = layout.current;
          const x = (e.clientX - r.left - ox) / k, y = (e.clientY - r.top - oy) / k;
          setHover(frames.find((f) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h)?.name ?? null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={ref} />
      </div>
      <div className="note" style={{ display: 'flex', gap: 10 }}>
        <span style={{ flex: 1 }}>{info}{hover ? ` · ${hover}` : ''}</span>
        {frames && <Check label="Рамки" checked={showFrames} onChange={setShowFrames} />}
      </div>
    </div>
  );
}

// ---------- спрайтшит ----------

type SheetSource = 'layers' | 'slices' | 'files';

export function SpriteSheetDialog({ d }: { d: Extract<DialogState, { kind: 'spritesheet' }> }) {
  const doc = activeDoc();
  const [source, setSource] = useState<SheetSource>(d.source ?? (doc ? (doc.slices.length ? 'slices' : 'layers') : 'files'));
  const [ids, setIds] = useState<string[]>(() => d.ids ?? (doc ? (source === 'slices' ? doc.slices.map((s) => s.id) : doc.layers.filter((l) => l.visible).map((l) => l.id)) : []));
  const [files, setFiles] = useState<SpriteSource[]>([]);
  const [o, setO] = useState<SheetOptions>(() => ({ ...DEFAULT_SHEET, ...JSON.parse(localStorage.getItem('pixelyard.sheet') ?? '{}'), name: doc ? fileStem(doc.name) : 'atlas' }));
  const formats = useFormats('sprites', SPRITE_FORMATS);
  const [formatId, setFormatId] = useState<string>(() => localStorage.getItem('pixelyard.sheet.format') ?? 'tp-hash');
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<SheetOptions>) => setO({ ...o, ...p });
  const format = formats.all.find((f) => f.id === formatId) ?? formats.all[0];

  const sprites: SpriteSource[] = useMemo(() => {
    if (source === 'files') return files;
    if (!doc) return [];
    if (source === 'layers') {
      return doc.layers
        .filter((l) => ids.includes(l.id))
        .map((l) => {
          const c = createCanvas(doc.width, doc.height);
          const ctx = ctx2d(c);
          ctx.globalAlpha = l.opacity;
          ctx.drawImage(renderLayer(l, doc.rev), 0, 0);
          return { name: l.name, canvas: c };
        });
    }
    const comp = doc.composite();
    return doc.slices.filter((s: Slice) => ids.includes(s.id)).map((s) => ({ name: s.name, canvas: cropCanvas(comp, s) }));
  }, [source, ids, files, doc]);

  const [packed, setPacked] = useState<{ p: PackResult | null; error: string | null }>({ p: null, error: null });
  useEffect(() => {
    const t = setTimeout(() => {
      if (!sprites.length) return setPacked({ p: null, error: 'Выберите спрайты' });
      try {
        setPacked({ p: packSprites(sprites, o, 1), error: null });
      } catch (e) {
        setPacked({ p: null, error: e instanceof Error ? e.message : String(e) });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [sprites, o]);

  const dataPreview = useMemo(() => {
    if (!packed.p || !format) return '';
    try {
      const text = format.render(spriteTemplateData(packed.p.frames, { image: `${o.name}.${o.imageFormat === 'jpg' ? 'jpg' : o.imageFormat}`, width: packed.p.width, height: packed.p.height, scale: 1, app: 'PixelYard' }));
      return text.split('\n').slice(0, 80).join('\n');
    } catch (e) {
      return `Ошибка шаблона: ${e instanceof Error ? e.message : e}`;
    }
  }, [packed, format, o.name, o.imageFormat]);

  const addFiles = async () => {
    const picked = await openFiles([{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'psd'] }]);
    const loaded: SpriteSource[] = [];
    for (const f of picked) {
      try {
        loaded.push({ name: fileStem(f.name), canvas: await decodeToCanvas(f) });
      } catch (e) {
        toast(`${f.name}: ${e instanceof Error ? e.message : e}`, 'error');
      }
    }
    setFiles([...files, ...loaded]);
  };

  const run = async (asZip: boolean) => {
    if (!format) return;
    localStorage.setItem('pixelyard.sheet', JSON.stringify({ ...o, name: undefined }));
    localStorage.setItem('pixelyard.sheet.format', format.id);
    setBusy(true);
    try {
      const out = await buildSheetFiles(sprites, o, format);
      const res = await writeFiles(out, o.name, asZip);
      if (res) {
        toast(`Спрайтшит: ${res.files} файлов → ${res.target}`);
        closeDialog();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Те же спрайты и настройки — в атлас-документ. */
  const openAsAtlas = () => {
    const list = sprites
      .map((sp) => {
        const b = alphaBounds(sp.canvas);
        return b ? { ...splitSpritePath(sp.name.replace(/\s*\/\s*/g, '/')), image: cropCanvas(sp.canvas, b) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const ad = newAtlasAction(list, o.name || 'atlas');
    if (isAtlas(ad)) {
      ad.atlas = {
        ...ad.atlas,
        settings: { ...ad.atlas.settings, maxSize: o.maxSize, spacing: o.spacing, border: o.border, extrude: o.extrude, pot: o.pot, square: o.square, trim: o.trim },
        export: {
          ...ad.atlas.export,
          formatId: format?.id ?? ad.atlas.export.formatId,
          imageFormat: o.imageFormat === 'tiff' ? 'png' : o.imageFormat,
          quality: o.quality,
          smoothScale: o.smoothScale,
          scales: ad.atlas.export.scales.map((x) => ({ ...x, enabled: (o.scales.length ? o.scales : [1]).includes(x.scale) })),
        },
      };
      syncAtlas(ad);
      ad.savedRev = -1;
    }
    closeDialog();
  };

  const items = source === 'layers' && doc ? [...doc.layers].reverse().map((l) => ({ id: l.id, name: l.name })) : source === 'slices' && doc ? doc.slices.map((s) => ({ id: s.id, name: s.name })) : [];
  const p = packed.p;
  return (
    <Modal
      title="Спрайтшит"
      onClose={closeDialog}
      width={1180}
      footer={
        <>
          <span className="left">
            <button className="btn" disabled={!sprites.length || busy} onClick={openAsAtlas} title="Атлас-документ: правка спрайтов, анимации, несколько страниц, сохранение в .pyard">
              Открыть как проект атласа
            </button>
          </span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn" disabled={!p || busy} onClick={() => void run(true)}>В ZIP…</button>
          <button className="btn primary" disabled={!p || busy} onClick={() => void run(false)}>Сохранить в папку…</button>
        </>
      }
    >
      <div className="pack-layout">
        <div className="pack-settings">
          <Line label="Источник">
            <Seg
              value={source}
              onChange={(s) => {
                setSource(s);
                if (doc) setIds(s === 'slices' ? doc.slices.map((x) => x.id) : doc.layers.filter((l) => l.visible).map((l) => l.id));
              }}
              options={[
                ...(doc ? [{ id: 'layers' as const, label: `Слои (${doc.layers.length})` }, { id: 'slices' as const, label: `Слайсы (${doc.slices.length})` }] : []),
                { id: 'files' as const, label: `Файлы (${files.length})` },
              ]}
            />
          </Line>
          {source === 'files' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" onClick={() => void addFiles()}>Добавить картинки…</button>
              {files.length > 0 && <button className="btn" onClick={() => setFiles([])}>Очистить</button>}
              <span className="note">{files.map((f) => f.name).slice(0, 6).join(', ')}{files.length > 6 ? '…' : ''}</span>
            </div>
          ) : (
            <div className="check-list" style={{ maxHeight: 130 }}>
              {items.map((it) => (
                <label key={it.id}>
                  <input type="checkbox" checked={ids.includes(it.id)} onChange={(e) => setIds(e.target.checked ? [...ids, it.id] : ids.filter((x) => x !== it.id))} />
                  {it.name}
                </label>
              ))}
            </div>
          )}
          <Line label="Имя файлов"><TextInput value={o.name} onChange={(name) => set({ name: name || 'atlas' })} width={180} /></Line>
          <FormatPicker kind="sprites" formats={formats} value={format?.id ?? ''} onChange={setFormatId} vars={SPRITE_VARS} example={SPRITE_TEMPLATE_EXAMPLE} />
          <Line label="Картинка">
            <Seg value={o.imageFormat} onChange={(imageFormat: ImageFormat) => set({ imageFormat })} options={[{ id: 'png', label: 'PNG' }, { id: 'webp', label: 'WebP' }, { id: 'jpg', label: 'JPG' }]} />
            {o.imageFormat !== 'png' && <NumberField label="Качество" value={o.quality} min={1} max={100} width={44} onChange={(quality) => set({ quality })} />}
          </Line>
          <Line label="Размер атласа">
            <select value={o.maxSize} onChange={(e) => set({ maxSize: Number(e.target.value) })}>
              {[256, 512, 1024, 2048, 4096, 8192].map((s) => (
                <option key={s} value={s}>до {s}</option>
              ))}
            </select>
            <Check label="Степень двойки" checked={o.pot} onChange={(pot) => set({ pot })} />
            <Check label="Квадрат" checked={o.square} onChange={(square) => set({ square })} />
          </Line>
          <RangeRow label="Зазор между" value={o.spacing} min={0} max={32} suffix="px" onChange={(spacing) => set({ spacing })} />
          <RangeRow label="Отступ от края" value={o.border} min={0} max={32} suffix="px" onChange={(border) => set({ border })} />
          <RangeRow label="Extrude (против швов)" value={o.extrude} min={0} max={8} suffix="px" onChange={(extrude) => set({ extrude })} />
          <Line label="">
            <Check label="Обрезать прозрачное" checked={o.trim} onChange={(trim) => set({ trim })} />
            <Check label="Сглаживание масштаба" checked={o.smoothScale} onChange={(smoothScale) => set({ smoothScale })} />
          </Line>
          <Line label="Масштабы">
            {[0.5, 1, 2, 3, 4].map((s) => (
              <Check key={s} label={`@${s}x`} checked={o.scales.includes(s)} onChange={(v) => set({ scales: v ? [...o.scales, s].sort((a, b) => a - b) : o.scales.filter((x) => x !== s) })} />
            ))}
          </Line>
        </div>
        <div className="pack-preview">
          <AtlasPreview
            canvas={p?.canvas ?? null}
            frames={p?.frames}
            info={packed.error ?? (p ? `${p.width} × ${p.height} · кадров: ${p.frames.length} · заполнение ${Math.round(efficiency(p) * 100)}%` : '')}
          />
          <pre className="data-preview">{dataPreview}</pre>
        </div>
      </div>
    </Modal>
  );
}

// ---------- растровый шрифт ----------

const FONT_FAMILIES = [
  'Arial Black', 'Arial', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Optima', 'Trebuchet MS', 'Verdana',
  'Georgia', 'Times New Roman', 'Baskerville', 'Didot', 'Rockwell', 'American Typewriter', 'Copperplate',
  'Impact', 'Chalkboard SE', 'Marker Felt', 'Menlo', 'Courier New',
];

type FontMode = string; // id формата, 'grid' или 'grid-json'

export function BMFontDialog({ fontId }: { fontId?: string }) {
  // правка шрифта из библиотеки — его настройки и имя; новый — последние использованные
  const editing = fontId ? useFonts.getState().fonts.find((f) => f.id === fontId && f.settings) : undefined;
  const [s, setS] = useState<FontSettings>(() => ({ ...DEFAULT_FONT, ...(editing?.settings ?? JSON.parse(localStorage.getItem('pixelyard.bmfont') ?? '{}')) }));
  const [charset, setCharset] = useState<string>(() => CHARSETS.find((c) => c.chars === s.chars)?.id ?? 'custom');
  const [name, setName] = useState(editing?.name ?? 'font');
  const [libId] = useState(() => editing?.id ?? uid('fn'));
  const inLibrary = useFonts((st) => st.fonts.some((f) => f.id === libId));
  const [mode, setMode] = useState<FontMode>(() => localStorage.getItem('pixelyard.bmfont.mode') ?? 'fnt');
  const [columns, setColumns] = useState(16);
  // формат картинки шрифта запоминается вместе с настройками
  const [img, setImg] = useState<{ format: 'png' | 'webp'; quality: number }>(() => ({ format: 'png', quality: 100, ...JSON.parse(localStorage.getItem('pixelyard.bmfont.image') ?? '{}') }));
  const imageName = `${name}.${img.format}`;
  const [packO, setPackO] = useState({ maxSize: 1024, spacing: 2, border: 0, extrude: 0, pot: true, square: false });
  const [sample, setSample] = useState('PixelYard 0123456789\nThe quick brown fox jumps!');
  const [bg, setBg] = useState<'dark' | 'light' | 'checker'>('dark');
  const [customFonts, setCustomFonts] = useState<string[]>([]);
  const formats = useFormats('font', FONT_FORMATS);
  const set = (p: Partial<FontSettings>) => setS({ ...s, ...p });
  const grid = mode === 'grid' || mode === 'grid-json';
  const format = formats.all.find((f) => f.id === mode);

  // рендер глифов — с задержкой, чтобы слайдеры не тормозили
  const [font, setFont] = useState<RenderedFont | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setFont(renderFont(s));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 150);
    return () => clearTimeout(t);
  }, [s]);

  const layout = useMemo(() => {
    if (!font) return null;
    try {
      if (grid) {
        const g = gridFont(font, columns, packO.spacing);
        return { canvas: g.canvas, info: `Сетка ${g.cols}×${g.rows}, ячейка ${g.cellW}×${g.cellH} · ${g.canvas.width}×${g.canvas.height}`, grid: g, packed: null };
      }
      const p = packFont(font, packO);
      return { canvas: p.canvas, info: `${p.width}×${p.height} · символов: ${font.glyphs.length} · кернинг: ${font.kernings.length} · строка ${font.lineHeight}px`, grid: null, packed: p };
    } catch (e) {
      return { canvas: null, info: e instanceof Error ? e.message : String(e), grid: null, packed: null };
    }
  }, [font, grid, columns, packO]);

  // предпросмотр текста готовыми глифами — так, как его нарисует движок
  const sampleRef = useRef<HTMLCanvasElement>(null);
  const sampleBoxRef = useRef<HTMLDivElement>(null);
  const sampleSize = useBoxSize(sampleBoxRef);
  useEffect(() => {
    const c = sampleRef.current!;
    const box = c.parentElement!.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = box.width * dpr;
    c.height = box.height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (!font) return;
    const glyph = new Map(font.glyphs.map((g) => [g.char, g]));
    const kern = new Map(font.kernings.map((k) => [`${k.first}:${k.second}`, k.amount]));
    const lines = sample.split('\n');
    const totalH = lines.length * font.lineHeight;
    const widest = Math.max(...lines.map((l) => Array.from(l).reduce((w, ch) => w + (glyph.get(ch)?.xadvance ?? 0), 0)));
    const k = Math.min(1, (box.width - 24) / Math.max(1, widest), (box.height - 16) / Math.max(1, totalH));
    ctx.scale(k, k);
    lines.forEach((line, li) => {
      let x = 12 / k;
      let prev: number | null = null;
      for (const ch of Array.from(line)) {
        const g = glyph.get(ch);
        if (!g) continue;
        if (prev !== null) x += kern.get(`${prev}:${g.id}`) ?? 0;
        if (!isEmptyGlyph(g)) ctx.drawImage(g.canvas, x + g.xoffset, 8 / k + li * font.lineHeight + g.yoffset);
        x += g.xadvance;
        prev = g.id;
      }
    });
  }, [font, sample, bg, sampleSize]);

  const dataPreview = useMemo(() => {
    if (!font || !layout) return '';
    if (layout.grid) {
      return mode === 'grid' ? 'Только картинка-сетка: символы идут по порядку набора, слева направо, сверху вниз.' : JSON.stringify(gridMeta(font, layout.grid, imageName), null, 2).split('\n').slice(0, 60).join('\n');
    }
    if (!layout.packed || !format) return '';
    return format.render(fontTemplateData(font, layout.packed, imageName, s)).split('\n').slice(0, 60).join('\n');
  }, [font, layout, format, imageName, s, mode]);

  const loadFont = async () => {
    const picked = await openFiles([{ name: 'Шрифты', extensions: ['ttf', 'otf', 'woff', 'woff2'] }], false);
    const f = picked[0];
    if (!f) return;
    try {
      const family = fileStem(f.name);
      const face = new FontFace(family, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer);
      await face.load();
      document.fonts.add(face);
      setCustomFonts([...customFonts, family]);
      set({ family });
      toast(`Шрифт «${family}» загружен`);
    } catch (e) {
      toast(`Не удалось загрузить шрифт: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  const save = async (asZip: boolean) => {
    if (!font || !layout?.canvas) return;
    localStorage.setItem('pixelyard.bmfont', JSON.stringify(s));
    localStorage.setItem('pixelyard.bmfont.mode', mode);
    localStorage.setItem('pixelyard.bmfont.image', JSON.stringify(img));
    try {
      const files: Record<string, Uint8Array> = {};
      files[imageName] = await encodeCanvas(layout.canvas, img.format, img.quality);
      if (layout.grid && mode === 'grid-json') files[`${name}.json`] = new TextEncoder().encode(JSON.stringify(gridMeta(font, layout.grid, imageName), null, 2));
      if (layout.packed && format) files[`${name}.${format.ext}`] = new TextEncoder().encode(format.render(fontTemplateData(font, layout.packed, imageName, s)));
      const res = await writeFiles(files, name, asZip);
      if (res) toast(`Шрифт сохранён: ${res.files} файл(а) → ${res.target}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  /** Атлас открывается обычным документом со слайсами по глифам — можно дорисовать руками. */
  const openAsDoc = () => {
    if (!font || !layout?.canvas) return;
    const c = layout.canvas;
    const nd = new Doc(`${name}.psd`, c.width, c.height);
    const l = nd.makeLayer('Глифы', c);
    nd.layers = [l];
    nd.activeLayerId = l.id;
    if (layout.packed) {
      nd.slices = layout.packed.frames.filter((f) => f.w > 0).map((f) => ({ id: uid('sl'), name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, nine: null }));
    } else if (layout.grid) {
      const g = layout.grid;
      nd.slices = font.glyphs.map((gl, i) => ({ id: uid('sl'), name: gl.char, x: (i % g.cols) * (g.cellW + packO.spacing), y: Math.floor(i / g.cols) * (g.cellH + packO.spacing), w: g.cellW, h: g.cellH, nine: null }));
    }
    addDoc(nd);
    closeDialog();
  };

  const fx = (key: 'stroke' | 'shadow' | 'glow' | 'innerShadow', p: object) => set({ [key]: { ...s[key], ...p } } as Partial<FontSettings>);
  const bgStyle = bg === 'dark' ? '#15151a' : bg === 'light' ? '#f2f2f2' : 'repeating-conic-gradient(#3a3a40 0 25%, #2e2e33 0 50%) 0 0 / 16px 16px';

  return (
    <Modal
      title={editing ? `Растровый шрифт — ${editing.name}` : 'Растровый шрифт (BMFont)'}
      onClose={closeDialog}
      width={1180}
      footer={
        <>
          <span className="left">
            <button className="btn" disabled={!layout?.canvas} onClick={openAsDoc}>Открыть атлас как документ</button>
            <button
              className="btn"
              disabled={!font}
              title="Шрифт появится в инструменте «Текст» и в меню «Шрифт → Редактировать»"
              onClick={() => {
                if (!font) return;
                saveFont({ id: libId, name, source: 'generated', settings: s, font });
                localStorage.setItem('pixelyard.bmfont', JSON.stringify(s));
                toast(inLibrary ? `Шрифт «${name}» обновлён` : `Шрифт «${name}» добавлен — выберите его в инструменте «Текст»`);
              }}
            >
              {inLibrary ? 'Обновить в библиотеке' : 'В библиотеку шрифтов'}
            </button>
          </span>
          <button className="btn" onClick={closeDialog}>Закрыть</button>
          <button className="btn" disabled={!layout?.canvas} onClick={() => void save(true)}>В ZIP…</button>
          <button className="btn primary" disabled={!layout?.canvas} onClick={() => void save(false)}>Сохранить в папку…</button>
        </>
      }
    >
      <div className="pack-layout">
        <div className="pack-settings">
          <div className="section-title">Шрифт</div>
          <Line label="Гарнитура">
            <select value={s.family} onChange={(e) => set({ family: e.target.value })} style={{ fontFamily: s.family, flex: 1, minWidth: 0 }}>
              {[...customFonts, ...FONT_FAMILIES].map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
            </select>
            <button className="btn" title="TTF, OTF, WOFF" onClick={() => void loadFont()}>Свой файл…</button>
          </Line>
          <RangeRow label="Размер" value={s.size} min={8} max={256} suffix="px" onChange={(size) => set({ size })} />
          <Line label="">
            <Check label={<b>Жирный</b>} checked={s.bold} onChange={(bold) => set({ bold })} />
            <Check label={<i>Курсив</i>} checked={s.italic} onChange={(italic) => set({ italic })} />
            <Check label="Сглаживание" checked={s.antialias} onChange={(antialias) => set({ antialias })} />
            <Check label="Кернинг" checked={s.kerning} onChange={(kerning) => set({ kerning })} />
          </Line>
          <RangeRow label="Межбуквенный" value={s.letterSpacing} min={-10} max={40} suffix="px" onChange={(letterSpacing) => set({ letterSpacing })} />
          <RangeRow label="Межстрочный" value={s.lineHeight} min={60} max={200} suffix="%" onChange={(lineHeight) => set({ lineHeight })} />
          <Line label="Символы">
            <select value={charset} onChange={(e) => { setCharset(e.target.value); const cs = CHARSETS.find((c) => c.id === e.target.value); if (cs) set({ chars: cs.chars }); }}>
              {CHARSETS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
              <option value="custom">Свой набор</option>
            </select>
            <span className="note">{Array.from(new Set(Array.from(s.chars))).length} шт.</span>
          </Line>
          <textarea className="chars-input" value={s.chars} spellCheck={false} onChange={(e) => { setCharset('custom'); set({ chars: e.target.value }); }} onKeyDown={(e) => e.stopPropagation()} style={{ fontFamily: s.family }} />

          <div className="section-title">Заливка</div>
          <Line label="">
            <Seg value={s.fillMode} onChange={(fillMode) => set({ fillMode })} options={[{ id: 'solid', label: 'Цвет' }, { id: 'gradient', label: 'Градиент' }]} />
            {s.fillMode === 'solid' ? (
              <ColorField value={s.color} onChange={(color) => set({ color })} showHex />
            ) : (
              <>
                <ColorField value={s.gradTop} onChange={(gradTop) => set({ gradTop })} />
                {s.gradUseMid && <ColorField value={s.gradMid} onChange={(gradMid) => set({ gradMid })} />}
                <ColorField value={s.gradBottom} onChange={(gradBottom) => set({ gradBottom })} />
                <Check label="Средний цвет" checked={s.gradUseMid} onChange={(gradUseMid) => set({ gradUseMid })} />
              </>
            )}
          </Line>

          <div className="section-title">Эффекты</div>
          <Line label="">
            <Check label="Обводка" checked={s.stroke.enabled} onChange={(enabled) => fx('stroke', { enabled })} />
            {s.stroke.enabled && (
              <>
                <ColorField value={s.stroke.color} onChange={(color) => fx('stroke', { color })} />
                <NumberField value={s.stroke.size} min={1} max={32} width={40} suffix="px" onChange={(size) => fx('stroke', { size })} />
                <Seg value={s.stroke.position} onChange={(position) => fx('stroke', { position })} options={[{ id: 'outside', label: 'Снаружи' }, { id: 'center', label: 'Центр' }, { id: 'inside', label: 'Внутри' }]} />
              </>
            )}
          </Line>
          <Line label="">
            <Check label="Тень" checked={s.shadow.enabled} onChange={(enabled) => fx('shadow', { enabled })} />
            {s.shadow.enabled && (
              <>
                <ColorField value={s.shadow.color} onChange={(color) => fx('shadow', { color })} />
                <NumberField label="Смещ." value={s.shadow.distance} min={0} max={64} width={36} onChange={(distance) => fx('shadow', { distance })} />
                <NumberField label="∠" value={s.shadow.angle} min={-180} max={180} width={40} suffix="°" onChange={(angle) => fx('shadow', { angle })} />
                <NumberField label="Размытие" value={s.shadow.size} min={0} max={32} width={36} onChange={(size) => fx('shadow', { size })} />
                <NumberField label="Непр." value={s.shadow.opacity} min={0} max={100} width={36} suffix="%" onChange={(opacity) => fx('shadow', { opacity })} />
              </>
            )}
          </Line>
          <Line label="">
            <Check label="Свечение" checked={s.glow.enabled} onChange={(enabled) => fx('glow', { enabled })} />
            {s.glow.enabled && (
              <>
                <ColorField value={s.glow.color} onChange={(color) => fx('glow', { color })} />
                <NumberField label="Размер" value={s.glow.size} min={1} max={48} width={36} onChange={(size) => fx('glow', { size })} />
                <NumberField label="Непр." value={s.glow.opacity} min={0} max={100} width={36} suffix="%" onChange={(opacity) => fx('glow', { opacity })} />
              </>
            )}
          </Line>
          <Line label="">
            <Check label="Внутренняя тень" checked={s.innerShadow.enabled} onChange={(enabled) => fx('innerShadow', { enabled })} />
            {s.innerShadow.enabled && (
              <>
                <ColorField value={s.innerShadow.color} onChange={(color) => fx('innerShadow', { color })} />
                <NumberField label="Смещ." value={s.innerShadow.distance} min={0} max={32} width={36} onChange={(distance) => fx('innerShadow', { distance })} />
                <NumberField label="Непр." value={s.innerShadow.opacity} min={0} max={100} width={36} suffix="%" onChange={(opacity) => fx('innerShadow', { opacity })} />
              </>
            )}
          </Line>

          <div className="section-title">Атлас и файлы</div>
          <Line label="Имя файлов"><TextInput value={name} onChange={(v) => setName(v || 'font')} width={160} /></Line>
          <FormatPicker
            kind="font"
            formats={formats}
            value={mode}
            onChange={setMode}
            extraOptions={[{ id: 'grid', label: 'Сетка (только PNG)' }, { id: 'grid-json', label: 'Сетка + JSON' }]}
            vars={FONT_VARS}
            example={FONT_FORMATS[0].template!}
          />
          {grid ? (
            <RangeRow label="Колонок в сетке" value={columns} min={1} max={64} onChange={setColumns} />
          ) : (
            <Line label="Размер атласа">
              <select value={packO.maxSize} onChange={(e) => setPackO({ ...packO, maxSize: Number(e.target.value) })}>
                {[256, 512, 1024, 2048, 4096].map((v) => (
                  <option key={v} value={v}>до {v}</option>
                ))}
              </select>
              <Check label="Степень двойки" checked={packO.pot} onChange={(pot) => setPackO({ ...packO, pot })} />
            </Line>
          )}
          <Line label="Картинка">
            <Seg value={img.format} onChange={(format) => setImg({ ...img, format })} options={[{ id: 'png', label: 'PNG' }, { id: 'webp', label: 'WebP' }]} />
            {img.format === 'webp' && <NumberField label="Кач." value={img.quality} min={1} max={100} width={40} onChange={(quality) => setImg({ ...img, quality: Math.round(quality) })} title="100 = без потерь" />}
          </Line>
          <RangeRow label="Зазор" value={packO.spacing} min={0} max={16} suffix="px" onChange={(spacing) => setPackO({ ...packO, spacing })} />
          <RangeRow label="Поля глифа" value={s.padding} min={0} max={16} suffix="px" onChange={(padding) => set({ padding })} />
        </div>
        <div className="pack-preview">
          <AtlasPreview canvas={layout?.canvas ?? null} frames={layout?.packed?.frames} info={error ?? layout?.info ?? 'Рендер…'} />
          <div className="sample-box" ref={sampleBoxRef} style={{ background: bgStyle }}>
            <canvas ref={sampleRef} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <textarea className="sample-input" value={sample} onChange={(e) => setSample(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <Seg value={bg} onChange={setBg} options={[{ id: 'dark', label: 'Тёмный' }, { id: 'light', label: 'Светлый' }, { id: 'checker', label: '▦' }]} />
          </div>
          <pre className="data-preview small">{dataPreview}</pre>
        </div>
      </div>
    </Modal>
  );
}

function gridMeta(font: RenderedFont, g: ReturnType<typeof gridFont>, image: string) {
  return {
    image,
    cellWidth: g.cellW,
    cellHeight: g.cellH,
    columns: g.cols,
    rows: g.rows,
    lineHeight: font.lineHeight,
    baseline: g.baseline,
    originX: g.originX,
    chars: font.glyphs.map((gl) => gl.char).join(''),
    advance: Object.fromEntries(font.glyphs.map((gl) => [gl.char, gl.xadvance])),
  };
}

