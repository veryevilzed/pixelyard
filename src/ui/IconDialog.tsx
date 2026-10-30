import { useEffect, useMemo, useRef, useState } from 'react';
import { writeFiles } from '../core/export';
import { fileStem } from '../core/io';
import { buildIconFiles, DEFAULT_ICON, ICO_SIZES, ICNS_SIZES, PLATFORMS, renderIcon, type IconOptions, type IconPlatform } from '../core/icons';
import { activeDoc, closeDialog, toast } from '../store';
import { Check, TextInput } from './controls';
import { Modal } from './Dialogs';
import { Line, RangeRow } from './PackDialogs';

const KEY = 'pixelyard.icon';

/** Превью одного размера в масштабе 1:1 (для 16–64 — ещё и увеличенное ×4). */
function IconPreview({ src, size, o, mac }: { src: HTMLCanvasElement; size: number; o: IconOptions; mac?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = size <= 64 ? size * 2 : Math.min(size, 160);
  useEffect(() => {
    const st = mac && o.macShape ? { ...o.style, padding: Math.max(o.style.padding, 100 / 1024), radius: 0.2237 * (1 - 2 * Math.max(o.style.padding, 100 / 1024)) } : o.style;
    const img = renderIcon(src, size, st);
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = shown * dpr;
    c.height = shown * dpr;
    const ctx = c.getContext('2d')!;
    // мелкие размеры показываем «по пикселям», чтобы было видно, читается ли значок
    ctx.imageSmoothingEnabled = size > 64;
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }, [src, size, o, mac, shown]);
  return (
    <div className="icon-preview">
      <canvas ref={ref} style={{ width: shown, height: shown }} />
      <span>{size}</span>
    </div>
  );
}

export function IconDialog() {
  const doc = activeDoc();
  const src = useMemo(() => doc?.composite() ?? null, [doc]);
  const [o, setO] = useState<IconOptions>(() => ({ ...DEFAULT_ICON, ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), name: doc ? fileStem(doc.name) : 'icon' }));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<IconOptions>) => setO({ ...o, ...p });
  const setStyle = (p: Partial<IconOptions['style']>) => set({ style: { ...o.style, ...p } });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  if (!doc || !src) return null;
  const square = src.width === src.height;
  const small = Math.max(src.width, src.height) < 1024;

  const run = async (asZip: boolean) => {
    if (!o.platforms.length) return toast('Выберите хотя бы одну платформу', 'error');
    localStorage.setItem(KEY, JSON.stringify({ ...o, name: undefined }));
    setBusy(true);
    try {
      const files = await buildIconFiles(src, o);
      const res = await writeFiles(files, o.name, asZip);
      if (res) {
        toast(`Иконки: ${res.files} файл(ов) → ${res.target}`);
        closeDialog();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const previewSizes = o.platforms.includes('windows') ? [...o.icoSizes].sort((a, b) => a - b) : [16, 32, 64, 128, 256];
  return (
    <Modal
      title="Иконка приложения"
      onClose={closeDialog}
      width={1100}
      footer={
        <>
          <span className="left note">
            {busy ? 'Сборка…' : `Источник — сведённое изображение ${src.width}×${src.height}${!square ? ' (не квадрат — впишется с полями)' : ''}${small ? '; для 1024 px лучше исходник от 1024×1024' : ''}`}
          </span>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn" disabled={busy} onClick={() => void run(true)}>В ZIP…</button>
          <button className="btn primary" disabled={busy} onClick={() => void run(false)}>Сохранить в папку…</button>
        </>
      }
    >
      <div className="pack-layout">
        <div className="pack-settings">
          <div className="section-title">Платформы</div>
          {PLATFORMS.map((p) => (
            <div key={p.id} className="icon-platform">
              <Check label={<b>{p.label}</b>} checked={o.platforms.includes(p.id)} onChange={() => set({ platforms: toggle<IconPlatform>(o.platforms, p.id) })} />
              <div className="note">{p.hint}</div>
              {p.id === 'windows' && o.platforms.includes('windows') && (
                <div className="size-chips">
                  {ICO_SIZES.map((s) => (
                    <button key={s} className={`btn small ${o.icoSizes.includes(s) ? 'primary' : ''}`} onClick={() => set({ icoSizes: toggle(o.icoSizes, s) })}>{s}</button>
                  ))}
                </div>
              )}
              {p.id === 'macos' && o.platforms.includes('macos') && (
                <Check label="Форма macOS (скруглённый квадрат с полями, как у системных иконок)" checked={o.macShape} onChange={(macShape) => set({ macShape })} />
              )}
              {p.id === 'png' && o.platforms.includes('png') && (
                <div className="size-chips">
                  {[16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024].map((s) => (
                    <button key={s} className={`btn small ${o.pngSizes.includes(s) ? 'primary' : ''}`} onClick={() => set({ pngSizes: toggle(o.pngSizes, s).sort((a, b) => a - b) })}>{s}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="section-title">Оформление</div>
          <RangeRow label="Поля" value={Math.round(o.style.padding * 100)} min={0} max={30} suffix="%" onChange={(v) => setStyle({ padding: v / 100 })} />
          <RangeRow label="Скругление" value={Math.round(o.style.radius * 100)} min={0} max={50} suffix="%" onChange={(v) => setStyle({ radius: v / 100 })} />
          <Line label="Подложка">
            <Check label="Залить" checked={!!o.style.background} onChange={(v) => setStyle({ background: v ? o.opaqueColor : null })} />
            <input type="color" value={o.style.background ?? o.opaqueColor} onChange={(e) => set({ opaqueColor: e.target.value, style: { ...o.style, background: o.style.background ? e.target.value : null } })} />
            <span className="note">iOS и apple-touch-icon всегда с подложкой</span>
          </Line>
          <Line label="">
            <Check label="Сглаживание при уменьшении (выкл. — пиксель-арт)" checked={o.style.smooth} onChange={(smooth) => setStyle({ smooth })} />
          </Line>
          <Line label="Имя файлов">
            <TextInput value={o.name} onChange={(name) => set({ name })} width={200} />
          </Line>
        </div>
        <div className="pack-preview">
          <div className="section-title">Предпросмотр {o.platforms.includes('windows') ? '(размеры .ico)' : ''}</div>
          <div className="icon-previews">
            {previewSizes.map((s) => (
              <IconPreview key={s} src={src} size={s} o={o} />
            ))}
          </div>
          {o.platforms.includes('macos') && (
            <>
              <div className="section-title">macOS</div>
              <div className="icon-previews">
                {ICNS_SIZES.filter((s) => s <= 512).map((s) => (
                  <IconPreview key={s} src={src} size={s} o={o} mac />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
