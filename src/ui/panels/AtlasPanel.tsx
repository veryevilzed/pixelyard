import { FolderPlus, ImagePlus, Pencil, Play, Plus, Trash, Upload, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addSpriteFiles, editSpriteAction, exportAtlasAction, removeSpritesAction, spritesFromDocAction,
} from '../../atlasActions';
import {
  allSpriteFormats, detectAnimations, IMAGE_EXT, pageFill, type AnimMode, type AtlasAnimation, type AtlasExport, type AtlasSprite, type AtlasState,
} from '../../core/atlas';
import { frameOf, isAtlas, selectedSprites, setAtlasPage, updateAtlas, updateSprites } from '../../core/atlasDoc';
import { ctx2d, uid } from '../../core/canvas';
import type { Doc } from '../../core/doc';
import { activeDoc, app, useApp } from '../../store';
import { changed } from '../../tools/base';
import { Check, NumberField, scrollIntoList, TextInput } from '../controls';

/** Ввод по буквам / прокрутка значения схлопываются в одну запись истории. */
function mergeable(doc: Doc, label: string) {
  const last = doc.undoStack[doc.undoStack.length - 1];
  if (last?.label === label && last.after?.atlas === doc.atlas) doc.undo();
}

function useAtlasDoc() {
  useApp((s) => s.tick);
  const d = activeDoc();
  return d && isAtlas(d) ? d : null;
}

/** Миниатюра картинки спрайта (перерисовка только при смене картинки). */
function Thumb({ image, size = 28 }: { image: HTMLCanvasElement; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = ctx2d(c);
    ctx.clearRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / image.width, c.height / image.height, 4 * dpr);
    const w = image.width * k, h = image.height * k;
    ctx.imageSmoothingEnabled = k < 1;
    ctx.drawImage(image, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }, [image, size]);
  return <canvas ref={ref} className="layer-thumb" style={{ width: size, height: size }} />;
}

// ---------- страницы и список спрайтов ----------

export function AtlasPanel() {
  const doc = useAtlasDoc();
  const [query, setQuery] = useState('');
  const lastClick = useRef<string | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const sel0 = doc?.atlasSel[doc.atlasSel.length - 1];
  useEffect(() => {
    scrollIntoList(activeRef.current);
  }, [sel0]);
  if (!doc) return <div className="panel-body note">Нет атласа</div>;
  const a = doc.atlas;
  const pages = doc.atlasPack?.pages ?? [];
  const sel = new Set(doc.atlasSel);
  const q = query.trim().toLowerCase();
  const list = a.sprites.filter((s) => !q || `${s.folder}/${s.name}`.toLowerCase().includes(q));
  // группировка по папкам в порядке появления
  const folders = [...new Set(list.map((s) => s.folder))].sort((x, y) => (x === '' ? -1 : y === '' ? 1 : x.localeCompare(y)));

  const click = (e: React.MouseEvent, sp: AtlasSprite) => {
    if (e.shiftKey && lastClick.current) {
      const ids = list.map((s) => s.id);
      const i0 = ids.indexOf(lastClick.current), i1 = ids.indexOf(sp.id);
      if (i0 >= 0 && i1 >= 0) doc.atlasSel = [...new Set([...doc.atlasSel, ...ids.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)])];
    } else if (e.metaKey || e.ctrlKey) doc.atlasSel = sel.has(sp.id) ? doc.atlasSel.filter((x) => x !== sp.id) : [...doc.atlasSel, sp.id];
    else doc.atlasSel = [sp.id];
    lastClick.current = sp.id;
    // показываем страницу, на которой лежит спрайт
    const f = frameOf(doc, sp.id);
    if (f && f.page !== doc.atlasPage) setAtlasPage(doc, f.page);
    changed();
  };

  return (
    <>
      <div className="atlas-pages">
        {pages.length > 1 &&
          pages.map((p, i) => (
            <button key={i} className={`btn small ${i === doc.atlasPage ? 'primary' : ''}`} onClick={() => (setAtlasPage(doc, i), changed())} title={`${p.width}×${p.height}`}>
              {i}
            </button>
          ))}
        <span className="dim">
          {doc.atlasError ? (
            <span className="error-text">{doc.atlasError}</span>
          ) : pages[doc.atlasPage] ? (
            `${pages.length > 1 ? `стр. ${doc.atlasPage + 1}/${pages.length} · ` : ''}${pages[doc.atlasPage].width}×${pages[doc.atlasPage].height} · ${Math.round(pageFill(pages[doc.atlasPage]) * 100)}%`
          ) : (
            ''
          )}
        </span>
      </div>
      <div className="atlas-search">
        <TextInput value={query} onChange={setQuery} placeholder={`Поиск (${a.sprites.length})`} width="100%" />
      </div>
      <div className="panel-body list" style={{ minHeight: 160, maxHeight: "42vh" }}>
        {a.sprites.length === 0 && (
          <div className="note" style={{ padding: 8 }}>
            Атлас пуст. Перетащите картинки в окно, кнопка «+» выше или меню «Атлас».
          </div>
        )}
        {folders.map((folder) => (
          <div key={folder || '/'}>
            {folder && (
              <div
                className="atlas-folder"
                onClick={() => {
                  doc.atlasSel = list.filter((s) => s.folder === folder).map((s) => s.id);
                  changed();
                }}
              >
                {folder}/
              </div>
            )}
            {list
              .filter((s) => s.folder === folder)
              .map((sp) => {
                const f = frameOf(doc, sp.id);
                return (
                  <div
                    key={sp.id}
                    ref={sp.id === sel0 ? activeRef : undefined}
                    className={`layer-row atlas-row ${sel.has(sp.id) ? 'active' : ''} ${folder ? 'nested' : ''}`}
                    onClick={(e) => click(e, sp)}
                    onDoubleClick={() => void editSpriteAction(doc, sp.id)}
                  >
                    <Thumb image={sp.image} />
                    <span className="layer-name">{sp.name}</span>
                    {app().docs.some((d) => d.link?.spriteId === sp.id) && <Pencil size={11} className="dim" />}
                    {sp.scale !== 1 && <span className="tag">×{sp.scale}</span>}
                    {sp.nine && <span className="tag">9s</span>}
                    <span className="dim">
                      {sp.image.width}×{sp.image.height}
                      {pages.length > 1 && f ? ` · ${f.page}` : ''}
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </>
  );
}

export function AtlasActions() {
  const doc = useAtlasDoc();
  const images = useApp((s) => s.docs).filter((d) => !isAtlas(d) && !d.link);
  return (
    <>
      <button className="icon-btn" title="Добавить картинки…" disabled={!doc} onClick={() => void addSpriteFiles()}>
        <ImagePlus size={13} />
      </button>
      {images.length > 0 && (
        <select
          className="icon-select"
          title="Добавить из открытого документа"
          value=""
          disabled={!doc}
          onChange={(e) => {
            const [id, what] = e.target.value.split('|');
            const src = app().docs.find((d) => d.id === id);
            if (src && doc) spritesFromDocAction(src, what as 'layers' | 'slices' | 'merged', doc.id);
          }}
        >
          <option value="">＋ из документа</option>
          {images.flatMap((d) => [
            <option key={d.id + 'l'} value={`${d.id}|layers`}>{d.name}: слои</option>,
            d.slices.length ? <option key={d.id + 's'} value={`${d.id}|slices`}>{d.name}: слайсы</option> : null,
            <option key={d.id + 'm'} value={`${d.id}|merged`}>{d.name}: целиком</option>,
          ])}
        </select>
      )}
      <button className="icon-btn" title="Удалить выбранные (Delete)" disabled={!doc?.atlasSel.length} onClick={() => doc && removeSpritesAction(doc, doc.atlasSel)}>
        <Trash size={13} />
      </button>
    </>
  );
}

// ---------- свойства выбранных ----------

/** Общее значение у всех выбранных или undefined, если разное. */
function common<T>(list: AtlasSprite[], get: (s: AtlasSprite) => T): T | undefined {
  if (!list.length) return undefined;
  const v = get(list[0]);
  return list.every((s) => get(s) === v) ? v : undefined;
}

export function SpritePanel() {
  const doc = useAtlasDoc();
  if (!doc) return null;
  const list = selectedSprites(doc);
  if (!list.length) return <div className="panel-body note">Выберите спрайт в атласе или в списке (⇧/⌘ — несколько, рамка — область)</div>;
  const ids = list.map((s) => s.id);
  const one = list.length === 1 ? list[0] : null;
  const upd = (patch: Partial<AtlasSprite> | ((s: AtlasSprite) => Partial<AtlasSprite>), label: string) => {
    mergeable(doc, label);
    updateSprites(doc, ids, patch, label);
    changed();
  };
  const scale = common(list, (s) => s.scale);
  const trim = common(list, (s) => s.trim);
  const extrude = common(list, (s) => s.extrude);
  const rotate = common(list, (s) => s.rotate);
  const px = common(list, (s) => s.pivotX), py = common(list, (s) => s.pivotY);
  const folder = common(list, (s) => s.folder);
  const nine = one?.nine ?? null;
  const f = one ? frameOf(doc, one.id) : null;
  const PIVOTS: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];
  return (
    <div className="slice-edit atlas-props">
      {one ? (
        <div className="full">
          <TextInput value={one.name} onChange={(v) => upd({ name: v.replace(/\//g, '_') }, 'Имя спрайта')} width="100%" />
        </div>
      ) : (
        <div className="full note">Выбрано спрайтов: {list.length} — изменения применяются ко всем</div>
      )}
      <div className="full row-fields">
        <span className="label static">Папка</span>
        <TextInput value={folder ?? ''} placeholder={folder === undefined ? 'разные' : 'нет'} onChange={(v) => upd({ folder: v.replace(/^\/+|\/+$/g, '') }, 'Папка спрайта')} width="100%" />
      </div>
      <div className="full row-fields">
        <NumberField label="Масштаб" value={scale ?? 1} min={0.01} max={16} step={0.05} width={52} onChange={(v) => upd({ scale: v }, 'Масштаб спрайта')} title={scale === undefined ? 'У выбранных разный масштаб' : undefined} />
        {[0.5, 1, 2].map((k) => (
          <button key={k} className={`btn small ${scale === k ? 'primary' : ''}`} onClick={() => upd({ scale: k }, 'Масштаб спрайта')}>
            ×{k}
          </button>
        ))}
      </div>
      <div className="full row-fields">
        <span className="label static">Обрезка</span>
        <select value={trim ?? ''} onChange={(e) => upd({ trim: e.target.value as AtlasSprite['trim'] }, 'Обрезка спрайта')}>
          {trim === undefined && <option value="">разная</option>}
          <option value="inherit">как в атласе</option>
          <option value="on">обрезать</option>
          <option value="off">не обрезать</option>
        </select>
      </div>
      <div className="full row-fields">
        <Check label="Свой extrude" checked={extrude !== null && extrude !== undefined} onChange={(v) => upd({ extrude: v ? doc.atlas.settings.extrude || 1 : null }, 'Extrude спрайта')} />
        {extrude !== null && extrude !== undefined && <NumberField value={extrude} min={0} max={16} width={40} onChange={(v) => upd({ extrude: Math.round(v) }, 'Extrude спрайта')} suffix="px" />}
      </div>
      <div className="full">
        <Check
          label={doc.atlas.settings.allowRotation ? 'Можно поворачивать' : 'Можно поворачивать (вращение выключено в атласе)'}
          checked={rotate ?? true}
          onChange={(v) => upd({ rotate: v }, 'Вращение спрайта')}
        />
      </div>
      <div className="full row-fields">
        <span className="label static">Опорная точка</span>
        <span className="pivot-grid">
          {PIVOTS.map(([x, y]) => (
            <button key={`${x}${y}`} className={px === x && py === y ? 'on' : ''} onClick={() => upd({ pivotX: x, pivotY: y }, 'Опорная точка')} title={`${x}, ${y}`} />
          ))}
        </span>
        <NumberField label="X" value={px ?? 0.5} min={0} max={1} step={0.05} width={40} onChange={(v) => upd({ pivotX: v }, 'Опорная точка')} />
        <NumberField label="Y" value={py ?? 0.5} min={0} max={1} step={0.05} width={40} onChange={(v) => upd({ pivotY: v }, 'Опорная точка')} />
      </div>
      {one && (
        <>
          <div className="full">
            <Check
              label="9-slice (растягиваемые границы)"
              checked={!!nine}
              onChange={(v) => {
                const d = Math.max(1, Math.floor(Math.min(one.image.width, one.image.height) / 4));
                upd({ nine: v ? { left: d, top: d, right: d, bottom: d } : null }, '9-slice');
              }}
            />
          </div>
          {nine && (
            <>
              <NumberField label="Л" value={nine.left} min={0} max={one.image.width} width={40} onChange={(v) => upd({ nine: { ...nine, left: Math.round(v) } }, '9-slice')} />
              <NumberField label="В" value={nine.top} min={0} max={one.image.height} width={40} onChange={(v) => upd({ nine: { ...nine, top: Math.round(v) } }, '9-slice')} />
              <NumberField label="П" value={nine.right} min={0} max={one.image.width} width={40} onChange={(v) => upd({ nine: { ...nine, right: Math.round(v) } }, '9-slice')} />
              <NumberField label="Н" value={nine.bottom} min={0} max={one.image.height} width={40} onChange={(v) => upd({ nine: { ...nine, bottom: Math.round(v) } }, '9-slice')} />
            </>
          )}
          <div className="full note">
            {one.image.width}×{one.image.height}
            {f && f.w > 0 ? ` → в атласе ${f.w}×${f.h}${f.trimmed ? ' (обрезан)' : ''}${f.rotated ? ', повёрнут' : ''}, стр. ${f.page}, x ${f.x} y ${f.y}` : ' — пустой'}
          </div>
          <div className="full">
            <button className="btn small" onClick={() => void editSpriteAction(doc, one.id)}>
              <Pencil size={12} /> Править картинку (двойной клик)
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- анимации ----------

/** Проигрыватель анимации: кадры по fps, loop / once / ping-pong. */
function AnimPreview({ anim, state }: { anim: AtlasAnimation; state: AtlasState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = useMemo(() => anim.frames.map((id) => state.sprites.find((s) => s.id === id)?.image).filter((x): x is HTMLCanvasElement => !!x), [anim, state.sprites]);
  useEffect(() => {
    const c = ref.current!;
    if (!frames.length) return;
    const W = Math.max(...frames.map((f) => f.width)), H = Math.max(...frames.map((f) => f.height));
    const box = 96, dpr = window.devicePixelRatio || 1;
    c.width = box * dpr;
    c.height = box * dpr;
    const k = Math.min((box * dpr) / W, (box * dpr) / H, 4 * dpr);
    const seq = anim.mode === 'pingpong' && frames.length > 2 ? [...frames.keys(), ...[...frames.keys()].slice(1, -1).reverse()] : [...frames.keys()];
    let i = 0;
    const draw = () => {
      const ctx = ctx2d(c);
      ctx.clearRect(0, 0, c.width, c.height);
      const f = frames[seq[i]];
      ctx.imageSmoothingEnabled = k < 1;
      // кадры выравниваем по центру общего размера, как в движке
      ctx.drawImage(f, (c.width - W * k) / 2 + ((W - f.width) * k) / 2, (c.height - H * k) / 2 + ((H - f.height) * k) / 2, f.width * k, f.height * k);
      if (anim.mode === 'once' && i === seq.length - 1) return;
      i = (i + 1) % seq.length;
    };
    draw();
    const t = setInterval(draw, 1000 / Math.max(1, anim.fps));
    return () => clearInterval(t);
  }, [frames, anim.fps, anim.mode]);
  return <canvas ref={ref} className="anim-preview" />;
}

export function AnimationsPanel() {
  const doc = useAtlasDoc();
  const [open, setOpen] = useState<string | null>(null);
  if (!doc) return null;
  const a = doc.atlas;
  const byId = new Map(a.sprites.map((s) => [s.id, s]));
  const updAnim = (id: string, patch: Partial<AtlasAnimation>, label: string) => {
    mergeable(doc, label);
    updateAtlas(doc, label, (s) => ({ ...s, animations: s.animations.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    changed();
  };
  return (
    <div className="panel-body list" style={{ maxHeight: 360 }}>
      {a.animations.length === 0 && (
        <div className="note" style={{ padding: 8 }}>
          Анимаций нет. «Найти» соберёт их из имён вида run_0, run_1…; «+» — из выбранных спрайтов.
        </div>
      )}
      {a.animations.map((an) => (
        <div key={an.id} className="anim-item">
          <div className={`slice-row ${open === an.id ? 'active' : ''}`} onClick={() => setOpen(open === an.id ? null : an.id)}>
            <Play size={11} />
            <span>{an.name}</span>
            <span className="dim">
              {an.frames.length} кадр. · {an.fps} fps{an.mode === 'pingpong' ? ' · ↔' : an.mode === 'once' ? ' · 1×' : ''}
            </span>
          </div>
          {open === an.id && (
            <div className="slice-edit">
              <div className="full anim-head">
                <AnimPreview anim={an} state={a} />
                <div className="anim-fields">
                  <TextInput value={an.name} onChange={(v) => updAnim(an.id, { name: v }, 'Имя анимации')} width="100%" />
                  <NumberField label="FPS" value={an.fps} min={1} max={120} width={44} onChange={(v) => updAnim(an.id, { fps: Math.round(v) }, 'FPS анимации')} />
                  <select value={an.mode} onChange={(e) => updAnim(an.id, { mode: e.target.value as AnimMode }, 'Режим анимации')}>
                    <option value="loop">Повтор</option>
                    <option value="pingpong">Туда-обратно</option>
                    <option value="once">Один раз</option>
                  </select>
                </div>
              </div>
              <div className="full anim-frames">
                {an.frames.map((id, i) => {
                  const sp = byId.get(id);
                  return sp ? (
                    <span
                      key={`${id}${i}`}
                      className={`anim-frame ${doc.atlasSel.includes(id) ? 'on' : ''}`}
                      title={`${sp.name} — клик: выделить, ⌥клик: убрать из анимации`}
                      onClick={(e) => {
                        if (e.altKey) updAnim(an.id, { frames: an.frames.filter((_, j) => j !== i) }, 'Кадры анимации');
                        else {
                          doc.atlasSel = [id];
                          changed();
                        }
                      }}
                    >
                      <Thumb image={sp.image} size={24} />
                    </span>
                  ) : null;
                })}
              </div>
              <div className="full row-fields">
                <button className="btn small" disabled={!doc.atlasSel.length} onClick={() => updAnim(an.id, { frames: [...an.frames, ...doc.atlasSel] }, 'Кадры анимации')}>
                  <Plus size={12} /> выбранные
                </button>
                <button className="btn small" onClick={() => (doc.atlasSel = [...an.frames], changed())}>Выделить кадры</button>
                <button
                  className="btn small"
                  onClick={() => {
                    updateAtlas(doc, 'Удалить анимацию', (s) => ({ ...s, animations: s.animations.filter((x) => x.id !== an.id) }));
                    changed();
                  }}
                >
                  <Trash size={12} />
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function AnimationsActions() {
  const doc = useAtlasDoc();
  return (
    <>
      <button
        className="icon-btn"
        title="Найти анимации по номерам в именах (run_0, run_1…)"
        disabled={!doc}
        onClick={() => {
          if (!doc) return;
          const found = detectAnimations(doc.atlas);
          if (found.length) updateAtlas(doc, 'Найти анимации', (s) => ({ ...s, animations: [...s.animations, ...found] }));
          changed();
        }}
      >
        <Wand2 size={13} />
      </button>
      <button
        className="icon-btn"
        title="Анимация из выбранных спрайтов"
        disabled={!doc?.atlasSel.length}
        onClick={() => {
          if (!doc) return;
          const ids = selectedSprites(doc).map((s) => s.id);
          updateAtlas(doc, 'Новая анимация', (s) => ({ ...s, animations: [...s.animations, { id: uid('an'), name: `anim_${s.animations.length + 1}`, fps: 12, mode: 'loop', frames: ids }] }));
          changed();
        }}
      >
        <FolderPlus size={13} />
      </button>
    </>
  );
}

// ---------- выгрузка ----------

export function AtlasExportPanel() {
  const doc = useAtlasDoc();
  if (!doc) return null;
  const e = doc.atlas.export;
  const formats = allSpriteFormats();
  const fmt = formats.find((f) => f.id === e.formatId) ?? formats[0];
  const upd = (patch: Partial<AtlasExport>) => {
    mergeable(doc, 'Настройки выгрузки');
    updateAtlas(doc, 'Настройки выгрузки', (s) => ({ ...s, export: { ...s.export, ...patch } }));
    changed();
  };
  const base = e.name || doc.name.replace(/\.[^.]+$/, '') || 'atlas';
  const pageCount = doc.atlasPack?.pages.length ?? 1;
  return (
    <div className="slice-edit atlas-props">
      <div className="full row-fields">
        <span className="label static">Формат</span>
        <select value={fmt.id} onChange={(ev) => upd({ formatId: ev.target.value })} style={{ flex: 1, minWidth: 0 }}>
          {formats.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
      </div>
      {fmt.rotation === false && doc.atlas.settings.allowRotation && <div className="full note">Формат не поддерживает вращение — оно отключено при упаковке</div>}
      <div className="full row-fields">
        <span className="label static">Картинка</span>
        <select value={e.imageFormat} onChange={(ev) => upd({ imageFormat: ev.target.value as AtlasExport['imageFormat'] })}>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
          <option value="jpg">JPEG</option>
        </select>
        {e.imageFormat !== 'png' && <NumberField label="Кач." value={e.quality} min={1} max={100} width={40} onChange={(v) => upd({ quality: Math.round(v) })} title={e.imageFormat === 'webp' ? '100 = без потерь' : undefined} />}
      </div>
      <div className="full row-fields">
        <span className="label static">Масштабы</span>
      </div>
      {e.scales.map((s, i) => (
        <div key={i} className="full row-fields">
          <Check label={`×${s.scale}`} checked={s.enabled} onChange={(v) => upd({ scales: e.scales.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })} />
          <TextInput value={s.suffix} placeholder="без суффикса" onChange={(v) => upd({ scales: e.scales.map((x, j) => (j === i ? { ...x, suffix: v } : x)) })} width={90} />
          <span className="dim">{base}{s.suffix}{pageCount > 1 ? '-0' : ''}.{IMAGE_EXT[e.imageFormat]}</span>
        </div>
      ))}
      <div className="full">
        <Check label="Сглаживание при масштабе (выкл. — пиксель-арт)" checked={e.smoothScale} onChange={(v) => upd({ smoothScale: v })} />
      </div>
      <div className="full row-fields">
        <span className="label static">Имя</span>
        <TextInput value={e.name} placeholder={base} onChange={(v) => upd({ name: v })} width="100%" />
      </div>
      <div className="full row-fields">
        <span className="label static">Куда</span>
        <select value={e.output} onChange={(ev) => upd({ output: ev.target.value as AtlasExport['output'] })}>
          <option value="folder">В папку</option>
          <option value="zip">В ZIP</option>
        </select>
        <button className="btn primary small" style={{ marginLeft: 'auto' }} onClick={() => void exportAtlasAction(doc)}>
          <Upload size={12} /> Выгрузить
        </button>
      </div>
      <div className="full note">Настройки хранятся в проекте; последние используются для новых атласов.</div>
    </div>
  );
}
