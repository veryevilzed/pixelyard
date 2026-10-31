import { useState } from 'react';
import { BLEND_MODES, LABEL_COLORS, type BlendMode, type LabelColor } from '../core/types';
import { activeDoc, closeDialog, openDialog } from '../store';
import { changed } from '../tools/base';
import { Check, SliderField } from './controls';
import { Modal } from './Dialogs';

/**
 * Свойства слоя (правый клик по слою → «Свойства слоя…»): имя, режим наложения, непрозрачность
 * слоя и заливки, метка, видимость и блокировка. Видно сразу на холсте; «Отмена» возвращает как было,
 * «OK» — одна запись истории.
 */
export function LayerPropsDialog({ layerId }: { layerId: string }) {
  const doc = activeDoc()!;
  const layer = doc.getLayer(layerId)!;
  const [orig] = useState(() => ({ ...layer }));
  const [name, setName] = useState(layer.name);
  const [blend, setBlend] = useState<BlendMode>(layer.blend);
  const [opacity, setOpacity] = useState(Math.round(layer.opacity * 100));
  const [fill, setFill] = useState(Math.round(layer.fillOpacity * 100));
  const [color, setColor] = useState<LabelColor | null>(layer.color ?? null);
  const [visible, setVisible] = useState(layer.visible);
  const [locked, setLocked] = useState(layer.locked);

  /** Живой просмотр: свойства подставляются в слой без записи в историю. */
  const live = (patch: Partial<typeof orig>) => {
    doc.layers = doc.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l));
    changed();
  };
  const restore = () => live({ name: orig.name, blend: orig.blend, opacity: orig.opacity, fillOpacity: orig.fillOpacity, color: orig.color, visible: orig.visible, locked: orig.locked });

  const cancel = () => {
    restore();
    closeDialog();
  };
  const ok = () => {
    restore();
    const patch = { name: name.trim() || orig.name, blend, opacity: opacity / 100, fillOpacity: fill / 100, color, visible, locked };
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every((k) => patch[k] === (orig[k] ?? null) || (k === 'color' && !patch.color && !orig.color));
    if (!same) doc.updateLayer(layerId, patch, 'Свойства слоя');
    changed();
    closeDialog();
  };

  return (
    <Modal
      seeThrough
      title="Свойства слоя"
      onClose={cancel}
      width={400}
      footer={
        <>
          <button
            className="btn left"
            onClick={() => {
              ok();
              openDialog({ kind: 'layer-style' });
            }}
          >
            Стиль слоя…
          </button>
          <button className="btn" onClick={cancel}>Отмена</button>
          <button className="btn primary" onClick={ok}>OK</button>
        </>
      }
    >
      <div className="layer-props">
        <label className="row-fields">
          <span className="label static">Имя</span>
          <input
            autoFocus
            value={name}
            style={{ flex: 1 }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') ok();
              if (e.key === 'Escape') cancel();
            }}
          />
        </label>
        <label className="row-fields">
          <span className="label static">Наложение</span>
          <select
            value={blend}
            style={{ flex: 1 }}
            onChange={(e) => {
              const b = e.target.value as BlendMode;
              setBlend(b);
              live({ blend: b });
            }}
          >
            {BLEND_MODES.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </label>
        <SliderField label="Непрозрачность" value={opacity} min={0} max={100} suffix="%" onChange={(v) => (setOpacity(Math.round(v)), live({ opacity: Math.round(v) / 100 }))} />
        <SliderField label="Заливка" value={fill} min={0} max={100} suffix="%" onChange={(v) => (setFill(Math.round(v)), live({ fillOpacity: Math.round(v) / 100 }))} />
        <div className="row-fields">
          <span className="label static">Метка</span>
          <div className="ctx-colors" style={{ border: 'none', margin: 0, padding: 0 }}>
            <button className={`label-swatch none ${color === null ? 'on' : ''}`} title="Без цвета" onClick={() => (setColor(null), live({ color: null }))} />
            {LABEL_COLORS.map((c) => (
              <button key={c.id} className={`label-swatch ${color === c.id ? 'on' : ''}`} style={{ background: c.css }} title={c.label} onClick={() => (setColor(c.id), live({ color: c.id }))} />
            ))}
          </div>
        </div>
        <div className="row-fields checks">
          <Check label="Видимый" checked={visible} onChange={(v) => (setVisible(v), live({ visible: v }))} />
          <Check label="Заблокирован" checked={locked} onChange={(v) => (setLocked(v), live({ locked: v }))} />
        </div>
        <div className="note">
          {doc.width} × {doc.height} px · {layer.text ? 'текстовый слой' : layer.mask ? 'с маской' : 'растровый слой'}
          {layer.clip ? ' · обтравочная маска' : ''}
        </div>
      </div>
    </Modal>
  );
}
