# PixelYard — устройство проекта

Tauri 2 (Rust) + React 19 + TypeScript + Canvas 2D. Репозиторий: `git@github.com:veryevilzed/pixelyard.git`,
ветка `main`. Локальная папка — `~/src/photoedit` (историческое имя). Лицензия Apache-2.0.
Интерфейс на русском, комментарии в коде на русском.

## Запуск и проверка

- `npm run dev` — интерфейс в браузере, http://localhost:1420; `npm run app:dev` — окно Tauri.
- Проверки: `npx tsc --noEmit`, `npx vite build`, `cd src-tauri && cargo build`.
- В dev-режиме модули доступны в консоли: `window.__pe = { store, actions, canvas, types, base, transform,
  atlasActions, atlas, atlasDoc, pack }` (`src/main.tsx`). После HMR `__pe` может указывать на старые
  экземпляры — перезагружать страницу. `import('/src/…')` из консоли даёт **другой** экземпляр модуля, чем у
  приложения (состояние zustand не общее) — для проверки поведения пользоваться `__pe` или кликами.
- Тестирование в Chrome (MCP claude-in-chrome): координаты скриншота ≠ CSS-пикселям (масштаб ~0.8),
  брать `getBoundingClientRect() * 1456/innerWidth`. ⇧-клик автоматика передаёт.
  `pointerdown.detail` в Chrome всегда 0 — двойной клик ловится родным `dblclick` (Viewport).
  Перезагрузка страницы блокируется `beforeunload`, если есть несохранённые документы —
  в консоли `__pe.store.app().docs.forEach(d => d.savedRev = d.rev)` перед `location.href = …`.
- Локальная установка: `npx tauri build --bundles app` (в фоне — `PATH="$HOME/.cargo/bin:$PATH"`),
  затем заменить `/Applications/PixelYard.app` и `lsregister -f`. Перед заменой программу закрыть
  (`osascript -e 'tell application "PixelYard" to quit'` — с 0.2.0 она спрашивает о несохранённом).
- Выпуск: поднять версию в `package.json` и `src-tauri/Cargo.toml`, раздел `## [x.y.z] — дата` в
  CHANGELOG, коммит + push, затем `npm run release -- --yes` (сохранённые ответы в `.release.json`:
  universal, Developer ID 9SWRGCQL63, нотаризация ключом API, публикация на GitHub). Инструмент сам
  ставит тег на HEAD и пушит — **во время релиза ничего не коммитить**. Скилл: `~/.claude/skills/apple-sign-release`.
- Сканер без интерфейса: `cd src-tauri && cargo run --example scan_probe` (поиск + сессия, без сканирования).

## Модель документа (`src/core/doc.ts`)

- `Doc`: `width/height`, `layers: Layer[]`, `slices`, `cuts` (нож), `guides`, `selection`,
  `activeLayerId`, `editMask`, `view {zoom, panX, panY}`, `preview` (подмена слоя инструментом), `rev`.
- **Слой неизменяем по свойствам** (`updateLayer` создаёт новый объект), **пиксели canvas меняются
  только через** `pixelEdit / multiPixelEdit / compound` — они пишут патчи ImageData в историю
  и сбрасывают состояние контекста (`resetCtx`). Canvas слоя всегда размером с документ.
- Структурные изменения — `doc.change(label, fn)`: снимок `{width,height,layers,slices,cuts,guides,selection,
  activeLayerId,atlas,groups,nine}`.
- **Папки** — `doc.groups` (id, имя, видимость, свёрнута, непрозрачность, цвет) + `layer.group`; слои
  папки идут подряд (`moveLayer` → `fixGroupAfterMove`). Цветовая метка — `layer.color`.
- **Текстовый слой** — `layer.text: TextData` (значение, позиция, шрифт или `bmfont:<id>`, кегль, цвет…);
  пиксели строит `core/textLayer.ts`. Любая правка пикселей текстового слоя растрирует его в той же записи
  истории (`withRasterize` в `Doc`); кисть и трансформация вместо этого просят растрировать (`editableLayer`).
- **9-slice документа** — `doc.nine` (редактор 9-slice, линии на холсте — `render.ts`, перетаскивание — `Viewport.tsx`).
- Маска слоя — canvas (альфа = видимость); в режиме `editMask` инструменты рисуют в серое
  представление (`editSource()` / `maskToGray` / `grayToMaskData` в `composite.ts`).
- Композит: `src/core/composite.ts` — `renderLayerContent` (маска, fillOpacity, эффекты),
  `renderLayer` (кэш по объекту слоя + версии пикселей `touchCanvas`), `compositeLayers` (обтравка,
  режимы наложения, видимость и непрозрачность папок).
- **Скорость отрисовки** (`render.ts`) — всё пересчитывается только там, где изменилось:
  - `compositeForView`: ключ — слои, папки, маска, узоры, размер и `pixelStamp` (версии пикселей слоёв).
    Ничего не изменилось (выделение, направляющие) — прошлое сведение; правка пикселей — только область
    `doc.pixelDirty` (её копят `Doc.edit` и отмена/повтор); кадр мазка — только `LayerPreview.takeDirty()`;
    свойства, порядок, стили слоёв — целиком. После превью пересводится то, что оно успело поменять.
  - `displayLevel`: копия сведения в видеопамяти с уровнями ½, ¼… (и для навигатора); заливается кусками
    через `getImageData/putImageData` — `drawImage` из `willReadFrequently`-холста копирует его целиком.
  - Подложка вида (фон, шахматка, документ, сетки) — на холст области; журнал изменённых областей
    (`logDirty`/`dirtySince`) — перерисовка только под изменённым, обрезка по целым точкам экрана.
  - Грабли: узор шахматки из «читаемого» холста заливался в видеопамять при каждой заливке (11–16 мс);
    `imageSmoothingQuality = 'high'` после каждого изменения исходника строит его уменьшенные копии
    целиком — у нас везде `'low'` (уровень и так не дальше 2× от масштаба).
- **Фильтры** (`core/filterPool.ts`, `filterWorker.ts`): попиксельные коррекции режутся на полосы по ядрам
  (Web Workers), автокоррекции — целиком в одном потоке; размытие — фильтром холста `blur()` на
  видеокарте с продолжением краёв (`nativeBlur` в `filters.ts`), запасной путь — программный.
  `filterResultAsync` / `commitFilterResult` в `actions.ts`; диалоги считают предпросмотр там же.

## Состояние приложения (`src/store.ts`, zustand)

- `docs`, `activeId` (= активный документ сфокусированной области), `panes` (1–2 области сплита),
  `focusedPane`, `split`, `splitRatio`, `tool`, `fg/bg`, `opts` (ToolOptions, localStorage),
  `prefs` (ViewPrefs, localStorage), `dialog` (DialogState — union видов диалогов), `toast`, `busy`, `panels`.
- `bump()` / `changed()` (`tools/base.ts`) — перерисовка UI и холста; `requestRender()` — только холст.
- Области (сплит): `src/panes.ts` — `addDocToFocused`, `moveDoc`, `splitWith`, `mergePanes`, `paneSizes`.
- Боковые колонки: `src/dock.ts` (`useDock`: колонки панелей и ширины для режимов image/atlas, localStorage
  `pixelyard.dock`; `movePanel`, `toggleTwoColumns`, `resetDock`), отрисовка — `ui/Sidebar.tsx` (`PANELS`).
- Системное меню macOS: `src/nativeMenu.ts` строит его из `MENUS` (Tauri JS menu API), обновляет
  доступность/галочки, пересобирает при смене списков; «текстовые» сочетания (⌘Z/⇧⌘Z/⌘A/⌘X/⌘C/⌘V/⌫) к
  меню не привязаны — их ловит `handleKey`. `runMenuItem` защищает от двойного срабатывания.

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
- `paint.ts` (кисть/карандаш/ластик/**штамп** — `cloneSource`, буфер мазка как маска источника),
  `select.ts` (⇧ добавить, ⌥/Ctrl вычесть; палочка с допуском протягиванием, `floodMaskData`),
  `move.ts` (текстовый слой двигается как текст), `transform.ts` (четырёхугольник,
  режимы free/skew/distort/perspective, `core/warp.ts` — гомография), `crop.ts`, `slice.ts`,
  `knife.ts`, `fill.ts` (заливка, градиент, пипетка, фигуры + **стрелка** с изгибом Безье,
  текст с текстовыми слоями и BMFont, рука, лупа), `atlasTool.ts`.

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
  `render.ts` (отрисовка вида, линейки, направляющие, clampView, кэши — см. выше), `platform.ts`
  (Tauri/браузер: файлы, перетаскивание с модификаторами, файлы из Finder, печать `printPages`,
  выход с вопросом `quitWithConfirm`).
- `textLayer.ts` — текстовые слои (рендер, правка, поиск слоя под точкой).
- `fontLibrary.ts` — библиотека растровых шрифтов (созданные и открытые `.fnt`), `drawBitmapText`.
- `icons.ts` — ICO/ICNS, наборы иконок под платформы. `pdf.ts` — импорт (pdf.js) и экспорт PDF.
- `print.ts` — раскладка листа, метки печати. `color.ts` — модели HSB/HSL/Lab/CMYK, гармонии, `.gpl`.
- `nineslice.ts` — растяжение 9-slice, Android `.9.png`.

## Rust (`src-tauri/src/`)

- `lib.rs`: `encode_webp`, `take_opened_files` (+ `RunEvent::Opened`), `modifier_keys`
  (CGEventSourceFlagsState), `print_webview`, `quit_app`; перехват `RunEvent::ExitRequested{code: None}` →
  событие `quit-requested` (интерфейс спрашивает о несохранённом и вызывает `quit_app`).
- `scanner.rs` (macOS): ImageCaptureCore через `objc2-image-capture-core`. Все вызовы — в главном потоке
  (`run_on_main_thread`), состояние для опроса — `scanner_status`. Делегат `ICDeviceBrowserDelegate`
  обязателен (без него устройства не находятся); сканируется всё стекло в файл, область вырезает интерфейс.

## Интерфейс (`src/ui/`)

- `App.tsx` — раскладка, горячие клавиши (`handleKey`), drop файлов, защита от закрытия.
- `Panes.tsx` (вкладки с перетаскиванием, сплит), `Viewport.tsx` (холст области, указатель, зум),
  `MenuBar.tsx`, `OptionsBar.tsx` (опции инструмента; переопределяется при трансформации),
  `Toolbox.tsx`, `Sidebar.tsx` + `panels/` (Navigator, Color, Layers, Slices, History).
- Диалоги: `Dialogs.tsx` (роутер + Modal + большинство диалогов), `StyleDialogs.tsx` (стиль слоя,
  цветовой диапазон, заливка, резы, направляющая), `CurvesDialog.tsx`, `PackDialogs.tsx`
  (спрайтшит, BMFont, редактор своих форматов), `IconDialog.tsx`, `PdfDialogs.tsx`, `PrintDialog.tsx`,
  `ColorDialog.tsx` («Палитра цветов»), `ScanDialog.tsx`, `SaveDialogs.tsx` («Сохранить как»,
  «Экспортировать как», `formatSize`).
- Панели: `panels/LayersPanel.tsx` (папки, метки, правый клик), `ColorPanel.tsx` (вкладки «Цвет»,
  «Гармония», «Палитры»; `usePalettes`, `addToPalette`), `NinePanel.tsx`, `AtlasPanel.tsx`, Navigator,
  Slices, History.
- Меню и сочетания: `src/menu.ts` (`MENUS`, `findShortcut`, `TOOL_KEYS`).
- Стили: `src/styles.css` (тёмная тема, CSS-переменные).

## Соглашения

- Строки списков и панели опций — `flex-shrink: 0` (иначе сжимаются).
- Диалоги с превью — `Modal seeThrough`, превью через `doc.preview`, очистка в cleanup эффекта.
- Перерисовки превью-канвасов в диалогах — через `useBoxSize` (ResizeObserver).
- Перед коммитом: `tsc` + `vite build`; коммиты на русском с `Co-Authored-By: Claude Opus 5.5`.
- Версия — `package.json` (Tauri читает оттуда) и `src-tauri/Cargo.toml`; при `--yes` релиз версию не
  меняет — поднимать вручную перед выпуском.
- Холсты с `getImageData` по пикселям — размер целым числом (`Math.round(size * dpr)`), иначе индексы
  ImageData «плывут» (так ломался круг гармоний при дробном dpr).
- Классы CSS не переиспользовать вслепую: `.swatch` уже занят палитрой (метки слоёв — `.label-swatch`).
