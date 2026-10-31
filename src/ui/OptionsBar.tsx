import { Circle, Minus, MoveUpRight, Square } from 'lucide-react';
import * as A from '../actions';
import { activeDoc, openDialog, setFg, setOpts, setPrefs, useApp, type ToolOptions } from '../store';
import { applyTextOptsToLayer } from '../tools/fill';
import { stampSource } from '../tools/paint';
import { Check, ColorField, NumberField, Seg, SliderField } from './controls';
import { TOOL_LABELS } from './Toolbox';
import { PatternButton } from './PatternPicker';
import { cancelTransform, commitTransform, quadAngle, quadSize, resetTransform, rotateQuad, scaleQuad, setQuad, translateQuad, TRANSFORM_MODES, useTransform } from '../tools/transform';
import { quadCenter } from '../core/warp';
import { applyCrop, useCrop } from '../tools/crop';
import { changed } from '../tools/base';
import { useFonts } from '../core/fontLibrary';
import { isAtlas, updateAtlas } from '../core/atlasDoc';
import { atlasFormat, type AtlasSettings } from '../core/atlas';
import { ALGORITHMS, HEURISTICS, SORTS } from '../core/pack';
import type { Doc } from '../core/doc';

/** Параметры упаковки атласа (в истории, одна запись на серию изменений одного поля). */
function AtlasOptions({ doc }: { doc: Doc }) {
  const o = doc.atlas!.settings;
  const set = (patch: Partial<AtlasSettings>) => {
    const label = 'Настройки упаковки';
    const last = doc.undoStack[doc.undoStack.length - 1];
    if (last?.label === label && last.after?.atlas === doc.atlas && Object.keys(patch).every((k) => typeof patch[k as keyof AtlasSettings] === 'number')) doc.undo();
    updateAtlas(doc, label, (a) => ({ ...a, settings: { ...a.settings, ...patch } }));
    changed();
  };
  const noRot = atlasFormat(doc.atlas!).rotation === false;
  return (
    <div className="optionsbar">
      <span className="tool-name">Атлас</span>
      <select value={o.algorithm} onChange={(e) => set({ algorithm: e.target.value as AtlasSettings['algorithm'] })} title="Алгоритм расстановки">
        {ALGORITHMS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
      </select>
      {o.algorithm === 'maxrects' && (
        <select value={o.heuristic} onChange={(e) => set({ heuristic: e.target.value as AtlasSettings['heuristic'] })} title="Эвристика MaxRects">
          {HEURISTICS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
        </select>
      )}
      {o.algorithm !== 'best' && (
        <select value={o.sort} onChange={(e) => set({ sort: e.target.value as AtlasSettings['sort'] })} title="Порядок спрайтов (по алфавиту + полки = алфавитная раскладка)">
          {SORTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
        </select>
      )}
      <Check label="Вращение" checked={o.allowRotation && !noRot} onChange={(v) => set({ allowRotation: v })} title={noRot ? 'Выбранный формат не поддерживает повёрнутые кадры' : 'Поворачивать спрайты на 90° для плотной упаковки'} />
      <span className="divider" />
      <span className="field">
        <span className="label static">Макс.</span>
        <select value={o.maxSize} onChange={(e) => set({ maxSize: Number(e.target.value) })}>
          {[256, 512, 1024, 2048, 4096, 8192].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </span>
      <Check label="Степень 2" checked={o.pot} onChange={(v) => set({ pot: v })} />
      <Check label="Квадрат" checked={o.square} onChange={(v) => set({ square: v })} />
      <Check label="Несколько страниц" checked={o.multipage} onChange={(v) => set({ multipage: v })} title="Если не помещается в максимальный размер — следующая текстура" />
      <span className="divider" />
      <NumberField label="Зазор" value={o.spacing} min={0} max={64} width={34} onChange={(v) => set({ spacing: Math.round(v) })} suffix="px" />
      <NumberField label="Отступ" value={o.border} min={0} max={64} width={34} onChange={(v) => set({ border: Math.round(v) })} suffix="px" />
      <NumberField label="Extrude" value={o.extrude} min={0} max={16} width={30} onChange={(v) => set({ extrude: Math.round(v) })} suffix="px" />
      <Check label="Обрезать прозрачное" checked={o.trim} onChange={(v) => set({ trim: v })} />
      <Check label="Путь в имени" checked={o.includeFolder} onChange={(v) => set({ includeFolder: v })} title="Имя кадра с папкой: ui/button" />
    </div>
  );
}

const FONTS = [
  { id: '-apple-system, Helvetica, Arial, sans-serif', label: 'Системный' },
  { id: 'Helvetica Neue, Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { id: 'Georgia, serif', label: 'Georgia' },
  { id: 'Times New Roman, serif', label: 'Times' },
  { id: 'Menlo, Monaco, monospace', label: 'Menlo' },
  { id: 'Courier New, monospace', label: 'Courier' },
  { id: 'Impact, sans-serif', label: 'Impact' },
  { id: 'Arial Black, sans-serif', label: 'Arial Black' },
];

function SelectModeSeg({ o }: { o: ToolOptions }) {
  return (
    <Seg
      value={o.selectMode}
      onChange={(v) => setOpts({ selectMode: v })}
      options={[
        { id: 'replace', label: 'Новое', title: 'Новое выделение' },
        { id: 'add', label: '+', title: 'Добавить (Shift)' },
        { id: 'subtract', label: '−', title: 'Вычесть (⌥ или Ctrl)' },
        { id: 'intersect', label: '∩', title: 'Пересечение (⇧ + ⌥ или Ctrl)' },
      ]}
    />
  );
}

/** Настройка «Текста» + применение к выбранному текстовому слою. */
const setTextOpts = (patch: Partial<ToolOptions>) => {
  setOpts(patch);
  applyTextOptsToLayer(activeDoc());
};

export function OptionsBar() {
  const tool = useApp((s) => s.tool);
  const o = useApp((s) => s.opts);
  const prefs = useApp((s) => s.prefs);
  const transform = useTransform();
  const crop = useCrop((s) => s.rect);
  const bmFonts = useFonts((s) => s.fonts);
  const fg = useApp((s) => s.fg);
  useApp((s) => s.tick);

  if (transform.active) {
    const q = transform.quad;
    const c = quadCenter(q);
    const { w, h } = quadSize(q);
    const ang = (quadAngle(q) * 180) / Math.PI;
    return (
      <div className="optionsbar">
        <span className="tool-name">Трансформация</span>
        <Seg value={transform.mode} onChange={(mode) => useTransform.setState({ mode })} options={TRANSFORM_MODES.map((m) => ({ id: m.id, label: m.label }))} />
        <span className="divider" />
        <NumberField label="X" value={Math.round(c.x)} onChange={(v) => setQuad(translateQuad(q, { x: v - c.x, y: 0 }))} />
        <NumberField label="Y" value={Math.round(c.y)} onChange={(v) => setQuad(translateQuad(q, { x: 0, y: v - c.y }))} />
        <NumberField label="Ш" value={Math.round(w)} min={1} onChange={(v) => setQuad(scaleQuad(q, c, v / Math.max(1, w), 1))} suffix="px" />
        <NumberField label="В" value={Math.round(h)} min={1} onChange={(v) => setQuad(scaleQuad(q, c, 1, v / Math.max(1, h)))} suffix="px" />
        <NumberField label="∠" value={Math.round(ang * 10) / 10} step={0.1} onChange={(v) => setQuad(rotateQuad(q, c, ((v - ang) * Math.PI) / 180))} suffix="°" />
        <button className="btn" title="Отразить по горизонтали" onClick={() => setQuad(scaleQuad(q, c, -1, 1))}>↔</button>
        <button className="btn" title="Отразить по вертикали" onClick={() => setQuad(scaleQuad(q, c, 1, -1))}>↕</button>
        <button className="btn" title="Повернуть на 90° по часовой" onClick={() => setQuad(rotateQuad(q, c, Math.PI / 2))}>⟳90°</button>
        <button className="btn" title="Повернуть на 180°" onClick={() => setQuad(rotateQuad(q, c, Math.PI))}>180°</button>
        <button className="btn" title="Вернуть исходную рамку" onClick={resetTransform}>Сброс</button>
        <Check label="Сглаживание" checked={transform.smooth} onChange={(v) => { useTransform.setState({ smooth: v }); changed(); }} title="Выключите для пиксель-арта" />
        <span className="note">⌘ — искажение угла / наклон стороны, ⌘⌥⇧ — перспектива, ⇧ — пропорции, ⌥ — от центра</span>
        <span className="divider" />
        <button className="btn" onClick={cancelTransform}>Отмена (Esc)</button>
        <button className="btn primary" onClick={commitTransform}>Применить (Enter)</button>
      </div>
    );
  }

  const ad = activeDoc();
  if (isAtlas(ad) && tool !== 'hand' && tool !== 'zoom') return <AtlasOptions doc={ad} />;

  const label = TOOL_LABELS[tool];
  let body: React.ReactNode = null;
  const bmActive = o.textFont.startsWith('bmfont:') && bmFonts.some((f) => `bmfont:${f.id}` === o.textFont);

  switch (tool) {
    case 'brush':
      body = (
        <>
          <SliderField label="Размер" value={o.brushSize} min={1} max={500} onChange={(v) => setOpts({ brushSize: v })} suffix="px" />
          <SliderField label="Жёсткость" value={o.brushHardness} min={0} max={100} onChange={(v) => setOpts({ brushHardness: v })} suffix="%" />
          <SliderField label="Непрозр." value={o.brushOpacity} min={1} max={100} onChange={(v) => setOpts({ brushOpacity: v })} suffix="%" />
          <NumberField label="Интервал" value={o.brushSpacing} min={1} max={200} onChange={(v) => setOpts({ brushSpacing: v })} suffix="%" />
          <Check label="Сглаживание" checked={o.brushAntialias} onChange={(v) => setOpts({ brushAntialias: v })} title="Выключите для жёстких пиксельных краёв" />
          <Check label="Нажим пера" checked={o.pressure} onChange={(v) => setOpts({ pressure: v })} />
          <span className="note">Alt — пипетка, Shift+клик — прямая, [ ] — размер</span>
        </>
      );
      break;
    case 'pencil':
      body = (
        <>
          <NumberField label="Размер" value={o.pencilSize} min={1} max={256} onChange={(v) => setOpts({ pencilSize: Math.round(v) })} suffix="px" />
          <Seg value={o.pencilShape} onChange={(v) => setOpts({ pencilShape: v })} options={[{ id: 'square', label: <Square size={12} />, title: 'Квадратный' }, { id: 'round', label: <Circle size={12} />, title: 'Круглый' }]} />
          <SliderField label="Непрозр." value={o.brushOpacity} min={1} max={100} onChange={(v) => setOpts({ brushOpacity: v })} suffix="%" />
          <Check label="Pixel perfect" checked={o.pixelPerfect} onChange={(v) => setOpts({ pixelPerfect: v })} title="Убирает лишние «уголки» у линий толщиной 1px" />
          <Check label="Пиксельная сетка" checked={prefs.pixelGrid} onChange={(v) => setPrefs({ pixelGrid: v })} />
          <span className="note">Рисует без сглаживания, точно по пикселям. Alt — пипетка</span>
        </>
      );
      break;
    case 'eraser':
      body = (
        <>
          <Seg value={o.eraserMode} onChange={(v) => setOpts({ eraserMode: v })} options={[{ id: 'brush', label: 'Мягкий, сглаженный' }, { id: 'pencil', label: 'Жёсткий, попиксельно' }]} />
          <SliderField label="Размер" value={o.eraserSize} min={1} max={500} onChange={(v) => setOpts({ eraserSize: v })} suffix="px" />
          {o.eraserMode === 'brush' && <SliderField label="Жёсткость" value={o.eraserHardness} min={0} max={100} onChange={(v) => setOpts({ eraserHardness: v })} suffix="%" />}
          <SliderField label="Непрозр." value={o.eraserOpacity} min={1} max={100} onChange={(v) => setOpts({ eraserOpacity: v })} suffix="%" />
        </>
      );
      break;
    case 'fill':
      body = (
        <>
          <Seg value={o.fillMode} onChange={(v) => setOpts({ fillMode: v })} options={[{ id: 'color', label: 'Залить' }, { id: 'erase', label: 'Стереть область' }]} />
          {o.fillMode === 'color' && (
            <>
              <Seg value={o.fillSource} onChange={(v) => setOpts({ fillSource: v })} options={[{ id: 'color', label: 'Основной цвет' }, { id: 'pattern', label: 'Узор' }]} />
              {o.fillSource === 'pattern' && <PatternButton value={o.fillPattern} onChange={(id) => setOpts({ fillPattern: id })} />}
            </>
          )}
          <SliderField label="Допуск" value={o.fillTolerance} min={0} max={255} onChange={(v) => setOpts({ fillTolerance: v })} />
          <Check label="Смежные пиксели" checked={o.fillContiguous} onChange={(v) => setOpts({ fillContiguous: v })} />
          <Check label="По всем слоям" checked={o.fillSampleMerged} onChange={(v) => setOpts({ fillSampleMerged: v })} />
          <SliderField label="Непрозр." value={o.brushOpacity} min={1} max={100} onChange={(v) => setOpts({ brushOpacity: v })} suffix="%" />
        </>
      );
      break;
    case 'gradient':
      body = (
        <>
          <Seg value={o.gradientKind} onChange={(v) => setOpts({ gradientKind: v })} options={[{ id: 'linear', label: 'Линейный' }, { id: 'radial', label: 'Радиальный' }]} />
          <Check label="Основной → прозрачный" checked={o.gradientToTransparent} onChange={(v) => setOpts({ gradientToTransparent: v })} />
          <Check label="Инверсия" checked={o.gradientReverse} onChange={(v) => setOpts({ gradientReverse: v })} />
          <SliderField label="Непрозр." value={o.brushOpacity} min={1} max={100} onChange={(v) => setOpts({ brushOpacity: v })} suffix="%" />
        </>
      );
      break;
    case 'marquee-rect':
    case 'marquee-ellipse':
      body = (
        <>
          <SelectModeSeg o={o} />
          <NumberField label="Растушевка" value={o.feather} min={0} max={250} onChange={(v) => setOpts({ feather: v })} suffix="px" />
          <Check label="Сглаживание" checked={o.selectAntialias} onChange={(v) => setOpts({ selectAntialias: v })} />
          <span className="divider" />
          <span className="label">Стиль</span>
          <select value={o.selectFixed} onChange={(e) => setOpts({ selectFixed: e.target.value as ToolOptions['selectFixed'] })}>
            <option value="none">Обычный</option>
            <option value="ratio">Пропорции</option>
            <option value="size">Заданный размер</option>
          </select>
          {o.selectFixed !== 'none' && (
            <>
              <NumberField label="Ш" value={o.selectFixedW} min={1} onChange={(v) => setOpts({ selectFixedW: v })} />
              <NumberField label="В" value={o.selectFixedH} min={1} onChange={(v) => setOpts({ selectFixedH: v })} />
            </>
          )}
        </>
      );
      break;
    case 'lasso':
    case 'polygon-lasso':
      body = (
        <>
          <SelectModeSeg o={o} />
          <NumberField label="Растушевка" value={o.feather} min={0} max={250} onChange={(v) => setOpts({ feather: v })} suffix="px" />
          <Check label="Сглаживание" checked={o.selectAntialias} onChange={(v) => setOpts({ selectAntialias: v })} />
          {tool === 'polygon-lasso' && <span className="note">Клик — точка, двойной клик/Enter — замкнуть, ⌫ — убрать точку</span>}
        </>
      );
      break;
    case 'wand':
      body = (
        <>
          <SelectModeSeg o={o} />
          <SliderField label="Допуск" value={o.wandTolerance} min={0} max={255} onChange={(v) => setOpts({ wandTolerance: v })} />
          <Check label="Смежные пиксели" checked={o.wandContiguous} onChange={(v) => setOpts({ wandContiguous: v })} />
          <Check label="По всем слоям" checked={o.wandSampleMerged} onChange={(v) => setOpts({ wandSampleMerged: v })} title="Выкл. — только активный слой" />
          <Check label="Сглаживание" checked={o.selectAntialias} onChange={(v) => setOpts({ selectAntialias: v })} title="Мягкий край выделения в 1 px" />
          <span className="note">Зажмите и ведите мышь вправо/влево — допуск больше/меньше. ⇧ — добавить, ⌥/Ctrl — вычесть</span>
        </>
      );
      break;
    case 'move':
      body = (
        <>
          <Check label="Автовыбор слоя" checked={o.moveAutoSelect} onChange={(v) => setOpts({ moveAutoSelect: v })} />
          <span className="note">⌘+клик — выбрать слой, Alt — перетащить копию, Shift — по оси, стрелки — сдвиг на 1px (⇧ 10px), ⌘T — трансформация</span>
        </>
      );
      break;
    case 'crop': {
      const doc = activeDoc();
      body = crop ? (
        <>
          <span>
            {Math.round(crop.x)}, {Math.round(crop.y)} — {Math.round(crop.w)} × {Math.round(crop.h)}
          </span>
          <button className="btn" onClick={() => useCrop.setState({ rect: null })}>Отмена (Esc)</button>
          <button className="btn primary" onClick={() => doc && applyCrop(doc, crop)}>Кадрировать (Enter)</button>
        </>
      ) : (
        <span className="note">Протяните рамку. Рамка за пределами холста расширяет холст. Shift — квадрат</span>
      );
      break;
    }
    case 'knife':
      body = (
        <>
          <Seg value={o.knifeDir} onChange={(v) => setOpts({ knifeDir: v })} options={[{ id: 'vertical', label: '│ Вертикально' }, { id: 'horizontal', label: '─ Горизонтально' }]} />
          <span className="note">Клик — рез (⇧ — другое направление), тяните линию, ⌥+клик — удалить</span>
          <button className="btn" onClick={() => openDialog({ kind: 'cut-step' })}>С шагом…</button>
          <button className="btn" title="Поставить резы по направляющим" onClick={A.guidesToCuts}>По направляющим</button>
          <span className="divider" />
          <button className="btn" onClick={A.cutsToLayers}>Куски → слои</button>
          <button className="btn" onClick={A.cutsToSlices}>Куски → слайсы</button>
          <button className="btn primary" onClick={A.exportPieces}>Сохранить куски в файлы…</button>
          <button className="btn" onClick={A.clearCuts}>Очистить</button>
        </>
      );
      break;
    case 'slice':
      body = (
        <>
          <span className="note">Протяните, чтобы создать слайс. Клик — выбрать, перетаскивание — переместить, Delete — удалить, Alt — новый поверх существующего</span>
          <Check label="Привязка к сетке" checked={prefs.snap} onChange={(v) => setPrefs({ snap: v })} />
          <Check label="Сетка" checked={prefs.grid} onChange={(v) => setPrefs({ grid: v })} />
          {prefs.grid && (
            <>
              <NumberField label="Ш" value={prefs.gridW} min={1} onChange={(v) => setPrefs({ gridW: v })} />
              <NumberField label="В" value={prefs.gridH} min={1} onChange={(v) => setPrefs({ gridH: v })} />
            </>
          )}
        </>
      );
      break;
    case 'eyedropper':
      body = (
        <>
          <Check label="По всем слоям" checked={o.eyedropperMerged} onChange={(v) => setOpts({ eyedropperMerged: v })} />
          <span className="note">Клик — основной цвет, Alt+клик — фоновый</span>
        </>
      );
      break;
    case 'shape':
      body = (
        <>
          <Seg
            value={o.shapeKind}
            onChange={(v) => setOpts({ shapeKind: v })}
            options={[
              { id: 'rect', label: <Square size={12} />, title: 'Прямоугольник' },
              { id: 'ellipse', label: <Circle size={12} />, title: 'Эллипс' },
              { id: 'line', label: <Minus size={12} />, title: 'Линия' },
              { id: 'arrow', label: <MoveUpRight size={12} />, title: 'Стрелка (изгибается)' },
            ]}
          />
          {o.shapeKind === 'arrow' && (
            <>
              <Seg value={o.arrowHeads} onChange={(v) => setOpts({ arrowHeads: v })} options={[{ id: 'end', label: '→', title: 'Наконечник в конце' }, { id: 'both', label: '↔', title: 'С обоих концов' }]} />
              <NumberField label="Наконечник" value={o.arrowHeadSize} min={1.5} max={12} step={0.5} width={40} onChange={(v) => setOpts({ arrowHeadSize: v })} suffix="×" title="Длина наконечника в толщинах линии" />
            </>
          )}
          {o.shapeKind !== 'line' && o.shapeKind !== 'arrow' && <Check label="Заливка" checked={o.shapeFill} onChange={(v) => setOpts({ shapeFill: v })} />}
          {o.shapeKind !== 'line' && o.shapeKind !== 'arrow' && <Check label="Обводка" checked={o.shapeStroke} onChange={(v) => setOpts({ shapeStroke: v })} title="При заливке обводка рисуется фоновым цветом" />}
          <NumberField label="Толщина" value={o.shapeStrokeWidth} min={1} max={200} onChange={(v) => setOpts({ shapeStrokeWidth: v })} suffix="px" />
          {o.shapeKind === 'rect' && <NumberField label="Радиус" value={o.shapeRadius} min={0} max={500} onChange={(v) => setOpts({ shapeRadius: v })} suffix="px" />}
          <Check label="Сглаживание" checked={o.shapeAntialias} onChange={(v) => setOpts({ shapeAntialias: v })} />
          <Check label="Новым слоем" checked={o.shapeNewLayer} onChange={(v) => setOpts({ shapeNewLayer: v })} />
        </>
      );
      break;
    case 'text':
      body = (
        <>
          <select value={o.textFont} onChange={(e) => setTextOpts({ textFont: e.target.value })}>
            <optgroup label="Системные">
              {FONTS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </optgroup>
            {bmFonts.length > 0 && (
              <optgroup label="Растровые (BMFont)">
                {bmFonts.map((f) => (
                  <option key={f.id} value={`bmfont:${f.id}`}>{f.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {bmFonts.length === 0 && <button className="btn small" title="Создать растровый шрифт — он появится в этом списке" onClick={() => openDialog({ kind: 'bmfont' })}>+ BMFont</button>}
          <ColorField value={fg} onChange={(c) => (setFg(c), applyTextOptsToLayer(activeDoc()))} />
          <NumberField label="Кегль" value={o.textSize} min={4} max={1000} onChange={(v) => setTextOpts({ textSize: v })} suffix="px" />
          {bmActive ? (
            <Check label="Перекрасить в основной цвет" checked={o.textBmTint} onChange={(v) => setTextOpts({ textBmTint: v })} title="Для одноцветных (например, белых) растровых шрифтов" />
          ) : (
            <>
              <Check label={<b>Ж</b>} checked={o.textBold} onChange={(v) => setTextOpts({ textBold: v })} />
              <Check label={<i>К</i>} checked={o.textItalic} onChange={(v) => setTextOpts({ textItalic: v })} />
            </>
          )}
          <Check label="Сглаживание" checked={o.textAntialias} onChange={(v) => setTextOpts({ textAntialias: v })} />
          <span className="note">Клик — новый текст, клик по тексту — править, ⌘Enter или клик снаружи — готово, Esc — отмена</span>
        </>
      );
      break;
    case 'stamp': {
      const src = stampSource();
      body = (
        <>
          <SliderField label="Размер" value={o.stampSize} min={1} max={500} onChange={(v) => setOpts({ stampSize: v })} suffix="px" />
          <SliderField label="Жёсткость" value={o.stampHardness} min={0} max={100} onChange={(v) => setOpts({ stampHardness: v })} suffix="%" />
          <SliderField label="Непрозр." value={o.stampOpacity} min={1} max={100} onChange={(v) => setOpts({ stampOpacity: v })} suffix="%" />
          <Check label="Выравнивание" checked={o.stampAligned} onChange={(v) => setOpts({ stampAligned: v })} title="Вкл. — смещение источника сохраняется между мазками; выкл. — каждый мазок начинается с точки источника" />
          <span className="field">
            <span className="label static">Брать из</span>
            <select value={o.stampSample} onChange={(e) => setOpts({ stampSample: e.target.value as 'layer' | 'all' })}>
              <option value="layer">слоя источника</option>
              <option value="all">всех слоёв</option>
            </select>
          </span>
          <span className="note">{src ? `Источник: ${Math.round(src.x)}, ${Math.round(src.y)} — ⌥+клик задать заново` : '⌥+клик — задать источник (на нужном слое), затем рисуйте на целевом слое'}</span>
        </>
      );
      break;
    }
    case 'hand':
      body = <span className="note">Перетаскивайте холст. Пробел — временная рука в любом инструменте, колёсико/трекпад — прокрутка, ⌘/pinch — масштаб</span>;
      break;
    case 'zoom':
      body = <span className="note">Клик — увеличить, Alt+клик — уменьшить, ⌘0 — целиком, ⌘1 — 100%</span>;
      break;
  }

  const selTools = ['marquee-rect', 'marquee-ellipse', 'lasso', 'polygon-lasso', 'wand'];
  const hasSel = !!activeDoc()?.selection;
  return (
    <div className="optionsbar">
      <span className="tool-name">{label}</span>
      {body}
      {selTools.includes(tool) && (
        <>
          <span className="divider" />
          <button className="btn" title="Выделить по цвету (⌥⌘O)" onClick={() => activeDoc() && openDialog({ kind: 'color-range' })}>По цвету…</button>
          {hasSel && (
            <>
              <button className="btn" title="Кадрировать по выделению (⌥⌘X)" onClick={A.cropToSelection}>Кадрировать</button>
              <button className="btn" title="Выделенное в новый документ (⌥⌘N)" onClick={() => A.selectionToNewDoc(false)}>В новый документ</button>
              <button className="btn" title="Новый слой из выделенного (⌘J)" onClick={() => A.layerVia(false)}>На новый слой</button>
              <button className="btn" title="Маска слоя из выделения" onClick={() => A.addMask('selection')}>В маску</button>
            </>
          )}
        </>
      )}
    </div>
  );
}
