import { rgbaToHex } from '../core/canvas';
import { activeDoc, useApp, useCursor } from '../store';
import { NumberField } from './controls';
import { zoomTo } from '../actions';

export function StatusBar() {
  useApp((s) => s.tick);
  const cur = useCursor();
  const doc = activeDoc();
  if (!doc) return <div className="statusbar">Откройте или создайте изображение (⌘O / ⌘N), либо перетащите файлы в окно</div>;
  const sel = doc.selection?.bounds;
  const slice = doc.slices.find((s) => s.id === doc.activeSliceId);
  return (
    <div className="statusbar">
      <NumberField value={Math.round(doc.view.zoom * 1000) / 10} onChange={(v) => zoomTo(v / 100)} min={2} max={6400} step={1} suffix="%" width={60} />
      <span>
        {doc.width} × {doc.height} px
      </span>
      <span>Слоёв: {doc.layers.length}</span>
      {doc.slices.length > 0 && <span>Слайсов: {doc.slices.length}</span>}
      {sel && (
        <span>
          Выделение: {sel.x}, {sel.y} — {sel.w} × {sel.h}
        </span>
      )}
      {slice && (
        <span>
          Слайс «{slice.name}»: {slice.x}, {slice.y} — {slice.w} × {slice.h}
        </span>
      )}
      <span className="spacer" />
      {cur.inside && (
        <>
          <span>
            X: {cur.x} Y: {cur.y}
          </span>
          {cur.color && (
            <span>
              <span className="px" style={{ background: `rgba(${cur.color[0]},${cur.color[1]},${cur.color[2]},${cur.color[3] / 255})` }} />
              {rgbaToHex(cur.color)} · R{cur.color[0]} G{cur.color[1]} B{cur.color[2]} A{cur.color[3]}
            </span>
          )}
        </>
      )}
    </div>
  );
}
