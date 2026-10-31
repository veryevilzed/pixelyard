import type { ToolId } from '../store';
import type { Tool } from './base';
import { cropTool } from './crop';
import { eyedropperTool, fillTool, gradientTool, handTool, shapeTool, textTool, zoomTool } from './fill';
import { moveTool } from './move';
import { transformActive, transformTool } from './transform';
import { brushTool, eraserTool, pencilTool, stampTool } from './paint';
import { lassoTool, marqueeEllipseTool, marqueeRectTool, polygonLassoTool, wandTool } from './select';
import { sliceTool } from './slice';
import { knifeTool } from './knife';
import { atlasTool } from './atlasTool';
import { isAtlas } from '../core/atlasDoc';
import { activeDoc } from '../store';

export const TOOLS: Record<ToolId, Tool> = {
  move: moveTool,
  'marquee-rect': marqueeRectTool,
  'marquee-ellipse': marqueeEllipseTool,
  lasso: lassoTool,
  'polygon-lasso': polygonLassoTool,
  wand: wandTool,
  crop: cropTool,
  slice: sliceTool,
  knife: knifeTool,
  eyedropper: eyedropperTool,
  brush: brushTool,
  pencil: pencilTool,
  eraser: eraserTool,
  stamp: stampTool,
  fill: fillTool,
  gradient: gradientTool,
  shape: shapeTool,
  text: textTool,
  hand: handTool,
  zoom: zoomTool,
};

/** Инструмент, получающий события: трансформация перекрывает выбранный, в атласе — инструмент атласа. */
export function effectiveTool(id: ToolId): Tool {
  if (transformActive()) return transformTool;
  if (isAtlas(activeDoc()) && id !== 'hand' && id !== 'zoom') return atlasTool;
  return TOOLS[id];
}
