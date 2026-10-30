import { zlibSync } from 'fflate';
import { createCanvas, ctx2d } from './canvas';

/**
 * PDF: импорт страниц через pdf.js (рендер в canvas) и экспорт — свой минимальный писатель:
 * каждая страница — картинка RGB (Flate) + альфа-маска (SMask), размер в пунктах по DPI.
 */

// ---------- импорт ----------

type PdfJs = typeof import('pdfjs-dist');
let pdfjsP: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const lib = await import('pdfjs-dist');
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      lib.GlobalWorkerOptions.workerSrc = worker;
      return lib;
    })();
  }
  return pdfjsP;
}

export interface PdfInfo {
  pages: number;
  /** Размеры страниц в пунктах (1/72 дюйма). */
  sizes: { w: number; h: number }[];
  doc: unknown;
}

export async function openPdf(data: Uint8Array): Promise<PdfInfo> {
  const lib = await pdfjs();
  // pdf.js забирает буфер себе — отдаём копию
  const doc = await lib.getDocument({ data: data.slice() }).promise;
  const sizes: PdfInfo['sizes'] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const v = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: v.width, h: v.height });
  }
  return { pages: doc.numPages, sizes, doc };
}

/** Страница (с 1) в canvas при dpi; white — подложить белый (иначе прозрачный фон). */
export async function renderPdfPage(info: PdfInfo, page: number, dpi: number, white: boolean): Promise<HTMLCanvasElement> {
  const doc = info.doc as Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  const p = await doc.getPage(page);
  const viewport = p.getViewport({ scale: dpi / 72 });
  const c = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  const ctx = ctx2d(c);
  await p.render({ canvas: c, canvasContext: ctx, viewport, background: white ? '#ffffff' : 'rgba(0,0,0,0)' }).promise;
  return c;
}

// ---------- экспорт ----------

const enc = new TextEncoder();

/** PDF из картинок: страница на картинку, размер в пунктах = пиксели × 72 / dpi. */
export function encodePdf(pages: HTMLCanvasElement[], dpi = 72, title = ''): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const offsets: number[] = [];
  const push = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    chunks.push(u);
    size += u.length;
  };
  // нумерация: 1 — каталог, 2 — дерево страниц, 3 — сведения, далее по 4 объекта на страницу
  const pageObj = (i: number) => 4 + i * 4;
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
  obj(3, `<< /Producer (PixelYard) /Title (${esc(title)}) >>`);
  pages.forEach((c, i) => {
    const w = c.width, h = c.height;
    const px = ctx2d(c).getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
    let opaque = true;
    for (let p = 0, q = 0, a = 0; p < px.length; p += 4) {
      rgb[q++] = px[p];
      rgb[q++] = px[p + 1];
      rgb[q++] = px[p + 2];
      alpha[a++] = px[p + 3];
      if (px[p + 3] !== 255) opaque = false;
    }
    const pw = (w * 72) / dpi, ph = (h * 72) / dpi;
    const n = pageObj(i);
    const content = enc.encode(`q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${content.length} >>`, content);
    const img = zlibSync(rgb, { level: 6 });
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${opaque ? '' : ` /SMask ${n + 3} 0 R`} /Length ${img.length} >>`, img);
    // объект маски заводим всегда, чтобы нумерация не сбивалась
    const mask = zlibSync(opaque ? new Uint8Array(0) : alpha, { level: 6 });
    obj(n + 3, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>`, mask);
  });
  const count = 4 + pages.length * 4;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
