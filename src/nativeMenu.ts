import { isTauri, quitWithConfirm } from './core/platform';
import { formatShortcut, MENUS, type MenuEntry, type MenuItem } from './menu';
import { openDialog, useApp } from './store';
import { useFonts } from './core/fontLibrary';
import { APP_NAME } from './version';

/**
 * Системное меню macOS (строка вверху экрана), собранное из тех же MENUS, что и меню в окне.
 * Состояние пунктов (доступность, галочки) обновляется при изменениях; меню со списками
 * (шрифты) пересобирается, когда список меняется.
 *
 * Сочетания системного меню срабатывают раньше страницы. Поэтому «текстовые» сочетания
 * (⌘Z, ⇧⌘Z, ⌘A, ⌘X, ⌘C, ⌘V, ⌫…) к системному меню не привязываются — клавиши получает окно:
 * в поле ввода это обычная работа с текстом, на холсте — команда редактора (handleKey).
 * В названии такого пункта сочетание показано текстом.
 */

type MenuApi = typeof import('@tauri-apps/api/menu');
type NativeEntry = import('@tauri-apps/api/menu').MenuItem | import('@tauri-apps/api/menu').Submenu | import('@tauri-apps/api/menu').PredefinedMenuItem | import('@tauri-apps/api/menu').CheckMenuItem;

interface Live {
  item: MenuItem;
  native: { setEnabled(v: boolean): Promise<void>; setChecked?(v: boolean): Promise<void> };
  enabled: boolean;
  checked: boolean;
}

let live: Live[] = [];
let signature = '';
let active = false;

/** Системное меню включено (тогда меню в окне не показывается). */
export const nativeMenuActive = () => active;

/** Сочетания, нужные полям ввода: их ловит окно, а не системное меню. */
const TEXT_KEYS = new Set(['Mod+Z', 'Shift+Mod+Z', 'Mod+A', 'Mod+X', 'Mod+C', 'Mod+V']);
const textKey = (sc: string | undefined) => !!sc && (TEXT_KEYS.has(sc) || /Backspace|Delete/.test(sc));

/** Сочетание из menu.ts → ускоритель Tauri. null — не привязывать к системному меню. */
function accelerator(sc: string | undefined): string | null {
  if (!sc || textKey(sc)) return null;
  const parts = sc.split('+');
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === 'Mod' ? 'CmdOrCtrl' : m === 'Ctrl' ? 'Control' : m));
  return [...mods, key].join('+');
}


/** Выполнить пункт (с защитой от двойного срабатывания: системное меню + клавиатура окна). */
let lastRun = { item: null as MenuItem | null, at: 0 };
export function runMenuItem(item: MenuItem) {
  const now = performance.now();
  if (lastRun.item === item && now - lastRun.at < 150) return;
  lastRun = { item, at: now };
  if (!item.enabled || item.enabled()) item.action();
}

/** Подпись всех пунктов: меняется — меню пересобирается (списки шрифтов, панелей). */
function makeSignature(entries: MenuEntry[]): string {
  return entries.map((e) => (e === 'sep' ? '-' : 'submenu' in e ? `${e.label}[${makeSignature(e.submenu)}]` : e.label)).join('|');
}

async function buildEntries(api: MenuApi, entries: MenuEntry[], out: Live[]): Promise<NativeEntry[]> {
  const items: NativeEntry[] = [];
  for (const e of entries) {
    if (e === 'sep') {
      items.push(await api.PredefinedMenuItem.new({ item: 'Separator' }));
      continue;
    }
    if ('submenu' in e) {
      items.push(await api.Submenu.new({ text: e.label, items: await buildEntries(api, e.submenu, out) }));
      continue;
    }
    const enabled = !e.enabled || e.enabled();
    const checked = !!e.checked?.();
    // сочетание, которое не привязано к меню, — подсказкой в названии
    const text = textKey(e.shortcut) ? `${e.label}\u2003${formatShortcut(e.shortcut!)}` : e.label;
    const opts = { text, enabled, accelerator: accelerator(e.shortcut) ?? undefined, action: () => {
      // пока открыт диалог или идёт долгая операция — как и клавиши окна, меню не срабатывает
      const st = useApp.getState();
      if (!st.dialog && !st.busy) runMenuItem(e);
    } };
    const native = e.checked ? await api.CheckMenuItem.new({ ...opts, checked }) : await api.MenuItem.new(opts);
    out.push({ item: e, native, enabled, checked });
    items.push(native);
  }
  return items;
}

async function build() {
  const api = await import('@tauri-apps/api/menu');
  const next: Live[] = [];
  const appMenu = await api.Submenu.new({
    text: APP_NAME,
    items: [
      await api.MenuItem.new({ text: `О программе ${APP_NAME}`, action: () => openDialog({ kind: 'about' }) }),
      await api.PredefinedMenuItem.new({ item: 'Separator' }),
      await api.PredefinedMenuItem.new({ item: 'Services' }),
      await api.PredefinedMenuItem.new({ item: 'Separator' }),
      await api.PredefinedMenuItem.new({ item: 'Hide', text: `Скрыть ${APP_NAME}` }),
      await api.PredefinedMenuItem.new({ item: 'HideOthers', text: 'Скрыть остальные' }),
      await api.PredefinedMenuItem.new({ item: 'ShowAll', text: 'Показать все' }),
      await api.PredefinedMenuItem.new({ item: 'Separator' }),
      // свой пункт: перед выходом — вопрос о несохранённом
      await api.MenuItem.new({ text: `Завершить ${APP_NAME}`, accelerator: 'CmdOrCtrl+Q', action: () => void quitWithConfirm(useApp.getState().docs.filter((d) => d.dirty).map((d) => d.name)) }),
    ],
  });
  const menus: NativeEntry[] = [];
  for (const m of MENUS) {
    if (m.label === 'Справка') continue;
    const items = await buildEntries(api, m.items, next);
    if (m.label === 'Окно') {
      // системные пункты окна — в начало
      items.unshift(
        await api.PredefinedMenuItem.new({ item: 'Minimize', text: 'Свернуть' }),
        await api.PredefinedMenuItem.new({ item: 'Maximize', text: 'Изменить масштаб' }),
        await api.PredefinedMenuItem.new({ item: 'Fullscreen', text: 'Во весь экран' }),
        await api.PredefinedMenuItem.new({ item: 'Separator' }),
      );
    }
    menus.push(await api.Submenu.new({ text: m.label, items }));
  }
  const help = MENUS.find((m) => m.label === 'Справка');
  if (help) menus.push(await api.Submenu.new({ text: help.label, items: await buildEntries(api, help.items, next) }));
  const menu = await api.Menu.new({ items: [appMenu, ...menus] });
  await menu.setAsAppMenu();
  live = next;
}

/** Обновить доступность и галочки (только изменившиеся пункты). */
function refresh() {
  const sig = makeSignature(MENUS.flatMap((m) => m.items));
  if (sig !== signature) {
    signature = sig;
    void build();
    return;
  }
  for (const l of live) {
    const en = !l.item.enabled || l.item.enabled();
    if (en !== l.enabled) {
      l.enabled = en;
      void l.native.setEnabled(en);
    }
    if (l.item.checked && l.native.setChecked) {
      const ch = l.item.checked();
      if (ch !== l.checked) {
        l.checked = ch;
        void l.native.setChecked(ch);
      }
    }
  }
}

export async function installNativeMenu() {
  if (!isTauri || !navigator.userAgent.includes('Mac')) return;
  try {
    signature = makeSignature(MENUS.flatMap((m) => m.items));
    await build();
    active = true;
    useApp.setState((s) => ({ tick: s.tick + 1 }));
    let timer = 0;
    const schedule = () => {
      if (!timer) timer = window.setTimeout(() => ((timer = 0), refresh()), 120);
    };
    useApp.subscribe(schedule);
    useFonts.subscribe(schedule);
  } catch (e) {
    console.error('Системное меню не создано, остаётся меню в окне', e);
  }
}
