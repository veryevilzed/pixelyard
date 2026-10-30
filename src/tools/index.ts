import type { ToolId } from '../store';
import type { Tool } from './base';
import { cropTool } from './crop';
import { eyedropperTool, fillTool, gradientTool, handTool, shapeTool, textTool, zoomTool } from './fill';
import { moveTool } from './move';
import { transformActive, transformTool } from './transform';
import { brushTool, eraserTool, pencilTool } from './paint';
import { lassoTool, marqueeEllipseTool, marqueeRectTool, polygonLassoTool, wandTool } from './select';
import { sliceTool } from './slice';
import { knifeTool } from './knife';

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
  fill: fillTool,
  gradient: gradientTool,
  shape: shapeTool,
  text: textTool,
  hand: handTool,
  zoom: zoomTool,
};

/** Инструмент, получающий события: трансформация перекрывает выбранный. */
export function effectiveTool(id: ToolId): Tool {
  return transformActive() ? transformTool : TOOLS[id];
}
