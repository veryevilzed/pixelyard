import {
  Blend, Brush, CircleDashed, Crop, Eraser, Hand, Lasso, LassoSelect, Move, PaintBucket, Pencil, Pipette, Shapes, Slice,
  SquareDashed, Type, WandSparkles, ZoomIn, ArrowLeftRight, Scissors, Stamp,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
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

/** Разделы панели (между ними черта); в разделе — группы, в группе — варианты (выбор удержанием кнопки). */
const SECTIONS: ToolDef[][][] = [
  [
    [{ id: 'move', icon: Move, label: 'Перемещение', key: 'V' }],
    [
      { id: 'marquee-rect', icon: SquareDashed, label: 'Прямоугольное выделение', key: 'M' },
      { id: 'marquee-ellipse', icon: CircleDashed, label: 'Овальное выделение', key: 'M' },
    ],
    [
      { id: 'lasso', icon: Lasso, label: 'Лассо', key: 'L' },
      { id: 'polygon-lasso', icon: LassoSelect, label: 'Прямолинейное лассо', key: 'L' },
    ],
    [{ id: 'wand', icon: WandSparkles, label: 'Волшебная палочка', key: 'W' }],
  ],
  [
    [{ id: 'crop', icon: Crop, label: 'Рамка (кадрирование)', key: 'C' }],
    [
      { id: 'slice', icon: Slice, label: 'Раскройка (слайсы)', key: 'K' },
      { id: 'knife', icon: Scissors, label: 'Нож (раскрой линиями)', key: 'K' },
    ],
    [{ id: 'eyedropper', icon: Pipette, label: 'Пипетка', key: 'I' }],
  ],
  [
    [
      { id: 'brush', icon: Brush, label: 'Кисть', key: 'B' },
      { id: 'pencil', icon: Pencil, label: 'Карандаш (попиксельно)', key: 'N' },
    ],
    [{ id: 'eraser', icon: Eraser, label: 'Ластик', key: 'E' }],
    [{ id: 'stamp', icon: Stamp, label: 'Штамп (⌥+клик — источник)', key: 'S' }],
    [
      { id: 'gradient', icon: Blend, label: 'Градиент', key: 'G' },
      { id: 'fill', icon: PaintBucket, label: 'Заливка', key: 'G' },
    ],
  ],
  [
    [{ id: 'shape', icon: Shapes, label: 'Фигуры', key: 'U' }],
    [{ id: 'text', icon: Type, label: 'Текст', key: 'T' }],
  ],
  [
    [{ id: 'hand', icon: Hand, label: 'Рука (или пробел)', key: 'H' }],
    [{ id: 'zoom', icon: ZoomIn, label: 'Масштаб', key: 'Z' }],
  ],
];
const GROUPS = SECTIONS.flat();

/** Последний выбранный вариант в каждой группе (по первому инструменту группы); хранится между запусками. */
const LAST_KEY = 'pixelyard.toolGroups';
const useLast = create<Record<string, ToolId>>(() => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
  } catch {
    return {};
  }
});
useLast.subscribe((s) => localStorage.setItem(LAST_KEY, JSON.stringify(s)));
// выбор инструмента клавишей или из меню — тоже запоминается в его группе
useApp.subscribe((s, prev) => {
  if (s.tool === prev.tool) return;
  const g = GROUPS.find((x) => x.some((t) => t.id === s.tool));
  if (g && g.length > 1) useLast.setState({ [g[0].id]: s.tool });
});

export const TOOL_LABELS = Object.fromEntries(GROUPS.flat().map((t) => [t.id, t.label])) as Record<ToolId, string>;

const HOLD_MS = 350;

/** Кнопка группы: клик — текущий вариант, удержание или правый клик — список вариантов. */
function ToolGroup({ group }: { group: ToolDef[] }) {
  const tool = useApp((s) => s.tool);
  const last = useLast((s) => s[group[0].id]);
  const [fly, setFly] = useState<{ x: number; y: number } | null>(null);
  const shown = group.find((t) => t.id === tool) ?? group.find((t) => t.id === last) ?? group[0];
  const active = group.some((t) => t.id === tool);
  const timer = useRef(0);
  const opened = useRef(false);
  const openFly = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setFly({ x: r.right + 4, y: r.top });
  };
  useEffect(() => {
    if (!fly) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest('.tool-fly') && setFly(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFly(null);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [fly]);
  const many = group.length > 1;
  return (
    <>
      <button
        className={`tool-btn ${active ? 'active' : ''} ${many ? 'has-group' : ''}`}
        title={many ? `${shown.label} (${shown.key}) — удерживайте для выбора: ${group.map((t) => t.label).join(', ')}` : `${shown.label} (${shown.key})`}
        onPointerDown={(e) => {
          if (e.button !== 0 || !many) return;
          opened.current = false;
          const el = e.currentTarget;
          timer.current = window.setTimeout(() => {
            opened.current = true;
            openFly(el);
          }, HOLD_MS);
        }}
        onPointerUp={() => clearTimeout(timer.current)}
        onPointerLeave={() => clearTimeout(timer.current)}
        onClick={() => !opened.current && setTool(shown.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (many) openFly(e.currentTarget);
        }}
      >
        <shown.icon size={17} strokeWidth={1.75} />
      </button>
      {fly &&
        createPortal(
          <div className="tool-fly" style={{ left: fly.x, top: fly.y }}>
            {group.map((t) => (
              <button
                key={t.id}
                className={`tool-fly-item ${t.id === tool ? 'on' : ''}`}
                onClick={() => {
                  setTool(t.id);
                  useLast.setState({ [group[0].id]: t.id });
                  setFly(null);
                }}
              >
                <t.icon size={15} strokeWidth={1.75} />
                <span>{t.label}</span>
                <span className="ctx-key">{t.key}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Toolbox() {
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  return (
    <div className="toolbox">
      {SECTIONS.map((sec, i) => (
        <div key={i} style={{ display: 'contents' }}>
          {i > 0 && <div className="tool-sep" />}
          {sec.map((g) => (
            <ToolGroup key={g[0].id} group={g} />
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
