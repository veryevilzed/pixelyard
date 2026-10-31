import { useEffect, useRef, useState } from 'react';
import { addDoc, addImageAsLayer } from '../actions';
import { cropCanvas, ctx2d } from '../core/canvas';
import { Doc } from '../core/doc';
import { decodeToCanvas } from '../core/io';
import { isTauri, readPath } from '../core/platform';
import { activeDoc, closeDialog, toast } from '../store';
import { changed } from '../tools/base';
import { Seg } from './controls';
import { Modal } from './Dialogs';

/** Состояние сканера из Rust (src-tauri/src/scanner.rs). */
interface Status {
  devices: { id: string; name: string; remote: boolean }[];
  selected: string | null;
  session: boolean;
  units: number[];
  unit: number | null;
  resolutions: number[];
  width: number;
  height: number;
  busy: string | null;
  progress: number;
  error: string | null;
  files: string[];
  preview: boolean;
}

/** Рамка области — доли стекла (0..1). */
interface Frac {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COMMON_DPI = [75, 100, 150, 200, 300, 400, 600, 1200, 2400];
const UNIT_LABEL: Record<number, string> = { 0: 'Планшет', 1: 'Слайды', 2: 'Негативы', 3: 'Автоподатчик' };
const KEY = 'pixelyard.scan';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * «Файл → Сканировать…»: выбор сканера, планшет/податчик, DPI, цвет; «Просмотр» — черновой скан,
 * на нём рамкой выбирается область; «Сканировать» — результат новым документом или слоем.
 */
export function ScanDialog() {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { dpi?: number; mode?: string; target?: string };
  const [st, setSt] = useState<Status | null>(null);
  const [dpi, setDpi] = useState(saved.dpi ?? 300);
  const [mode, setMode] = useState<'color' | 'gray' | 'bw'>((saved.mode as 'color') ?? 'color');
  const [unit, setUnit] = useState(0);
  const [target, setTarget] = useState<'doc' | 'layer'>(saved.target === 'layer' && activeDoc() ? 'layer' : 'doc');
  const [preview, setPreview] = useState<HTMLCanvasElement | null>(null);
  const [frac, setFrac] = useState<Frac>({ x: 0, y: 0, w: 1, h: 1 });
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);
  // настройки на момент нажатия «Сканировать» (обработчик результата создан при открытии диалога)
  const pending = useRef<{ dpi: number; frac: Frac; target: 'doc' | 'layer' } | null>(null);

  // поиск сканеров и опрос состояния
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    void call('scanner_start').catch((e) => setError(String(e)));
    const tick = async () => {
      try {
        const s = await call<Status>('scanner_status');
        if (!alive) return;
        setSt(s);
        if (s.error) setError(s.error);
        // первый найденный сканер открываем сам
        if (!opened.current && !s.selected && s.devices.length) {
          opened.current = true;
          void call('scanner_open', { id: s.devices[0].id }).catch((e) => setError(String(e)));
        }
        if (s.files.length) void receive(s.files, s.preview);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    const t = setInterval(() => void tick(), 500);
    void tick();
    return () => {
      alive = false;
      clearInterval(t);
      void call('scanner_close').catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // текущий блок сканера — в переключатель
  useEffect(() => {
    if (st?.unit !== null && st?.unit !== undefined && !st.busy) setUnit((u) => (st.units.includes(u) ? u : st.unit!));
  }, [st?.unit, st?.units.join(), st?.busy]);

  const receive = async (files: string[], isPreview: boolean) => {
    for (const path of files) {
      try {
        const f = await readPath(path);
        const img = await decodeToCanvas(f);
        if (isPreview) {
          setPreview(img);
          continue;
        }
        // область: доли стекла → пиксели скана
        const job = pending.current;
        if (!job) continue;
        const p = job.frac;
        const r = { x: Math.round(p.x * img.width), y: Math.round(p.y * img.height), w: Math.max(1, Math.round(p.w * img.width)), h: Math.max(1, Math.round(p.h * img.height)) };
        const part = p.w >= 0.999 && p.h >= 0.999 ? img : cropCanvas(img, r);
        const doc = activeDoc();
        if (job.target === 'layer' && doc) addImageAsLayer(doc, part, doc.nextLayerName('Скан'));
        else {
          const d = new Doc('Скан.psd', part.width, part.height);
          const l = d.makeLayer('Скан', part);
          d.layers = [l];
          d.activeLayerId = l.id;
          addDoc(d);
        }
        changed();
        toast(`Отсканировано: ${part.width} × ${part.height} px`);
      } catch (e) {
        setError(`Не удалось открыть скан: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  const resolutions = st?.resolutions.length ? (st.resolutions.filter((r) => COMMON_DPI.includes(r)).length ? st.resolutions.filter((r) => COMMON_DPI.includes(r)) : st.resolutions) : COMMON_DPI;
  const scan = async (isPreview: boolean) => {
    setError(null);
    localStorage.setItem(KEY, JSON.stringify({ dpi, mode, target }));
    const previewDpi = st?.resolutions.find((r) => r >= 75) ?? st?.resolutions[0] ?? 75;
    pending.current = isPreview ? null : { dpi, frac, target };
    try {
      await call('scanner_scan', { req: { unit, dpi: isPreview ? previewDpi : dpi, mode: isPreview ? 'color' : mode, preview: isPreview } });
    } catch (e) {
      setError(String(e));
    }
  };

  const busy = st?.busy ?? null;
  const wIn = (st?.width ?? 8.5) * frac.w, hIn = (st?.height ?? 11.7) * frac.h;
  const ready = !!st?.session && !busy;

  return (
    <Modal
      title="Сканирование"
      onClose={closeDialog}
      width={900}
      footer={
        <>
          <span className="left note">
            {busy === 'scanning' ? `Сканирование… ${Math.round(st?.progress ?? 0)}%` : busy === 'opening' ? 'Подключение к сканеру…' : busy === 'selecting' ? 'Переключение блока…' : `Область ${(wIn * 25.4).toFixed(0)} × ${(hIn * 25.4).toFixed(0)} мм → ${Math.round(wIn * dpi)} × ${Math.round(hIn * dpi)} px`}
          </span>
          {busy === 'scanning' ? (
            <button className="btn" onClick={() => void call('scanner_cancel')}>Остановить</button>
          ) : (
            <button className="btn" onClick={closeDialog}>Закрыть</button>
          )}
          <button className="btn" disabled={!ready || unit === 3} onClick={() => void scan(true)} title={unit === 3 ? 'Для автоподатчика просмотр не делается' : 'Быстрый черновой скан, чтобы выбрать область'}>
            Просмотр
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void scan(false)}>Сканировать</button>
        </>
      }
    >
      {!isTauri ? (
        <div className="note">Сканирование работает в программе PixelYard для macOS (через системный «Захват изображений»).</div>
      ) : (
        <div className="scan-layout">
          <ScanArea preview={preview} frac={frac} setFrac={setFrac} aspect={st?.width && st.height ? st.width / st.height : 8.5 / 11.7} disabled={unit === 3} />
          <div className="pack-settings scan-settings">
            <div className="section-title">Сканер</div>
            {st && !st.devices.length && <div className="note">Ищу сканеры… Убедитесь, что МФУ включено и видно в «Захвате изображений».</div>}
            {st && st.devices.length > 0 && (
              <select
                value={st.selected ?? ''}
                onChange={(e) => {
                  setPreview(null);
                  void call('scanner_open', { id: e.target.value }).catch((er) => setError(String(er)));
                }}
              >
                {!st.selected && <option value="">Выберите сканер</option>}
                {st.devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.remote ? ' (сеть)' : ''}</option>
                ))}
              </select>
            )}
            {st?.session && st.units.length > 1 && (
              <Seg value={String(unit)} onChange={(v) => setUnit(Number(v))} options={st.units.filter((u) => u in UNIT_LABEL).map((u) => ({ id: String(u), label: UNIT_LABEL[u] }))} />
            )}
            <div className="section-title">Качество</div>
            <div className="row-fields">
              <span className="label static">Разрешение</span>
              <select value={resolutions.includes(dpi) ? dpi : resolutions[0]} onChange={(e) => setDpi(Number(e.target.value))}>
                {resolutions.map((r) => (
                  <option key={r} value={r}>{r} dpi</option>
                ))}
              </select>
            </div>
            <Seg value={mode} onChange={setMode} options={[{ id: 'color', label: 'Цвет' }, { id: 'gray', label: 'Оттенки серого' }, { id: 'bw', label: 'Ч/Б' }]} />
            <div className="section-title">Область</div>
            <div className="note">{unit === 3 ? 'Автоподатчик сканирует лист целиком.' : preview ? 'Выделите рамкой нужную часть на превью: тяните, чтобы нарисовать, двигайте и тяните за углы.' : 'Нажмите «Просмотр», чтобы увидеть стекло и выбрать область.'}</div>
            <div className="row-fields">
              <button className="btn small" onClick={() => setFrac({ x: 0, y: 0, w: 1, h: 1 })}>Всё стекло</button>
            </div>
            <div className="section-title">Куда</div>
            <Seg value={target} onChange={setTarget} options={[{ id: 'doc', label: 'Новый документ' }, ...(activeDoc() ? [{ id: 'layer' as const, label: 'Слоем в текущий' }] : [])]} />
            {error && <div className="error-text">{error}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Превью стекла с рамкой области (доли 0..1). */
function ScanArea({ preview, frac, setFrac, aspect, disabled }: { preview: HTMLCanvasElement | null; frac: Frac; setFrac: (f: Frac) => void; aspect: number; disabled: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 500, h: 560 });
  useEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const a = preview ? preview.width / preview.height : aspect;
  const W = Math.min(box.w - 24, (box.h - 24) * a), H = W / a;
  const ox = (box.w - W) / 2, oy = (box.h - H) / 2;

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const ctx = ctx2d(c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.fillStyle = '#f4f4f2';
    ctx.fillRect(ox, oy, W, H);
    if (preview) ctx.drawImage(preview, ox, oy, W, H);
    else {
      ctx.fillStyle = '#9a9aa0';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Стекло сканера — нажмите «Просмотр»', ox + W / 2, oy + H / 2);
    }
    if (disabled) return;
    const r = { x: ox + frac.x * W, y: oy + frac.y * H, w: frac.w * W, h: frac.h * H };
    // затемнение вне рамки
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(ox, oy, W, H);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    ctx.fillStyle = '#fff';
    for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
      ctx.strokeRect(hx - 4 + 0.5, hy - 4 + 0.5, 8, 8);
    }
  }, [preview, frac, box, W, H, ox, oy, disabled]);

  const onDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const rc = canvasRef.current!.getBoundingClientRect();
    const toF = (ev: { clientX: number; clientY: number }) => ({
      x: Math.min(1, Math.max(0, (ev.clientX - rc.left - ox) / W)),
      y: Math.min(1, Math.max(0, (ev.clientY - rc.top - oy) / H)),
    });
    const p0 = toF(e);
    const tol = 8 / W;
    const cs = [[frac.x, frac.y], [frac.x + frac.w, frac.y], [frac.x, frac.y + frac.h], [frac.x + frac.w, frac.y + frac.h]];
    const ci = cs.findIndex(([x, y]) => Math.abs(x - p0.x) < tol && Math.abs(y - p0.y) < tol * (W / H));
    const inside = p0.x > frac.x && p0.y > frac.y && p0.x < frac.x + frac.w && p0.y < frac.y + frac.h;
    const base = frac;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const norm = (x0: number, y0: number, x1: number, y1: number): Frac => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(0.01, Math.abs(x1 - x0)), h: Math.max(0.01, Math.abs(y1 - y0)) });
    const move = (ev: PointerEvent) => {
      const p = toF(ev);
      if (ci >= 0) {
        // противоположный угол стоит на месте
        const [ax, ay] = cs[3 - ci];
        setFrac(norm(ax, ay, p.x, p.y));
      } else if (inside) {
        const dx = Math.min(1 - base.x - base.w, Math.max(-base.x, p.x - p0.x)), dy = Math.min(1 - base.y - base.h, Math.max(-base.y, p.y - p0.y));
        setFrac({ ...base, x: base.x + dx, y: base.y + dy });
      } else setFrac(norm(p0.x, p0.y, p.x, p.y));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="scan-preview" ref={boxRef}>
      <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} onPointerDown={onDown} />
    </div>
  );
}
