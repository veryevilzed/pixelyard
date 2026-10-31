import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { isAtlas } from '../core/atlasDoc';
import { MENUS, formatShortcut, type MenuEntry, type MenuItem } from '../menu';
import { runMenuItem } from '../nativeMenu';
import { activeDoc } from '../store';

/**
 * Контекстное меню холста (правая кнопка): самое нужное под рукой — по выделению, слою, тексту.
 * Пункты берутся из главного меню (те же действия, доступность и сочетания клавиш).
 */

export const useCanvasMenu = create<{ x: number; y: number } | null>(() => null);

export const openCanvasMenu = (x: number, y: number) => useCanvasMenu.setState({ x, y }, true);
const close = () => useCanvasMenu.setState(null, true);

/** Пункт главного меню по пути «Меню › [подменю ›] пункт». */
function findItem(path: string[]): MenuItem | null {
  let list: MenuEntry[] = MENUS.find((m) => m.label === path[0])?.items ?? [];
  for (const [i, name] of path.slice(1).entries()) {
    const e = list.find((x) => x !== 'sep' && x.label === name);
    if (!e || e === 'sep') return null;
    if (i === path.length - 2) return 'submenu' in e ? null : e;
    if (!('submenu' in e)) return null;
    list = e.submenu;
  }
  return null;
}

type Entry = { path: string[]; label?: string } | 'sep';

/** Набор пунктов по состоянию документа. */
function entries(): Entry[] {
  const d = activeDoc();
  if (!d) return [];
  const p = (path: string, label?: string): Entry => ({ path: path.split(' › '), label });
  if (isAtlas(d)) return [p('Атлас › Править спрайт'), p('Атлас › Удалить выбранные спрайты'), 'sep', p('Просмотр › Вписать в экран'), p('Просмотр › Реальный размер (100%)')];
  const l = d.activeLayer;
  const list: Entry[] = [p('Правка › Отменить'), p('Правка › Повторить'), 'sep'];
  if (d.selection) {
    list.push(
      p('Выделение › Снять выделение'),
      p('Выделение › Инверсия', 'Инвертировать выделение'),
      p('Выделение › Растушевка…'),
      p('Выделение › Расширить…'),
      p('Выделение › Сжать…'),
      'sep',
      p('Правка › Вырезать'),
      p('Правка › Копировать'),
      p('Правка › Копировать сведённое'),
      p('Правка › Вставить'),
      p('Слои › Новый слой из выделенного', 'Скопировать на новый слой'),
      p('Слои › Вырезать на новый слой'),
      'sep',
      p('Правка › Залить основным цветом'),
      p('Правка › Выполнить заливку (цвет, узор)…', 'Заливка…'),
      p('Правка › Обводка выделения 1px'),
      p('Правка › Очистить', 'Удалить пиксели'),
      'sep',
      p('Изображение › Кадрировать по выделению'),
      p('Выделение › Выделенное в новый документ'),
      p('Нарезка › Слайс из выделения'),
      p('Слои › Маска слоя › Из выделения', 'Маска из выделения'),
      'sep',
      p('Правка › Свободная трансформация'),
    );
  } else {
    list.push(p('Выделение › Всё', 'Выделить всё'), p('Выделение › Непрозрачные пиксели слоя'), p('Правка › Вставить'), 'sep');
    if (l?.text) list.push(p('Слои › Править текст'), p('Слои › Растрировать текст'), 'sep');
    list.push(
      p('Слои › Новый слой'),
      p('Слои › Дублировать слой'),
      p('Слои › Объединить с нижним'),
      p('Слои › Стиль слоя (тень, обводка, наложение)…', 'Стиль слоя…'),
      'sep',
      p('Правка › Свободная трансформация'),
      p('Правка › Отразить слой по горизонтали'),
      p('Правка › Отразить слой по вертикали'),
      p('Изображение › Тримминг (обрезать прозрачное)'),
      'sep',
      p('Просмотр › Вписать в экран'),
      p('Просмотр › Реальный размер (100%)'),
    );
  }
  return list;
}

export function CanvasMenu() {
  const pos = useCanvasMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!pos) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [pos]);

  // меню целиком в окне
  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setAt({ left: Math.max(4, Math.min(pos.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(pos.y, window.innerHeight - r.height - 4)) });
  }, [pos]);

  if (!pos) return null;
  // доступные пункты; разделители без пунктов между ними схлопываются
  const items: (MenuItem & { shown: string } | 'sep')[] = [];
  for (const e of entries()) {
    if (e === 'sep') {
      if (items.length && items[items.length - 1] !== 'sep') items.push('sep');
      continue;
    }
    const it = findItem(e.path);
    if (it && (it.enabled?.() ?? true)) items.push({ ...it, shown: e.label ?? it.label });
  }
  while (items[items.length - 1] === 'sep') items.pop();

  return (
    <div ref={ref} className="ctx-menu canvas-menu" style={at} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className="ctx-item"
            onClick={() => {
              close();
              runMenuItem(it);
            }}
          >
            <span>{it.shown}</span>
            {it.shortcut && <span className="ctx-key">{formatShortcut(it.shortcut)}</span>}
          </button>
        ),
      )}
    </div>
  );
}
