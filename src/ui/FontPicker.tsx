import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFonts } from '../core/fontLibrary';
import { systemFonts } from '../core/platform';

/**
 * Выбор шрифта «Текста»: каждый шрифт показан своим начертанием, сверху — недавние,
 * затем растровые (BMFont) и все шрифты системы; поиск по имени.
 * Значение — CSS-семейство (`"Avenir Next", sans-serif`) или «bmfont:<id>».
 */

export const SYSTEM_FONT = '-apple-system, Helvetica, Arial, sans-serif';
const RECENT_KEY = 'pixelyard.recentFonts';
const RECENT_MAX = 8;

/** CSS-значение для семейства системы. */
export const familyCss = (name: string) => `"${name}", sans-serif`;

/** Имя шрифта для показа: первое семейство без кавычек. */
export function fontLabel(id: string, bm: { id: string; name: string }[] = useFonts.getState().fonts) {
  if (id.startsWith('bmfont:')) return bm.find((f) => `bmfont:${f.id}` === id)?.name ?? 'Растровый шрифт';
  if (id === SYSTEM_FONT || id.startsWith('-apple-system')) return 'Системный (SF)';
  return id.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Запомнить шрифт в «Недавних». */
export function rememberFont(id: string) {
  const list = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

const SAMPLE = 'Аа Бб Ag 123';

export function FontPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const bm = useFonts((s) => s.fonts);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (open && !all.length) void systemFonts().then(setAll);
  }, [open, all.length]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.min(r.left, window.innerWidth - 340), top: r.bottom + 4 });
    // поиск в фокусе сразу — можно печатать имя
    search.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  // текущий шрифт виден в списке
  useEffect(() => {
    if (open) setTimeout(() => pop.current?.querySelector('.font-row.on')?.scrollIntoView({ block: 'nearest' }), 0);
  }, [open, all.length]);

  const sections = useMemo(() => {
    const f = q.trim().toLowerCase();
    const match = (label: string) => !f || label.toLowerCase().includes(f);
    const bmIds = bm.map((x) => ({ id: `bmfont:${x.id}`, label: x.name, bitmap: true }));
    const sys = [{ id: SYSTEM_FONT, label: 'Системный (SF)', bitmap: false }, ...all.map((n) => ({ id: familyCss(n), label: n, bitmap: false }))];
    const known = new Map([...bmIds, ...sys].map((x) => [x.id, x]));
    const recent = loadRecent()
      .map((id) => known.get(id) ?? (id.startsWith('bmfont:') ? null : { id, label: fontLabel(id, bm), bitmap: false }))
      .filter((x): x is { id: string; label: string; bitmap: boolean } => !!x);
    return [
      { title: 'Недавние', items: recent.filter((x) => match(x.label)) },
      { title: 'Растровые (BMFont)', items: bmIds.filter((x) => match(x.label)) },
      { title: all.length ? `Все шрифты (${all.length})` : 'Шрифты…', items: sys.filter((x) => match(x.label)) },
    ].filter((s) => s.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, all, bm, open]);

  const choose = (id: string) => {
    rememberFont(id);
    setOpen(false);
    setQ('');
    onChange(id);
  };

  const flat = sections.flatMap((s) => s.items);
  const label = fontLabel(value, bm);
  return (
    <>
      <button
        ref={btn}
        className="font-picker"
        title="Шрифт"
        style={{ fontFamily: value.startsWith('bmfont:') ? undefined : value }}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <ChevronDown size={11} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="font-picker-pop" style={pos}>
            <input
              ref={search}
              className="font-search"
              placeholder="Поиск шрифта…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && flat[0]) choose(flat[0].id);
              }}
            />
            <div className="font-list">
              {sections.map((s) => (
                <div key={s.title}>
                  <div className="font-section">{s.title}</div>
                  {s.items.map((f) => (
                    <div key={s.title + f.id} className={`font-row ${f.id === value ? 'on' : ''}`} onClick={() => choose(f.id)}>
                      <span className="font-name" style={{ fontFamily: f.bitmap ? undefined : f.id }}>{f.label}</span>
                      {!f.bitmap ? <span className="font-sample" style={{ fontFamily: f.id }}>{SAMPLE}</span> : <span className="font-sample note">BMFont</span>}
                    </div>
                  ))}
                </div>
              ))}
              {!flat.length && <div className="note" style={{ padding: 10 }}>Ничего не найдено</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
