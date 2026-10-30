import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { deletePattern, usePatterns } from '../core/patterns';

/** Сетка миниатюр узоров; выбранный подсвечен. Свои узоры можно удалить. */
export function PatternPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const list = usePatterns((s) => s.list);
  return (
    <div className="pattern-grid">
      {list.map((p) => (
        <div key={p.id} className={`pattern-cell ${p.id === value ? 'on' : ''}`} title={`${p.name} — ${p.w}×${p.h}`} onClick={() => onChange(p.id)}>
          <div style={{ backgroundImage: `url(${p.url})`, backgroundSize: p.w > 48 ? 'contain' : 'auto', imageRendering: 'pixelated' }} />
          {!p.builtin && (
            <span
              className="del"
              title="Удалить узор"
              onClick={(e) => {
                e.stopPropagation();
                deletePattern(p.id);
              }}
            >
              <X size={9} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Компактная кнопка с текущим узором и выпадающей сеткой — для панели опций. */
export function PatternButton({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const list = usePatterns((s) => s.list);
  const ref = useRef<HTMLSpanElement>(null);
  const cur = list.find((p) => p.id === value) ?? list[0];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <span className="pattern-cell small" title={cur?.name} onClick={() => setOpen(!open)}>
        <div style={{ backgroundImage: cur ? `url(${cur.url})` : undefined }} />
      </span>
      {open && (
        <div className="pattern-pop">
          <PatternPicker
            value={value}
            onChange={(id) => {
              onChange(id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </span>
  );
}
