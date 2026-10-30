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

export function spriteTemplateData(frames: PackedFrame[], meta: AtlasMeta): TemplateData {
  return {
    ...meta,
    count: frames.length,
    frames: frames.map((f) => ({
      name: f.name,
      nameXml: xmlEsc(f.name),
      nameJson: jsonStr(f.name),
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      offX: f.offX,
      offY: f.offY,
      // смещение от центра (Cocos)
      offCX: f.offX + f.w / 2 - f.srcW / 2,
      offCY: f.srcH / 2 - (f.offY + f.h / 2),
      srcW: f.srcW,
      srcH: f.srcH,
      trimmed: f.trimmed,
      ...(f.extra ?? {}),
    })),
  };
}

// ---------- встроенные форматы спрайтов ----------

type Frame = TemplateData & { name: string; x: number; y: number; w: number; h: number; offX: number; offY: number; srcW: number; srcH: number; trimmed: boolean };
const framesOf = (d: TemplateData) => d.frames as Frame[];

export const SPRITE_FORMATS: FormatDef[] = [
  {
    id: 'tp-hash',
    label: 'JSON Hash (TexturePacker, Pixi, Phaser 2)',
    ext: 'json',
    kind: 'sprites',
    render: (d) =>
      JSON.stringify(
        {
          frames: Object.fromEntries(
            framesOf(d).map((f) => [f.name, {
              frame: { x: f.x, y: f.y, w: f.w, h: f.h },
              rotated: false,
              trimmed: f.trimmed,
              spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
              sourceSize: { w: f.srcW, h: f.srcH },
            }]),
          ),
          meta: { app: d.app, version: '1.0', image: d.image, format: 'RGBA8888', size: { w: d.width, h: d.height }, scale: String(d.scale) },
        },
        null,
        2,
      ),
  },
  {
    id: 'tp-array',
    label: 'JSON Array (TexturePacker)',
    ext: 'json',
    kind: 'sprites',
    render: (d) =>
      JSON.stringify(
        {
          frames: framesOf(d).map((f) => ({
            filename: f.name,
            frame: { x: f.x, y: f.y, w: f.w, h: f.h },
            rotated: false,
            trimmed: f.trimmed,
            spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
            sourceSize: { w: f.srcW, h: f.srcH },
          })),
          meta: { app: d.app, version: '1.0', image: d.image, format: 'RGBA8888', size: { w: d.width, h: d.height }, scale: String(d.scale) },
        },
        null,
        2,
      ),
  },
  {
    id: 'phaser3',
    label: 'Phaser 3 (multiatlas JSON)',
    ext: 'json',
    kind: 'sprites',
    render: (d) =>
      JSON.stringify(
        {
          textures: [{
            image: d.image,
            format: 'RGBA8888',
            size: { w: d.width, h: d.height },
            scale: d.scale,
            frames: framesOf(d).map((f) => ({
              filename: f.name,
              rotated: false,
              trimmed: f.trimmed,
              sourceSize: { w: f.srcW, h: f.srcH },
              spriteSourceSize: { x: f.offX, y: f.offY, w: f.w, h: f.h },
              frame: { x: f.x, y: f.y, w: f.w, h: f.h },
            })),
          }],
          meta: { app: d.app, version: '3.0' },
        },
        null,
        2,
      ),
  },
  {
    id: 'spine',
    label: 'Spine / libGDX (.atlas)',
    ext: 'atlas',
    kind: 'sprites',
    render: (d) =>
      [
        '',
        d.image,
        `size: ${d.width},${d.height}`,
        'format: RGBA8888',
        'filter: Linear,Linear',
        'repeat: none',
        ...framesOf(d).flatMap((f) => [
          f.name,
          '  rotate: false',
          `  xy: ${f.x}, ${f.y}`,
          `  size: ${f.w}, ${f.h}`,
          `  orig: ${f.srcW}, ${f.srcH}`,
          // libGDX считает смещение от нижнего края
          `  offset: ${f.offX}, ${f.srcH - f.offY - f.h}`,
          '  index: -1',
        ]),
        '',
      ].join('\n'),
  },
  {
    id: 'starling',
    label: 'Starling / Sparrow XML',
    ext: 'xml',
    kind: 'sprites',
    render: (d) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<TextureAtlas imagePath="${xmlEsc(String(d.image))}" width="${d.width}" height="${d.height}">`,
        ...framesOf(d).map((f) =>
          `  <SubTexture name="${xmlEsc(f.name)}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}"` +
          (f.trimmed ? ` frameX="${-f.offX}" frameY="${-f.offY}" frameWidth="${f.srcW}" frameHeight="${f.srcH}"` : '') +
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
    render: (d) => {
      const fr = framesOf(d).map((f) => {
        const ox = f.offX + f.w / 2 - f.srcW / 2, oy = f.srcH / 2 - (f.offY + f.h / 2);
        return `        <key>${xmlEsc(f.name)}</key>
        <dict>
            <key>frame</key><string>{{${f.x},${f.y}},{${f.w},${f.h}}}</string>
            <key>offset</key><string>{${ox},${oy}}</string>
            <key>rotated</key><false/>
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
    id: 'css',
    label: 'CSS-спрайты',
    ext: 'css',
    kind: 'sprites',
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
    template: `name,x,y,w,h,offsetX,offsetY,sourceW,sourceH
{{#frames}}{{name}},{{x}},{{y}},{{w}},{{h}},{{offX}},{{offY}},{{srcW}},{{srcH}}
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
  ['{{x}} {{y}} {{w}} {{h}}', 'положение в атласе'],
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
