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
  брать `getBoundingClientRect() * 1456/innerWidth`. ⇧-клик автоматика передаёт.
  `pointerdown.detail` в Chrome всегда 0 — двойной клик ловится родным `dblclick` (Viewport).
  Перезагрузка страницы блокируется `beforeunload`, если есть несохранённые документы —
  в консоли `__pe.store.app().docs.forEach(d => d.savedRev = d.rev)` перед `location.href = …`.
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

## Атлас (уровень приложения)

- `src/atlasActions.ts` — создание атласа, добавление/удаление спрайтов, `editSpriteAction`
  (вкладка с `doc.link`), `installAtlasSync` (подписка на `tick`: перепаковка после undo и перенос
  правок связанных вкладок с задержкой 150 мс), `saveAtlasProject`, `exportAtlasAction`.
- `effectiveTool()` подменяет инструмент на `tools/atlasTool.ts`, когда активен атлас (кроме руки/лупы).
- Меню: пункты, меняющие пиксели, проверяют `hasImg`/`img()` (не атлас); меню «Атлас».
- Интерфейс: `ui/panels/AtlasPanel.tsx` (спрайты, свойства, анимации, выгрузка), `AtlasOptions` в `OptionsBar.tsx`.
- Tauri: `bundle.fileAssociations` (.pyard) + `RunEvent::Opened` → очередь `take_opened_files` → `onOpenedFiles`.

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
- `pack.ts` — упаковщик: `packPages` (MaxRects 5 эвристик, полки, сетка, «наилучший», вращение,
  страницы, штраф за вытянутость страницы), `pack()` — одна страница (BMFont, спрайтшит).
- `atlas.ts` — модель атласа (`AtlasState`: спрайты, анимации, настройки упаковки и выгрузки),
  `buildAtlas`, `exportAtlasFiles`, `.pyard` (`encodeProject/decodeProject`), `detectAnimations`.
- `atlasDoc.ts` — атлас как `Doc` (`kind: 'atlas'`): `syncAtlas` пересобирает слой страницы из
  `doc.atlas` (сравнение по ссылке), `updateAtlas/updateSprites` — правки через историю,
  `replaceSpriteImage` — правка из связанной вкладки без истории (патчит и снимки).
- `atlasFormats.ts` — форматы спрайтшитов (`rotation: cw|ccw|false`, `multi: per-page|single`,
  `extraFiles`), `describeAtlas` (файлы описания по страницам), шаблонизатор `renderTemplate`,
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
