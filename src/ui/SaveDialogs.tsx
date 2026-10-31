import { useEffect, useMemo, useRef, useState } from 'react';
import { SAVE_FORMATS, saveDocAs, type SaveFormat } from '../actions';
import { createCanvas, cropCanvas, ctx2d, rgbaToCss, scaleCanvas } from '../core/canvas';
import { encodeCanvas, fileStem } from '../core/io';
import { saveFileAs } from '../core/platform';
import { maskedCopy } from '../core/selection';
import { activeDoc, closeDialog, toast, useApp } from '../store';
import { Check, NumberField, Seg } from './controls';
import { Modal } from './Dialogs';

// ---------- «Сохранить как» с выбором формата ----------

const SAVE_KEY = 'pixelyard.saveAs';

export function SaveAsDialog() {
  const doc = activeDoc()!;
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as { fmt?: SaveFormat; quality?: number };
  // по умолчанию — формат текущего файла, иначе последний выбранный, иначе PSD
  const ext = doc.name.toLowerCase().split('.').pop();
  const fromName = SAVE_FORMATS.find((f) => f.ext === ext || (ext === 'jpeg' && f.id === 'jpg') || (ext === 'tiff' && f.id === 'tiff'))?.id;
  const [fmt, setFmt] = useState<SaveFormat>(doc.path ? fromName ?? 'psd' : saved.fmt ?? 'psd');
  const [quality, setQuality] = useState(saved.quality ?? 92);
  const f = SAVE_FORMATS.find((x) => x.id === fmt)!;
  const layered = doc.layers.length > 1 || doc.groups.length > 0 || doc.layers.some((l) => l.text || l.mask);
  const ok = () => {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ fmt, quality }));
    closeDialog();
    void saveDocAs(fmt, quality);
  };
  return (
    <Modal
      title="Сохранить как"
      onClose={closeDialog}
      width={520}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" onClick={ok}>Сохранить…</button>
        </>
      }
    >
      <div className="save-formats">
        {SAVE_FORMATS.map((x) => (
          <label key={x.id} className={`save-format ${fmt === x.id ? 'on' : ''}`}>
            <input type="radio" name="fmt" checked={fmt === x.id} onChange={() => setFmt(x.id)} />
            <span>
              <b>{x.label}</b>
              <span className="note">{x.hint}</span>
            </span>
            <span className="ext">.{x.ext}</span>
          </label>
        ))}
      </div>
      {f.quality && (
        <div className="row-fields" style={{ marginTop: 10 }}>
          <span className="label static">Качество</span>
          <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ flex: 1 }} />
          <NumberField value={quality} min={1} max={100} width={40} onChange={(v) => setQuality(Math.round(v))} suffix="%" />
        </div>
      )}
      {fmt !== 'psd' && layered && <div className="note" style={{ marginTop: 10, color: 'var(--warn)' }}>В этом формате слои, маски и текст не сохранятся — в файл попадёт сведённое изображение. Чтобы сохранить слои, выберите PSD.</div>}
    </Modal>
  );
}

// ---------- «Экспортировать как» (как в Photoshop) ----------

type ExportFmt = 'png' | 'jpg' | 'webp';
const EXP_KEY = 'pixelyard.exportAs';

interface ExpSettings {
  fmt: ExportFmt;
  quality: number;
  transparent: boolean;
  scale: number;
  smooth: boolean;
}

const formatSize = (n: number) => (n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 / 1024).toFixed(2)} МБ`);

/**
 * Экспорт сведённого изображения (или выделения) в PNG/JPEG/WebP с масштабом, качеством,
 * прозрачностью или подложкой; предпросмотр и размер итогового файла считаются вживую.
 */
export function ExportAsDialog() {
  const doc = activeDoc()!;
  const bg = useApp((s) => s.bg);
  const [s, setS] = useState<ExpSettings>(() => ({ fmt: 'png', quality: 90, transparent: true, scale: 100, smooth: true, ...JSON.parse(localStorage.getItem(EXP_KEY) ?? '{}') }));
  const [onlySel, setOnlySel] = useState(!!doc.selection);
  const set = (p: Partial<ExpSettings>) => setS((o) => ({ ...o, ...p }));
  const src = useMemo(() => {
    const flat = doc.composite();
    return onlySel && doc.selection ? cropCanvas(maskedCopy(flat, doc.selection), doc.selection.bounds) : flat;
  }, [doc, onlySel]);
  const W = Math.max(1, Math.round((src.width * s.scale) / 100)), H = Math.max(1, Math.round((src.height * s.scale) / 100));
  const alpha = s.fmt !== 'jpg' && s.transparent;

  /** Итоговая картинка: масштаб + подложка (если без прозрачности). */
  const render = () => {
    const sc = W === src.width && H === src.height ? src : scaleCanvas(src, W, H, s.smooth);
    if (alpha) return sc;
    const out = createCanvas(W, H);
    const ctx = ctx2d(out);
    ctx.fillStyle = s.fmt === 'jpg' && s.transparent ? '#ffffff' : rgbaToCss([bg[0], bg[1], bg[2], 255]);
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(sc, 0, 0);
    return out;
  };

  // предпросмотр и размер файла — с задержкой, чтобы ползунки не тормозили
  const [info, setInfo] = useState<{ size: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lastUrl = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const data = await encodeCanvas(render(), s.fmt, s.quality);
        if (!alive) return;
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: s.fmt === 'jpg' ? 'image/jpeg' : `image/${s.fmt}` }));
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url;
        setInfo({ size: data.length, url });
      } catch (e) {
        if (alive) toast(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        if (alive) setBusy(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, s, bg]);
  useEffect(() => () => void (lastUrl.current && URL.revokeObjectURL(lastUrl.current)), []);

  const run = async () => {
    localStorage.setItem(EXP_KEY, JSON.stringify(s));
    const ext = s.fmt;
    try {
      const data = await encodeCanvas(render(), s.fmt, s.quality);
      const path = await saveFileAs(`${fileStem(doc.name)}.${ext}`, data, [{ name: ext.toUpperCase(), extensions: ext === 'jpg' ? ['jpg', 'jpeg'] : [ext] }]);
      if (path) {
        toast(`Экспортировано: ${W} × ${H}, ${formatSize(data.length)}`);
        closeDialog();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Modal
      title="Экспортировать как"
      onClose={closeDialog}
      width={960}
      footer={
        <>
          <span className="left note">{busy ? 'Расчёт…' : info ? `${s.fmt.toUpperCase()} · ${W} × ${H} px · ${formatSize(info.size)}` : ''}</span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" onClick={() => void run()}>Экспортировать…</button>
        </>
      }
    >
      <div className="export-as">
        <div className="export-preview">{info && <img src={info.url} alt="" style={{ imageRendering: s.smooth ? 'auto' : 'pixelated' }} />}</div>
        <div className="pack-settings">
          <div className="section-title">Формат файла</div>
          <Seg value={s.fmt} onChange={(fmt) => set({ fmt })} options={[{ id: 'png', label: 'PNG' }, { id: 'jpg', label: 'JPEG' }, { id: 'webp', label: 'WebP' }]} />
          {s.fmt !== 'jpg' ? (
            <Check label="Прозрачность" checked={s.transparent} onChange={(transparent) => set({ transparent })} />
          ) : (
            <div className="note">JPEG без прозрачности — прозрачное станет белым.</div>
          )}
          {s.fmt !== 'jpg' && !s.transparent && <div className="note">Прозрачное заливается фоновым цветом.</div>}
          {s.fmt !== 'png' && (
            <div className="row-fields">
              <span className="label static">Качество</span>
              <input type="range" min={1} max={100} value={s.quality} onChange={(e) => set({ quality: Number(e.target.value) })} style={{ flex: 1 }} />
              <NumberField value={s.quality} min={1} max={100} width={40} onChange={(v) => set({ quality: Math.round(v) })} suffix="%" />
            </div>
          )}
          {s.fmt === 'webp' && s.quality === 100 && <div className="note">Качество 100 — без потерь.</div>}
          <div className="section-title">Размер изображения</div>
          <div className="row-fields">
            <NumberField label="Ш" value={W} min={1} max={30000} width={56} onChange={(v) => set({ scale: Math.max(1, (v / src.width) * 100) })} suffix="px" />
            <NumberField label="В" value={H} min={1} max={30000} width={56} onChange={(v) => set({ scale: Math.max(1, (v / src.height) * 100) })} suffix="px" />
          </div>
          <div className="row-fields">
            <NumberField label="Масштаб" value={Math.round(s.scale * 10) / 10} min={1} max={1000} step={1} width={50} onChange={(scale) => set({ scale })} suffix="%" />
          </div>
          <div className="row-fields" style={{ flexWrap: 'wrap' }}>
            {[25, 50, 100, 200, 300, 400].map((k) => (
              <button key={k} className={`btn small ${Math.abs(s.scale - k) < 0.01 ? 'primary' : ''}`} onClick={() => set({ scale: k })}>{k / 100}x</button>
            ))}
          </div>
          <Check label="Сглаживание (выкл. — пиксель-арт)" checked={s.smooth} onChange={(smooth) => set({ smooth })} />
          {doc.selection && (
            <>
              <div className="section-title">Что экспортировать</div>
              <Seg value={onlySel ? 'sel' : 'all'} onChange={(v) => setOnlySel(v === 'sel')} options={[{ id: 'all', label: 'Всё изображение' }, { id: 'sel', label: 'Выделенную область' }]} />
            </>
          )}
          <div className="note">Быстрый экспорт в PNG без настроек — ⌥⇧⌘E.</div>
        </div>
      </div>
    </Modal>
  );
}

