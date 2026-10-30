import type { PackedFrame } from './pack';

/**
 * Форматы описания спрайтшитов и растровых шрифтов + простой шаблонизатор
 * для своих форматов.
 *
 * Синтаксис шаблона (подмножество Mustache):
 *   {{var}}                — значение
 *   {{#frames}}…{{/frames}} — повтор для каждого кадра (в шрифтах — {{#chars}}, {{#kernings}})
 *   {{^last}}, {{/last}}    — блок, если это НЕ последний элемент (разделители)
 *   {{#trimmed}}…{{/trimmed}} — блок, если значение истинно
 */

export interface AtlasMeta {
  image: string;
  width: number;
  height: number;
  scale: number;
  app: string;
  /** Номер страницы и их число (многостраничный атлас). */
  page?: number;
  pageCount?: number;
}

export interface FormatDef {
  id: string;
  label: string;
  ext: string;
  /** Для каких данных: спрайты или шрифт. */
  kind: 'sprites' | 'font';
  render(data: TemplateData): string;
  /** Шаблон, если формат задан пользователем (или для «взять за основу»). */
  template?: string;
  /** Направление поворота повёрнутых кадров; false — формат вращение не поддерживает. По умолчанию cw. */
  rotation?: 'cw' | 'ccw' | false;
  /** Один файл описания на страницу (по умолчанию) или один на весь атлас (data.pages). */
  multi?: 'per-page' | 'single';
  /** Дополнительные файлы (например, анимации): имя → текст. base — имя без расширения. */
  extraFiles?(data: TemplateData, base: string): Record<string, string>;
}

export type TemplateValue = string | number | boolean | TemplateData[] | undefined;
export interface TemplateData {
  [key: string]: TemplateValue;
}

// ---------- шаблонизатор ----------

/** Подставляет данные в шаблон. Неизвестные переменные становятся пустой строкой. */
export function renderTemplate(tpl: string, data: TemplateData): string {
  const section = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
  const withSections = tpl.replace(section, (_, kind: string, key: string, body: string) => {
    const v = data[key];
    if (Array.isArray(v)) {
      if (kind === '^') return v.length ? '' : body;
      return v.map((item, i) => renderTemplate(body, { ...data, ...item, index: i, first: i === 0, last: i === v.length - 1 })).join('');
    }
    const truthy = !!v && v !== '0';
    return (kind === '#') === truthy ? renderTemplate(body, data) : '';
  });
  return withSections.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = data[key];
    return v === undefined || Array.isArray(v) ? '' : String(v);
  });
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonStr = (s: string) => JSON.stringify(s);

// ---------- данные кадров ----------

/**
 * Данные кадров одной страницы для шаблона. Атласные свойства спрайта приходят в `extra`:
 * pivotX/pivotY (0..1), nineL/nineT/nineR/nineB (9-slice, в пикселях исходного кадра).
 */
export function spriteTemplateData(frames: PackedFrame[], meta: AtlasMeta): TemplateData {
  const list = frames.filter((f) => f.w > 0 || f.srcW > 0);
  return {
    ...meta,
    page: meta.page ?? 0,
    pageCount: meta.pageCount ?? 1,
    count: list.length,
    frames: list.map((f) => {
      const e = f.extra ?? {};
      const nine = ['nineL', 'nineT', 'nineR', 'nineB'].some((k) => Number(e[k]) > 0);
      return {
        name: f.name,
        nameXml: xmlEsc(f.name),
        nameJson: jsonStr(f.name),
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        // размер так, как кадр лежит в атласе (с учётом поворота)
        atlasW: f.rotated ? f.h : f.w,
        atlasH: f.rotated ? f.w : f.h,
        offX: f.offX,
        offY: f.offY,
        // смещение от центра (Cocos)
        offCX: f.offX + f.w / 2 - f.srcW / 2,
        offCY: f.srcH / 2 - (f.offY + f.h / 2),
        srcW: f.srcW,
        srcH: f.srcH,
        trimmed: f.trimmed,
        rotated: !!f.rotated,
        page: f.page ?? 0,
        pivotX: 0.5,
        pivotY: 0.5,
        nineL: 0,
        nineT: 0,
        nineR: 0,
        nineB: 0,
        ...e,
        nine,
      };
    }),
  };
}

export interface AtlasPageInfo {
  image: string;
  width: number;
  height: number;
  frames: PackedFrame[];
}

/** Данные для формата: поля первой страницы + `pages` (для однофайловых форматов). */
export function atlasTemplateData(pages: AtlasPageInfo[], scale: number, extra: TemplateData = {}): TemplateData[] {
  const per = pages.map((p, i) => ({ ...spriteTemplateData(p.frames, { image: p.image, width: p.width, height: p.height, scale, app: 'PixelYard', page: i, pageCount: pages.length }), ...extra }));
  const related = pages.map((p) => p.image);
  return per.map((d) => ({ ...d, pages: per, related: related.filter((r) => r !== d.image).join(',') }));
}

/** Имя страницы: одна — без номера, иначе name-0, name-1… */
export const pageBase = (base: string, i: number, count: number) => (count > 1 ? `${base}-${i}` : base);

/** Файлы описания атласа в выбранном формате: имя → текст. */
export function describeAtlas(format: FormatDef, pages: AtlasPageInfo[], base: string, scale: number, extra: TemplateData = {}): Record<string, string> {
  const data = atlasTemplateData(pages, scale, extra);
  const out: Record<string, string> = {};
  if (format.multi === 'single') out[`${base}.${format.ext}`] = format.render(data[0]);
  else data.forEach((d, i) => (out[`${pageBase(base, i, data.length)}.${format.ext}`] = format.render(d)));
  if (format.extraFiles) Object.assign(out, format.extraFiles(data[0], base));
  return out;
}

// ---------- встроенные форматы спрайтов ----------

type Frame = TemplateData & {
  name: string; x: number; y: number; w: number; h: number; atlasW: number; atlasH: number;
  offX: number; offY: number; srcW: number; srcH: number; trimmed: boolean; rotated: boolean; page: number;
  pivotX: number; pivotY: number; nine: boolean; nineL: number; nineT: number; nineR: number; nineB: number;
};
const framesOf = (d: TemplateData) => d.frames as Frame[];
const pagesOf = (d: TemplateData) => (d.pages as TemplateData[] | undefined) ?? [d];

/** Кадр в стиле TexturePacker JSON (Pixi, Phaser): размеры без поворота, поворот по часовой. */
const tpFrame = (f: Frame) => ({
  frame: { x: f.x, y: f.y, w: f.w, h: f.h },
  rotated: f.rotated,
  trimmed: f.trimmed,
  spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
  sourceSize: { w: f.srcW, h: f.srcH },
  pivot: { x: f.pivotX, y: f.pivotY },
  ...(f.nine ? { scale9Borders: { x: f.nineL, y: f.nineT, w: f.srcW - f.nineL - f.nineR, h: f.srcH - f.nineT - f.nineB } } : {}),
});
type Anim = { name: string; fps: number; loop: boolean; pingpong: boolean; mode: string; frames: { name: string }[] };
const animsOf = (d: TemplateData) => ((d.animations as unknown as Anim[] | undefined) ?? []);
/** Pixi / TexturePacker: "animations": { run: ["run_0", …] } */
const tpAnims = (d: TemplateData) => {
  const a = animsOf(d);
  return a.length ? { animations: Object.fromEntries(a.map((x) => [x.name, x.frames.map((f) => f.name)])) } : {};
};
const tpMeta = (d: TemplateData) => ({
  app: d.app,
  version: '1.0',
  image: d.image,
  format: 'RGBA8888',
  size: { w: d.width, h: d.height },
  scale: String(d.scale),
  ...(Number(d.pageCount) > 1 ? { related_multi_packs: String(d.related).split(',').map((r) => r.replace(/\.\w+$/, '.json')) } : {}),
});

export const SPRITE_FORMATS: FormatDef[] = [
  {
    id: 'tp-hash',
    label: 'JSON Hash (TexturePacker, Pixi, Phaser 2)',
    ext: 'json',
    kind: 'sprites',
    rotation: 'cw',
    render: (d) => JSON.stringify({ frames: Object.fromEntries(framesOf(d).map((f) => [f.name, tpFrame(f)])), ...tpAnims(d), meta: tpMeta(d) }, null, 2),
  },
  {
    id: 'tp-array',
    label: 'JSON Array (TexturePacker)',
    ext: 'json',
    kind: 'sprites',
    rotation: 'cw',
    render: (d) => JSON.stringify({ frames: framesOf(d).map((f) => ({ filename: f.name, ...tpFrame(f) })), ...tpAnims(d), meta: tpMeta(d) }, null, 2),
  },
  {
    id: 'phaser3',
    label: 'Phaser 3 (multiatlas JSON)',
    ext: 'json',
    kind: 'sprites',
    rotation: 'cw',
    multi: 'single',
    render: (d) =>
      JSON.stringify(
        {
          textures: pagesOf(d).map((p) => ({
            image: p.image,
            format: 'RGBA8888',
            size: { w: p.width, h: p.height },
            scale: p.scale,
            frames: framesOf(p).map((f) => ({ filename: f.name, ...tpFrame(f) })),
          })),
          meta: { app: d.app, version: '3.0' },
        },
        null,
        2,
      ),
    extraFiles(d, base) {
      const a = animsOf(d);
      if (!a.length) return {};
      // this.load.multiatlas(base, …); this.anims.fromJSON(cache.json.get(base + '-anims'))
      const anims = a.map((x) => ({
        key: x.name,
        type: 'frame',
        frames: x.frames.map((f) => ({ key: base, frame: f.name })),
        frameRate: x.fps,
        repeat: x.loop ? -1 : 0,
        yoyo: x.pingpong,
      }));
      return { [`${base}-anims.json`]: JSON.stringify({ anims }, null, 2) };
    },
  },
  {
    id: 'spine',
    label: 'Spine / libGDX (.atlas)',
    ext: 'atlas',
    kind: 'sprites',
    // libGDX: rotate: true — регион повёрнут на 90° против часовой, size — без поворота
    rotation: 'ccw',
    multi: 'single',
    render: (d) =>
      pagesOf(d)
        .flatMap((p) => [
          '',
          String(p.image),
          `size: ${p.width},${p.height}`,
          'format: RGBA8888',
          'filter: Linear,Linear',
          'repeat: none',
          ...framesOf(p).flatMap((f) => [
            // имя оставляем полным (Spine ищет вложения по имени), номер кадра анимации — в index
            f.name,
            `  rotate: ${f.rotated}`,
            `  xy: ${f.x}, ${f.y}`,
            `  size: ${f.w}, ${f.h}`,
            ...(f.nine ? [`  split: ${f.nineL}, ${f.nineR}, ${f.nineT}, ${f.nineB}`] : []),
            `  orig: ${f.srcW}, ${f.srcH}`,
            // libGDX считает смещение от нижнего края
            `  offset: ${f.offX}, ${f.srcH - f.offY - f.h}`,
            `  index: ${f.index ?? -1}`,
          ]),
        ])
        .concat([''])
        .join('\n'),
  },
  {
    id: 'starling',
    label: 'Starling / Sparrow XML',
    ext: 'xml',
    kind: 'sprites',
    rotation: 'cw',
    render: (d) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<TextureAtlas imagePath="${xmlEsc(String(d.image))}" width="${d.width}" height="${d.height}">`,
        ...framesOf(d).map((f) =>
          // Starling: width/height — как регион лежит в атласе
          `  <SubTexture name="${xmlEsc(f.name)}" x="${f.x}" y="${f.y}" width="${f.atlasW}" height="${f.atlasH}"` +
          (f.rotated ? ' rotated="true"' : '') +
          (f.trimmed ? ` frameX="${-f.offX}" frameY="${-f.offY}" frameWidth="${f.srcW}" frameHeight="${f.srcH}"` : '') +
          (f.pivotX !== 0.5 || f.pivotY !== 0.5 ? ` pivotX="${f.pivotX * f.srcW}" pivotY="${f.pivotY * f.srcH}"` : '') +
          '/>',
        ),
        '</TextureAtlas>',
        '',
      ].join('\n'),
  },
  {
    id: 'cocos',
    label: 'Cocos2d (.plist, формат 2)',
    ext: 'plist',
    kind: 'sprites',
    rotation: 'cw',
    render: (d) => {
      const fr = framesOf(d).map((f) => {
        const ox = f.offX + f.w / 2 - f.srcW / 2, oy = f.srcH / 2 - (f.offY + f.h / 2);
        return `        <key>${xmlEsc(f.name)}</key>
        <dict>
            <key>frame</key><string>{{${f.x},${f.y}},{${f.w},${f.h}}}</string>
            <key>offset</key><string>{${ox},${oy}}</string>
            <key>rotated</key>${f.rotated ? '<true/>' : '<false/>'}
            <key>sourceColorRect</key><string>{{${f.offX},${f.offY}},{${f.w},${f.h}}}</string>
            <key>sourceSize</key><string>{${f.srcW},${f.srcH}}</string>
        </dict>`;
      });
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>frames</key>
    <dict>
${fr.join('\n')}
    </dict>
    <key>metadata</key>
    <dict>
        <key>format</key><integer>2</integer>
        <key>realTextureFileName</key><string>${xmlEsc(String(d.image))}</string>
        <key>size</key><string>{${d.width},${d.height}}</string>
        <key>textureFileName</key><string>${xmlEsc(String(d.image))}</string>
    </dict>
</dict>
</plist>
`;
    },
  },
  {
    id: 'unity-tpsheet',
    label: 'Unity (.tpsheet, TexturePacker Importer)',
    ext: 'tpsheet',
    kind: 'sprites',
    // импортёр Unity повёрнутые кадры не поддерживает
    rotation: false,
    render: (d) => {
      const H = Number(d.height);
      const lines = framesOf(d).map((f) => {
        // у Unity начало координат снизу; опорная точка — относительно обрезанного кадра, тоже снизу
        const y = H - f.y - f.h;
        const px = (f.pivotX * f.srcW - f.offX) / Math.max(1, f.w);
        const py = ((1 - f.pivotY) * f.srcH - (f.srcH - f.offY - f.h)) / Math.max(1, f.h);
        const bl = Math.max(0, f.nineL - f.offX), br = Math.max(0, f.nineR - (f.srcW - f.offX - f.w));
        const bt = Math.max(0, f.nineT - f.offY), bb = Math.max(0, f.nineB - (f.srcH - f.offY - f.h));
        const r = (v: number) => Math.round(v * 10000) / 10000;
        return `${f.name.replace(/[;\s]/g, '_')};${f.x};${y};${f.w};${f.h}; ${r(px)};${r(py)}; ${bl};${br};${bt};${bb}`;
      });
      return [
        '#',
        '# Sprite sheet data for Unity.',
        '#',
        '# To import these sprites into your Unity project, download "TexturePackerImporter":',
        '# https://www.codeandweb.com/texturepacker/unity',
        '#',
        `# Created by ${d.app}`,
        '#',
        ':format=40300',
        `:texture=${d.image}`,
        `:size=${d.width}x${d.height}`,
        ':pivotpoints=enabled',
        ':borders=enabled',
        ':alphahandling=ClearTransparentPixels',
        '',
        ...lines,
        '',
      ].join('\n');
    },
  },
  {
    id: 'godot-spriteframes',
    label: 'Godot 4 (SpriteFrames .tres)',
    ext: 'tres',
    kind: 'sprites',
    rotation: false,
    multi: 'single',
    render: (d) => {
      const pages = pagesOf(d);
      const ext = pages.map((p, i) => `[ext_resource type="Texture2D" path="${p.image}" id="${i + 1}_page"]`);
      const subs: string[] = [];
      const idOf = new Map<string, string>();
      pages.forEach((p, pi) =>
        framesOf(p).forEach((f) => {
          const id = `AtlasTexture_${subs.length + 1}`;
          idOf.set(f.name, id);
          // margin восстанавливает исходный размер обрезанного кадра
          subs.push(
            `[sub_resource type="AtlasTexture" id="${id}"]\natlas = ExtResource("${pi + 1}_page")\nregion = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})` +
              (f.trimmed ? `\nmargin = Rect2(${f.offX}, ${f.offY}, ${f.srcW - f.w}, ${f.srcH - f.h})` : '') +
              '\nfilter_clip = true',
          );
        }),
      );
      const anims = animsOf(d);
      const inAnim = new Set(anims.flatMap((a) => a.frames.map((f) => f.name)));
      // спрайты вне анимаций — анимации из одного кадра, чтобы каждый был доступен по имени
      const list = [
        ...anims.map((a) => ({ name: a.name, fps: a.fps, loop: a.loop, frames: a.pingpong && a.frames.length > 2 ? [...a.frames, ...a.frames.slice(1, -1).reverse()] : a.frames })),
        ...pages.flatMap((p) => framesOf(p)).filter((f) => !inAnim.has(f.name)).map((f) => ({ name: f.name, fps: 5, loop: false, frames: [{ name: f.name }] })),
      ];
      const animText = list
        .map(
          (a) =>
            `{\n"frames": [${a.frames.filter((f) => idOf.has(f.name)).map((f) => `{\n"duration": 1.0,\n"texture": SubResource("${idOf.get(f.name)}")\n}`).join(', ')}],\n"loop": ${a.loop},\n"name": &${JSON.stringify(a.name)},\n"speed": ${a.fps.toFixed(1)}\n}`,
        )
        .join(', ');
      return [
        `[gd_resource type="SpriteFrames" load_steps=${ext.length + subs.length + 1} format=3]`,
        '',
        ...ext,
        '',
        ...subs.flatMap((x) => [x, '']),
        '[resource]',
        `animations = [${animText}]`,
        '',
      ].join('\n');
    },
  },
  {
    id: 'css',
    label: 'CSS-спрайты',
    ext: 'css',
    kind: 'sprites',
    rotation: false,
    template: `.sprite {
  display: inline-block;
  background-image: url("{{image}}");
  background-repeat: no-repeat;
}
{{#frames}}
.sprite-{{name}} {
  width: {{w}}px;
  height: {{h}}px;
  background-position: -{{x}}px -{{y}}px;
}
{{/frames}}`,
    render(d) {
      return renderTemplate(this.template!, { ...d, frames: framesOf(d).map((f) => ({ ...f, name: f.name.replace(/[^\w-]+/g, '-') })) });
    },
  },
  {
    id: 'csv',
    label: 'CSV (name,x,y,w,h,…)',
    ext: 'csv',
    kind: 'sprites',
    rotation: 'cw',
    template: `name,page,x,y,w,h,rotated,offsetX,offsetY,sourceW,sourceH,pivotX,pivotY
{{#frames}}{{name}},{{page}},{{x}},{{y}},{{w}},{{h}},{{rotated}},{{offX}},{{offY}},{{srcW}},{{srcH}},{{pivotX}},{{pivotY}}
{{/frames}}`,
    render(d) {
      return renderTemplate(this.template!, d);
    },
  },
];

/** Пример своего шаблона спрайтов — подсказка в редакторе. */
export const SPRITE_TEMPLATE_EXAMPLE = `{
  "image": "{{image}}",
  "size": [{{width}}, {{height}}],
  "sprites": {
{{#frames}}    "{{name}}": [{{x}}, {{y}}, {{w}}, {{h}}]{{^last}},{{/last}}
{{/frames}}  }
}`;

export const SPRITE_VARS: [string, string][] = [
  ['{{image}}', 'имя файла атласа'],
  ['{{width}} {{height}}', 'размер атласа'],
  ['{{scale}}', 'масштаб (1, 2…)'],
  ['{{count}}', 'число кадров'],
  ['{{#frames}}…{{/frames}}', 'повтор для каждого кадра'],
  ['{{name}}', 'имя кадра ({{nameJson}} — в кавычках, {{nameXml}} — для XML)'],
  ['{{x}} {{y}} {{w}} {{h}}', 'положение в атласе (w/h без поворота)'],
  ['{{atlasW}} {{atlasH}}', 'размер в атласе с учётом поворота'],
  ['{{#rotated}}…{{/rotated}}', 'кадр повёрнут на 90° по часовой'],
  ['{{page}} {{pageCount}}', 'номер страницы и их число'],
  ['{{pivotX}} {{pivotY}}', 'опорная точка 0..1'],
  ['{{#nine}}…{{/nine}}', '9-slice: {{nineL}} {{nineT}} {{nineR}} {{nineB}}'],
  ['{{offX}} {{offY}}', 'смещение обрезанной части в исходном кадре'],
  ['{{srcW}} {{srcH}}', 'исходный размер кадра'],
  ['{{index}}', 'номер кадра с 0'],
  ['{{^last}},{{/last}}', 'разделитель между элементами'],
  ['{{#trimmed}}…{{/trimmed}}', 'блок, если кадр обрезан'],
];

// ---------- свои форматы (localStorage) ----------

export interface CustomFormat {
  id: string;
  label: string;
  ext: string;
  kind: 'sprites' | 'font';
  template: string;
}

const KEY = 'pixelyard.formats';

export function loadCustomFormats(): CustomFormat[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CustomFormat[];
  } catch {
    return [];
  }
}

export function saveCustomFormats(list: CustomFormat[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function customToDef(c: CustomFormat): FormatDef {
  return { id: c.id, label: `${c.label} (свой)`, ext: c.ext, kind: c.kind, template: c.template, render: (d) => renderTemplate(c.template, d) };
}
