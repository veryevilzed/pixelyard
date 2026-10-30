import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatShortcut, MENUS, type MenuEntry } from '../menu';
import { useApp } from '../store';
import { APP_NAME, APP_VERSION, BUILD_COMMIT, BUILD_DATE } from '../version';

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useApp((s) => s.tick); // пересчитать enabled/checked
  useApp((s) => s.prefs);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu-pop, .menu-btn')) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const show = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 2 });
    setOpen(i);
  };

  return (
    <div className="menubar" ref={barRef}>
      <span className="brand" title={`Сборка ${BUILD_COMMIT} от ${BUILD_DATE}`}>
        {APP_NAME} <span className="ver">{APP_VERSION}</span>
      </span>
      {MENUS.map((m, i) => (
        <span
          key={m.label}
          className={`menu-btn ${open === i ? 'open' : ''}`}
          onMouseDown={(e) => (open === i ? setOpen(null) : show(i, e.currentTarget))}
          onMouseEnter={(e) => open !== null && open !== i && show(i, e.currentTarget)}
        >
          {m.label}
        </span>
      ))}
      {open !== null && <MenuPopup items={MENUS[open].items} x={pos.x} y={pos.y} onDone={() => setOpen(null)} />}
    </div>
  );
}

function MenuPopup({ items, x, y, onDone }: { items: MenuEntry[]; x: number; y: number; onDone: () => void }) {
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useEffect(() => {
    // не даём меню уйти за край окна
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setShift({ x: Math.min(0, window.innerWidth - r.right - 4), y: Math.min(0, window.innerHeight - r.bottom - 4) });
  }, [x, y]);
  return (
    <div className="menu-pop" ref={ref} style={{ left: x + shift.x, top: y + shift.y }}>
      {items.map((it, i) => {
        if (it === 'sep') return <div key={i} className="menu-sep" />;
        if ('submenu' in it)
          return (
            <div
              key={i}
              className="menu-item"
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ i, x: r.right + 2, y: r.top - 4 });
              }}
            >
              {it.label}
              <span className="sc">
                <ChevronRight size={12} />
              </span>
              {sub?.i === i && <MenuPopup items={it.submenu} x={sub.x} y={sub.y} onDone={onDone} />}
            </div>
          );
        const enabled = it.enabled ? it.enabled() : true;
        return (
          <div
            key={i}
            className={`menu-item ${enabled ? '' : 'disabled'}`}
            onMouseEnter={() => setSub(null)}
            onMouseUp={() => {
              if (!enabled) return;
              onDone();
              it.action();
            }}
          >
            {it.checked?.() && (
              <span className="check">
                <Check size={12} />
              </span>
            )}
            {it.label}
            {it.shortcut && <span className="sc">{formatShortcut(it.shortcut)}</span>}
          </div>
        );
      })}
    </div>
  );
}
