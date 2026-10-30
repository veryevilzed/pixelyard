import { useEffect, useRef } from 'react';
import { focusPaneAction } from '../actions';
import { paneSizes, paneSize } from '../panes';
import { ctx2d } from '../core/canvas';
import type { Doc } from '../core/doc';
import { clampView, compositeForView, fitView, renderView, RULER, toDoc, zoomAt } from '../core/render';
import type { Cuts } from '../core/types';
import { usePatterns } from '../core/patterns';
import { activeDoc, app, setPrefs, useApp, useCursor } from '../store';
import { changed, getPickHook, onRenderRequest, snapPoint, type PointerInfo, type Tool } from '../tools/base';
import { commitText, handTool, textFont, useTextEdit } from '../tools/fill';
import { effectiveTool } from '../tools';
import { useTransform } from '../tools/transform';
import { useCrop } from '../tools/crop';

/** Пробел зажат — временно «рука». */
let spaceDown = false;

export function Viewport({ paneId }: { paneId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeId = useApp((s) => s.activeId);
  const isFocused = useApp((s) => s.focusedPane === paneId);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    /** Документ, показанный в этой области. */
    const paneDoc = (): Doc | null => {
      const s = app();
      const pane = s.panes.find((p) => p.id === paneId);
      return s.docs.find((d) => d.id === pane?.activeId) ?? null;
    };
    const focused = () => app().focusedPane === paneId;
    let frame = 0;
    let ants = 0;
    let lastComposite: HTMLCanvasElement | null = null;

    const draw = () => {
      frame = 0;
      // раскладка могла смениться раньше, чем сработал ResizeObserver (сплит/объединение)
      const wr = wrap.getBoundingClientRect();
      const known = paneSizes.get(paneId);
      if (!known || known.w !== wr.width || known.h !== wr.height) resize(false);
      const doc = paneDoc();
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d')!;
      if (!doc) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#1b1b1d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }
      if (doc.needsFit) {
        const sz = paneSize(paneId);
        doc.view = fitView(doc, sz.w, sz.h);
        doc.needsFit = false;
      }
      if (app().prefs.clampPan) {
        const sz = paneSize(paneId);
        doc.view = clampView(doc.view, doc.width, doc.height, sz.w, sz.h, app().prefs.rulers ? RULER : 0);
      }
      // оверлеи инструмента (круг кисти, рамки) — только в области, где идёт работа
      const tool = focused() ? currentTool() : null;
      lastComposite = compositeForView(doc);
      renderView(canvas, {
        doc,
        view: doc.view,
        prefs: app().prefs,
        dpr,
        antsOffset: ants,
        composite: lastComposite,
        hideSelection: tool?.hidesSelection?.() ?? false,
        overlay: (c, v) => tool?.overlay?.(c, v, doc),
        cursor: cursorDoc,
        draftGuide: guideDrag && guideDrag.inside ? { axis: guideDrag.axis, value: guideDrag.value } : null,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const offRender = onRenderRequest(schedule);

    const resize = (redraw = true) => {
      const dpr = window.devicePixelRatio || 1;
      const r = wrap.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const prev = paneSizes.get(paneId) ?? { w: r.width, h: r.height };
      paneSizes.set(paneId, { w: r.width, h: r.height });
      const prevW = prev.w, prevH = prev.h;
      // при изменении размера области её документы остаются по центру
      const pane = app().panes.find((p) => p.id === paneId);
      for (const d of app().docs) {
        if (!pane?.docIds.includes(d.id)) continue;
        d.view = { ...d.view, panX: d.view.panX + (r.width - prevW) / 2, panY: d.view.panY + (r.height - prevH) / 2 };
      }
      if (redraw) schedule();
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    resize();

    const unsub = useApp.subscribe((s, p) => {
      if (s.tick !== p.tick || s.prefs !== p.prefs || s.activeId !== p.activeId || s.opts !== p.opts || s.panes !== p.panes || s.focusedPane !== p.focusedPane) schedule();
    });
    const unsubT = useTransform.subscribe(schedule);
    const unsubC = useCrop.subscribe(schedule);
    const unsubP = usePatterns.subscribe(schedule);

    // «бегущие муравьи»
    const antsTimer = window.setInterval(() => {
      if (paneDoc()?.selection) {
        ants = (ants + 1) % 8;
        schedule();
      }
    }, 110);

    // ---------- указатель ----------
    let dragging: { tool: Tool; pointerId: number } | null = null;
    let lastInfo: PointerInfo | null = null;
    let cursorDoc: { x: number; y: number } | null = null;
    /** Перетаскивание направляющей: новой (index = -1, из линейки) или существующей. */
    let guideDrag: { axis: 'x' | 'y'; index: number; orig: Cuts; value: number; inside: boolean; pointerId: number } | null = null;

    const inRuler = (p: PointerInfo) => app().prefs.rulers && (p.sx < RULER || p.sy < RULER);
    const hitGuide = (p: PointerInfo, doc: Doc) => {
      const { prefs } = app();
      if (!prefs.guides || prefs.lockGuides) return null;
      const tol = 4 / doc.view.zoom;
      for (const axis of ['x', 'y'] as const) {
        const i = doc.guides[axis].findIndex((v) => Math.abs((axis === 'x' ? p.x : p.y) - v) <= tol);
        if (i >= 0) return { axis, index: i };
      }
      return null;
    };
    const guideValue = (p: PointerInfo, doc: Doc, axis: 'x' | 'y') => {
      const sp = snapPoint(p, doc.view);
      return axis === 'x' ? sp.x : sp.y;
    };

    const info = (e: PointerEvent | MouseEvent, doc: Doc): PointerInfo => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const p = toDoc(doc.view, { x: sx, y: sy });
      const pe = e as PointerEvent;
      return {
        x: p.x,
        y: p.y,
        sx,
        sy,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        pressure: pe.pointerType === 'pen' ? pe.pressure : 1,
        pointerType: pe.pointerType ?? 'mouse',
        button: e.button,
        detail: e.detail,
      };
    };

    const updateCursor = (p: PointerInfo | null, doc: Doc) => {
      const t = dragging?.tool ?? currentTool();
      canvas.style.cursor = t.cursor?.(p, doc) ?? 'default';
    };

    const updateInfo = (p: PointerInfo, doc: Doc) => {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      const inside = x >= 0 && y >= 0 && x < doc.width && y < doc.height;
      let color = null;
      if (inside && lastComposite) {
        const d = ctx2d(lastComposite).getImageData(x, y, 1, 1).data;
        color = [d[0], d[1], d[2], d[3]] as [number, number, number, number];
      }
      useCursor.setState({ x, y, inside, color });
    };

    const onDown = (e: PointerEvent) => {
      // клик в другую область переводит туда фокус (и активный документ)
      if (!focused()) focusPaneAction(paneId);
      const doc = paneDoc();
      if (!doc) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      const p = info(e, doc);
      if (e.button === 0 && !spaceDown && !getPickHook()) {
        // направляющая: из линейки — новая; инструментом «Перемещение» или с ⌘ — существующая
        const hit = !inRuler(p) && (app().tool === 'move' || e.metaKey) ? hitGuide(p, doc) : null;
        if (inRuler(p) || hit) {
          if (inRuler(p) && p.sx < RULER && p.sy < RULER) return;
          const axis = hit ? hit.axis : p.sy < RULER ? 'y' : 'x';
          const orig = doc.guides;
          if (hit) doc.guides = { ...orig, [axis]: orig[axis].filter((_, i) => i !== hit.index) };
          if (!app().prefs.guides) setPrefs({ guides: true });
          guideDrag = { axis, index: hit ? hit.index : -1, orig, value: guideValue(p, doc, axis), inside: !!hit, pointerId: e.pointerId };
          canvas.setPointerCapture(e.pointerId);
          schedule();
          return;
        }
      }
      const pick = getPickHook();
      if (pick && e.button === 0 && !spaceDown) {
        pick(p.x, p.y, p);
        return;
      }
      // средняя кнопка или пробел — панорамирование любым инструментом
      const tool = e.button === 1 || spaceDown ? handTool : currentTool();
      if (e.button === 2) return;
      canvas.setPointerCapture(e.pointerId);
      dragging = { tool, pointerId: e.pointerId };
      lastInfo = p;
      if (e.detail === 2 && tool.dblclick) tool.dblclick(p, doc);
      else tool.down?.(p, doc);
      updateCursor(p, doc);
    };

    const onMove = (e: PointerEvent) => {
      const doc = paneDoc();
      if (!doc) return;
      if (guideDrag && e.pointerId === guideDrag.pointerId) {
        const p = info(e, doc);
        guideDrag.value = guideValue(p, doc, guideDrag.axis);
        // над линейкой направляющая «снимается»
        guideDrag.inside = !inRuler(p);
        canvas.style.cursor = guideDrag.axis === 'x' ? 'col-resize' : 'row-resize';
        cursorDoc = { x: p.x, y: p.y };
        updateInfo(p, doc);
        schedule();
        return;
      }
      if (dragging && e.pointerId === dragging.pointerId) {
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const ce of events.length ? events : [e]) dragging.tool.drag?.(info(ce, doc), doc);
        lastInfo = info(e, doc);
      } else {
        const p = info(e, doc);
        lastInfo = p;
        cursorDoc = { x: p.x, y: p.y };
        if (inRuler(p)) {
          canvas.style.cursor = 'default';
          if (app().prefs.rulers) schedule();
          updateInfo(p, doc);
          return;
        }
        if (focused()) (spaceDown ? handTool : currentTool()).hover?.(p, doc);
        updateCursor(p, doc);
        const g = app().tool === 'move' || e.metaKey ? hitGuide(p, doc) : null;
        if (g) canvas.style.cursor = g.axis === 'x' ? 'col-resize' : 'row-resize';
        if (app().prefs.rulers) schedule();
      }
      updateInfo(lastInfo, doc);
    };

    const onUp = (e: PointerEvent) => {
      const doc = paneDoc();
      if (guideDrag && e.pointerId === guideDrag.pointerId) {
        const g = guideDrag;
        guideDrag = null;
        if (doc) {
          doc.guides = g.orig;
          const list = g.orig[g.axis].filter((_, i) => i !== g.index);
          if (g.inside) list.push(g.value);
          const label = g.index < 0 ? 'Новая направляющая' : g.inside ? 'Переместить направляющую' : 'Удалить направляющую';
          if (g.index >= 0 || g.inside) doc.setGuides({ ...g.orig, [g.axis]: list }, label);
          changed();
        }
        return;
      }
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      const t = dragging.tool;
      dragging = null;
      if (doc) {
        const p = info(e, doc);
        t.up?.(p, doc);
        updateCursor(p, doc);
      }
    };

    const onLeave = () => {
      useCursor.setState({ inside: false });
      cursorDoc = null;
      schedule();
      const doc = paneDoc();
      if (!dragging && doc && focused()) {
        // скрываем круг кисти, когда курсор ушёл с холста
        currentTool().hover?.({ ...(lastInfo ?? info(new MouseEvent('move'), doc)), x: -1e6, y: -1e6, sx: -1e6, sy: -1e6 }, doc);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const doc = paneDoc();
      if (!doc) return;
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      // pinch на трекпаде приходит как wheel с ctrlKey
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        doc.view = zoomAt(doc.view, doc.view.zoom * k, sx, sy);
      } else {
        const scale = e.deltaMode === 1 ? 16 : 1;
        doc.view = { ...doc.view, panX: doc.view.panX - e.deltaX * scale, panY: doc.view.panY - e.deltaY * scale };
      }
      schedule();
      changed();
    };

    // Safari: жест pinch без ctrlKey
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = paneDoc()?.view.zoom ?? 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const doc = paneDoc();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      if (!doc) return;
      const r = canvas.getBoundingClientRect();
      doc.view = zoomAt(doc.view, gestureStart * ge.scale, ge.clientX - r.left, ge.clientY - r.top);
      changed();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping()) {
        if (!spaceDown) {
          spaceDown = true;
          canvas.style.cursor = 'grab';
        }
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown = false;
        const doc = paneDoc();
        if (doc) updateCursor(lastInfo, doc);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGestureStart);
    canvas.addEventListener('gesturechange', onGestureChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      offRender();
      paneSizes.delete(paneId);
      ro.disconnect();
      unsub();
      unsubT();
      unsubC();
      unsubP();
      clearInterval(antsTimer);
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGestureStart);
      canvas.removeEventListener('gesturechange', onGestureChange);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [paneId]);

  return (
    <div className="viewport" data-pane={paneId} ref={wrapRef}>
      <canvas ref={canvasRef} />
      {isFocused && activeId && <TextEditor />}
    </div>
  );
}

function currentTool() {
  return effectiveTool(app().tool);
}

export function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);
}

/** Поле ввода текста поверх холста для инструмента «Текст». */
function TextEditor() {
  const at = useTextEdit((s) => s.at);
  const value = useTextEdit((s) => s.value);
  useApp((s) => s.tick);
  const opts = useApp((s) => s.opts);
  const fg = useApp((s) => s.fg);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (at) setTimeout(() => ref.current?.focus(), 0);
  }, [at]);
  const doc = activeDoc();
  if (!at || !doc) return null;
  const v = doc.view;
  const lines = value.split('\n');
  const fontPx = opts.textSize * v.zoom;
  const longest = Math.max(4, ...lines.map((l) => l.length));
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      spellCheck={false}
      style={{
        left: v.panX + at.x * v.zoom,
        top: v.panY + at.y * v.zoom,
        font: textFont().replace(`${opts.textSize}px`, `${fontPx}px`),
        color: `rgb(${fg[0]},${fg[1]},${fg[2]})`,
        width: longest * fontPx * 0.65 + 20,
        height: lines.length * fontPx * 1.25 + 4,
      }}
      onChange={(e) => useTextEdit.setState({ value: e.target.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') useTextEdit.setState({ at: null, value: '' });
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitText(doc);
      }}
      onBlur={() => commitText(doc)}
    />
  );
}
