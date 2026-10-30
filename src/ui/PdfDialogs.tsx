import { useEffect, useRef, useState } from 'react';
import { addDoc } from '../actions';
import { createCanvas, ctx2d, cropCanvas } from '../core/canvas';
import { renderLayer } from '../core/composite';
import { Doc } from '../core/doc';
import { fileStem } from '../core/io';
import { encodePdf, openPdf, renderPdfPage, type PdfInfo } from '../core/pdf';
import { saveFileAs, type LoadedFile } from '../core/platform';
import { activeDoc, closeDialog, toast, useApp } from '../store';
import { Check, NumberField, Seg } from './controls';
import { Modal } from './Dialogs';

const DPIS = [72, 96, 150, 300];

// ---------- импорт ----------

type ImportMode = 'page' | 'layers' | 'docs';

export function PdfImportDialog({ file }: { file: LoadedFile }) {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = JSON.parse(localStorage.getItem('pixelyard.pdfImport') ?? '{}') as { mode?: ImportMode; dpi?: number; white?: boolean };
  const [mode, setMode] = useState<ImportMode>(saved.mode ?? 'page');
  const [page, setPage] = useState(1);
  const [dpi, setDpi] = useState(saved.dpi ?? 150);
  const [white, setWhite] = useState(saved.white ?? true);
  const thumb = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    openPdf(file.data).then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [file]);

  // миниатюра выбранной страницы
  useEffect(() => {
    if (!info) return;
    let alive = true;
    void renderPdfPage(info, page, 40, white).then((c) => {
      const t = thumb.current;
      if (!alive || !t) return;
      const k = Math.min(260 / c.width, 340 / c.height);
      t.width = c.width * k;
      t.height = c.height * k;
      const ctx = ctx2d(t);
      ctx.clearRect(0, 0, t.width, t.height);
      ctx.drawImage(c, 0, 0, t.width, t.height);
    });
    return () => {
      alive = false;
    };
  }, [info, page, white]);

  const sz = info?.sizes[page - 1];
  const px = (pt: number) => Math.round((pt * dpi) / 72);
  const run = async () => {
    if (!info) return;
    localStorage.setItem('pixelyard.pdfImport', JSON.stringify({ mode, dpi, white }));
    closeDialog();
    useApp.setState({ busy: 'Импорт PDF…' });
    try {
      const name = fileStem(file.name);
      const list = mode === 'page' ? [page] : Array.from({ length: info.pages }, (_, i) => i + 1);
      const canvases: HTMLCanvasElement[] = [];
      for (const p of list) {
        useApp.setState({ busy: `Импорт PDF… страница ${p} из ${info.pages}` });
        canvases.push(await renderPdfPage(info, p, dpi, white));
      }
      if (mode === 'layers') {
        // все страницы — слоями одного документа (размер по самой большой), первая страница сверху
        const W = Math.max(...canvases.map((c) => c.width)), H = Math.max(...canvases.map((c) => c.height));
        const doc = new Doc(`${name}.psd`, W, H);
        doc.layers = canvases
          .map((c, i) => {
            const lc = doc.newLayerCanvas();
            ctx2d(lc).drawImage(c, 0, 0);
            return { ...doc.makeLayer(`Страница ${list[i]}`, lc), visible: i === 0 };
          })
          .reverse();
        doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
        addDoc(doc);
      } else {
        canvases.forEach((c, i) => {
          const doc = new Doc(list.length > 1 ? `${name}-${list[i]}.psd` : `${name}.psd`, c.width, c.height);
          const l = doc.makeLayer(`Страница ${list[i]}`, c);
          doc.layers = [l];
          doc.activeLayerId = l.id;
          addDoc(doc);
        });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      useApp.setState({ busy: null });
    }
  };

  return (
    <Modal
      title={`Импорт PDF — ${file.name}`}
      onClose={closeDialog}
      width={760}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" disabled={!info} onClick={() => void run()}>Открыть</button>
        </>
      }
    >
      {error && <div className="error-text">Не удалось открыть PDF: {error}</div>}
      {!info && !error && <div className="note">Чтение PDF…</div>}
      {info && (
        <div className="pdf-import">
          <div className="pdf-thumb">
            <canvas ref={thumb} />
          </div>
          <div className="form-grid">
            <span className="lbl">Страниц</span>
            <span>{info.pages}</span>
            <span className="lbl">Что открыть</span>
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { id: 'page', label: 'Одну' },
                { id: 'layers', label: 'Все слоями', title: 'Каждая страница — слой одного документа' },
                { id: 'docs', label: 'Все вкладками', title: 'Каждая страница — отдельная вкладка' },
              ]}
            />
            <span className="lbl">{mode === 'page' ? 'Страница' : 'Просмотр'}</span>
            <span className="row-fields">
              <NumberField value={page} min={1} max={info.pages} width={50} onChange={(v) => setPage(Math.round(v))} />
              <span className="note">из {info.pages}</span>
            </span>
            <span className="lbl">Разрешение</span>
            <span className="row-fields">
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                {DPIS.map((d) => (
                  <option key={d} value={d}>{d} dpi</option>
                ))}
              </select>
              {sz && <span className="note">{px(sz.w)} × {px(sz.h)} px</span>}
            </span>
            <span className="lbl">Фон</span>
            <Check label="Белая подложка (иначе прозрачный)" checked={white} onChange={setWhite} />
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- экспорт ----------

type ExportMode = 'merged' | 'layers' | 'slices';

export function PdfExportDialog() {
  const doc = activeDoc();
  const saved = JSON.parse(localStorage.getItem('pixelyard.pdfExport') ?? '{}') as { mode?: ExportMode; dpi?: number; white?: boolean; order?: 'top' | 'bottom' };
  const [mode, setMode] = useState<ExportMode>(saved.mode === 'slices' && !doc?.slices.length ? 'merged' : saved.mode ?? 'merged');
  const [dpi, setDpi] = useState(saved.dpi ?? 72);
  const [white, setWhite] = useState(saved.white ?? false);
  const [order, setOrder] = useState<'top' | 'bottom'>(saved.order ?? 'top');
  if (!doc) return null;
  const visible = doc.layers.filter((l) => l.visible);
  const pageCount = mode === 'merged' ? 1 : mode === 'layers' ? visible.length : doc.slices.length;

  const withBg = (c: HTMLCanvasElement) => {
    if (!white) return c;
    const out = createCanvas(c.width, c.height);
    const ctx = ctx2d(out);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(c, 0, 0);
    return out;
  };

  const run = async () => {
    localStorage.setItem('pixelyard.pdfExport', JSON.stringify({ mode, dpi, white, order }));
    let pages: HTMLCanvasElement[];
    if (mode === 'merged') pages = [doc.composite()];
    else if (mode === 'slices') {
      const flat = doc.composite();
      pages = doc.slices.map((s) => cropCanvas(flat, s));
    } else {
      // слой со стилями, маской и непрозрачностью — как он выглядит сам по себе
      const list = order === 'top' ? [...visible].reverse() : visible;
      pages = list.map((l) => {
        const c = createCanvas(doc.width, doc.height);
        const ctx = ctx2d(c);
        ctx.globalAlpha = l.opacity;
        ctx.drawImage(renderLayer(l, doc.rev), 0, 0);
        return c;
      });
    }
    if (!pages.length) return toast('Нет страниц для PDF', 'error');
    closeDialog();
    useApp.setState({ busy: 'Сборка PDF…' });
    try {
      const data = encodePdf(pages.map(withBg), dpi, fileStem(doc.name));
      const path = await saveFileAs(`${fileStem(doc.name)}.pdf`, data, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (path) toast(`PDF сохранён: ${pages.length} стр.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      useApp.setState({ busy: null });
    }
  };

  return (
    <Modal
      title="Экспорт в PDF"
      onClose={closeDialog}
      width={560}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>Отмена</button>
          <button className="btn primary" disabled={!pageCount} onClick={() => void run()}>Сохранить PDF…</button>
        </>
      }
    >
      <div className="form-grid">
        <span className="lbl">Слои</span>
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { id: 'merged', label: 'Объединить', title: 'Все слои сведены в одну страницу' },
            { id: 'layers', label: 'Слой = страница', title: 'Каждый видимый слой — отдельная страница' },
            ...(doc.slices.length ? [{ id: 'slices' as const, label: 'Слайс = страница' }] : []),
          ]}
        />
        {mode === 'layers' && (
          <>
            <span className="lbl">Порядок</span>
            <Seg value={order} onChange={setOrder} options={[{ id: 'top', label: 'Сверху вниз' }, { id: 'bottom', label: 'Снизу вверх' }]} />
          </>
        )}
        <span className="lbl">Разрешение</span>
        <span className="row-fields">
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {DPIS.map((d) => (
              <option key={d} value={d}>{d} dpi</option>
            ))}
          </select>
          <span className="note">
            страница {((doc.width * 25.4) / dpi).toFixed(0)} × {((doc.height * 25.4) / dpi).toFixed(0)} мм
          </span>
        </span>
        <span className="lbl">Фон</span>
        <Check label="Белая подложка (иначе прозрачность сохраняется)" checked={white} onChange={setWhite} />
        <span className="lbl" />
        <span className="note">Страниц: {pageCount}. Картинки без потерь (Flate), прозрачность — маской.</span>
      </div>
    </Modal>
  );
}
