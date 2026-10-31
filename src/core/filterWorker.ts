import { FILTERS, type Params } from './filters';

/** Фоновый поток фильтров: получает кусок картинки, применяет фильтр, возвращает пиксели. */

interface Job {
  id: number;
  filterId: string;
  params: Params;
  buf: ArrayBuffer;
  w: number;
  h: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, filterId, params, buf, w, h } = e.data;
  try {
    const f = FILTERS.find((x) => x.id === filterId);
    if (!f) throw new Error(`Нет фильтра ${filterId}`);
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    const res = f.apply(img, params) ?? img;
    const out = res.data.buffer as ArrayBuffer;
    (self as unknown as Worker).postMessage({ id, buf: out, w: res.width, h: res.height }, [out]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
