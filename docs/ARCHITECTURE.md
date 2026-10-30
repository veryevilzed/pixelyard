# PixelYard — устройство проекта

Tauri 2 (Rust) + React 19 + TypeScript + Canvas 2D. Репозиторий: `git@github.com:veryevilzed/pixelyard.git`,
ветка `main`. Локальная папка — `~/src/photoedit` (историческое имя). Лицензия Apache-2.0.
Интерфейс на русском, комментарии в коде на русском.

## Запуск и проверка

- `npm run dev` — интерфейс в браузере, http://localhost:1420; `npm run app:dev` — окно Tauri.
- Проверки: `npx tsc --noEmit`, `npx vite build`, `cd src-tauri && cargo build`.
- В dev-режиме модули доступны в консоли: `window.__pe = { store, actions, canvas, types, base, transform }`
  (`src/main.tsx`). После HMR `__pe` может указывать на старые экземпляры — перезагружать страницу.
- Тестирование в Chrome (MCP claude-in-chrome): координаты скриншота ≠ CSS-пикселям (масштаб ~0.8),
  брать `getBoundingClientRect() * 1456/innerWidth`. Модификаторы мыши (⌘) автоматика не передаёт.
- Релиз: `npm run release` (подпись, нотаризация, публикация на GitHub; см. README и скилл
  `~/.claude/skills/apple-sign-release`). Публичные действия (gh release, gh repo edit) запускает
  пользователь — авто-режим их блокирует.

## Модель документа (`src/core/doc.ts`)

- `Doc`: `width/height`, `layers: Layer[]`, `slices`, `cuts` (нож), `guides`, `selection`,
  `activeLayerId`, `editMask`, `view {zoom, panX, panY}`, `preview` (подмена слоя инструментом), `rev`.
- **Слой неизменяем по свойствам** (`updateLayer` создаёт новый объект), **пиксели canvas меняются
  только через** `pixelEdit / multiPixelEdit / compound` — они пишут патчи ImageData в историю
  и сбрасывают состояние контекста (`resetCtx`). Canvas слоя всегда размером с документ.
- Структурные изменения — `doc.change(label, fn)`: снимок `{width,height,layers,slices,cuts,guides,selection,activeLayerId}`.
- Маска слоя — canvas (альфа = видимость); в режиме `editMask` инструменты рисуют в серое
  представление (`editSource()` / `maskToGray` / `grayToMaskData` в `composite.ts`).
- Композит: `src/core/composite.ts` — `renderLayerContent` (маска, fillOpacity, эффекты),
  `renderLayer` (кэш по rev), `compositeLayers` (обтравка, режимы наложения).

## Состояние приложения (`src/store.ts`, zustand)

- `docs`, `activeId` (= активный документ сфокусированной области), `panes` (1–2 области сплита),
  `focusedPane`, `split`, `splitRatio`, `tool`, `fg/bg`, `opts` (ToolOptions, localStorage),
  `prefs` (ViewPrefs, localStorage), `dialog` (DialogState — union видов диалогов), `toast`, `busy`, `panels`.
- `bump()` / `changed()` (`tools/base.ts`) — перерисовка UI и холста; `requestRender()` — только холст.
- Области (сплит): `src/panes.ts` — `addDocToFocused`, `moveDoc`, `splitWith`, `mergePanes`, `paneSizes`.

## Инструменты (`src/tools/`)

- Интерфейс `Tool` (`base.ts`): `down/drag/hover/up/dblclick/key/overlay/cursor/deactivate`.
- `index.ts` — реестр `TOOLS` и `effectiveTool()` (трансформация перекрывает выбранный инструмент).
- `paint.ts` (кисть/карандаш/ластик), `select.ts`, `move.ts`, `transform.ts` (четырёхугольник,
  режимы free/skew/distort/perspective, `core/warp.ts` — гомография), `crop.ts`, `slice.ts`,
  `knife.ts`, `fill.ts` (заливка, градиент, пипетка, фигуры, текст, рука, лупа).

## Ядро (`src/core/`)

- `canvas.ts` — утилиты (createCanvas, ctx2d, alphaBounds, crop, scale, цвета, uid).
- `io.ts` — открытие (PSD через ag-psd с эффектами/масками, TIFF, TGA, браузерные форматы),
  `encodeCanvas` (PNG/JPG/WebP/TIFF; WebP в WebKit — Rust-команда `encode_webp`), `encodePsd`.
- `export.ts` — экспорт слоёв/слайсов, `writeFiles(files, zipStem, asZip)` (папка в Tauri или zip).
- `pack.ts` — упаковщик (сейчас MaxRects short-side, одна страница) — **переписать по TODO**.
- `atlasFormats.ts` — форматы спрайтшитов + шаблонизатор `renderTemplate` (Mustache-подмножество),
  свои форматы в localStorage `pixelyard.formats`.
- `spritesheet.ts` — `packSprites`, `buildSheetFiles` (масштабы + формат).
- `bmfont.ts` — рендер глифов, кернинг, `packFont`, `gridFont`, форматы .fnt/XML/JSON.
- `filters.ts` (коррекции, кривые, авто), `selection.ts`, `flood.ts`, `slicing.ts`, `patterns.ts`,
  `render.ts` (отрисовка вида, линейки, направляющие, clampView), `platform.ts` (Tauri/браузер).

## Интерфейс (`src/ui/`)

- `App.tsx` — раскладка, горячие клавиши (`handleKey`), drop файлов, защита от закрытия.
- `Panes.tsx` (вкладки с перетаскиванием, сплит), `Viewport.tsx` (холст области, указатель, зум),
  `MenuBar.tsx`, `OptionsBar.tsx` (опции инструмента; переопределяется при трансформации),
  `Toolbox.tsx`, `Sidebar.tsx` + `panels/` (Navigator, Color, Layers, Slices, History).
- Диалоги: `Dialogs.tsx` (роутер + Modal + большинство диалогов), `StyleDialogs.tsx` (стиль слоя,
  цветовой диапазон, заливка, резы, направляющая), `CurvesDialog.tsx`, `PackDialogs.tsx`
  (спрайтшит, BMFont, редактор своих форматов).
- Меню и сочетания: `src/menu.ts` (`MENUS`, `findShortcut`, `TOOL_KEYS`).
- Стили: `src/styles.css` (тёмная тема, CSS-переменные).

## Соглашения

- Строки списков и панели опций — `flex-shrink: 0` (иначе сжимаются).
- Диалоги с превью — `Modal seeThrough`, превью через `doc.preview`, очистка в cleanup эффекта.
- Перерисовки превью-канвасов в диалогах — через `useBoxSize` (ResizeObserver).
- Перед коммитом: `tsc` + `vite build`; коммиты на русском с `Co-Authored-By: Claude Opus 5.5`.
- Версия — `package.json` (Tauri читает оттуда), `Cargo.toml` синхронизирует `npm run release`.
