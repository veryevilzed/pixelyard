import {
  Blend, Brush, CircleDashed, Crop, Eraser, Hand, Lasso, LassoSelect, Move, PaintBucket, Pencil, Pipette, Shapes, Slice,
  SquareDashed, Type, WandSparkles, ZoomIn, ArrowLeftRight, Scissors,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { resetColors, setTool, swapColors } from '../actions';
import { rgbaToCss } from '../core/canvas';
import { openColorPicker } from './panels/ColorPanel';
import { useApp, type ToolId } from '../store';

interface ToolDef {
  id: ToolId;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  key: string;
}

const GROUPS: ToolDef[][] = [
  [
    { id: 'move', icon: Move, label: 'Перемещение', key: 'V' },
    { id: 'marquee-rect', icon: SquareDashed, label: 'Прямоугольное выделение', key: 'M' },
    { id: 'marquee-ellipse', icon: CircleDashed, label: 'Овальное выделение', key: '⇧M / M' },
    { id: 'lasso', icon: Lasso, label: 'Лассо', key: 'L' },
    { id: 'polygon-lasso', icon: LassoSelect, label: 'Прямолинейное лассо', key: 'L' },
    { id: 'wand', icon: WandSparkles, label: 'Волшебная палочка', key: 'W' },
  ],
  [
    { id: 'crop', icon: Crop, label: 'Рамка (кадрирование)', key: 'C' },
    { id: 'slice', icon: Slice, label: 'Раскройка (слайсы)', key: 'K' },
    { id: 'knife', icon: Scissors, label: 'Нож (раскрой линиями)', key: '⇧K / K' },
    { id: 'eyedropper', icon: Pipette, label: 'Пипетка', key: 'I' },
  ],
  [
    { id: 'brush', icon: Brush, label: 'Кисть', key: 'B' },
    { id: 'pencil', icon: Pencil, label: 'Карандаш (попиксельно)', key: 'N' },
    { id: 'eraser', icon: Eraser, label: 'Ластик', key: 'E' },
    { id: 'fill', icon: PaintBucket, label: 'Заливка', key: 'G' },
    { id: 'gradient', icon: Blend, label: 'Градиент', key: 'G' },
  ],
  [
    { id: 'shape', icon: Shapes, label: 'Фигуры', key: 'U' },
    { id: 'text', icon: Type, label: 'Текст', key: 'T' },
  ],
  [
    { id: 'hand', icon: Hand, label: 'Рука (или пробел)', key: 'H' },
    { id: 'zoom', icon: ZoomIn, label: 'Масштаб', key: 'Z' },
  ],
];

export const TOOL_LABELS = Object.fromEntries(GROUPS.flat().map((t) => [t.id, t.label])) as Record<ToolId, string>;

export function Toolbox() {
  const tool = useApp((s) => s.tool);
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  return (
    <div className="toolbox">
      {GROUPS.map((g, i) => (
        <div key={i} style={{ display: 'contents' }}>
          {i > 0 && <div className="tool-sep" />}
          {g.map((t) => (
            <button key={t.id} className={`tool-btn ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
              <t.icon size={17} strokeWidth={1.75} />
            </button>
          ))}
        </div>
      ))}
      <div className="tool-sep" />
      <div className="swatches">
        <div className="swatch bg" style={{ background: rgbaToCss(bg) }} title="Фоновый цвет" onClick={() => openColorPicker('bg')} />
        <div className="swatch fg" style={{ background: rgbaToCss(fg) }} title="Основной цвет" onClick={() => openColorPicker('fg')} />
      </div>
      <div className="swatch-tools">
        <span title="Поменять местами (X)" onClick={swapColors}>
          <ArrowLeftRight size={11} />
        </span>
        <span title="По умолчанию (D)" onClick={resetColors}>
          D
        </span>
      </div>
    </div>
  );
}
