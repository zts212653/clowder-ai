import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import type { WidgetLayoutMachineState } from './html-widget-layout-machine';

export const MAX_WIDGET_PREVIEW_HEIGHT = 720;

const DEFAULT_WIDGET_HEIGHT = 300;

export function resolveInitialWidgetHeight(block: RichHtmlWidgetBlock): number {
  return Math.min(MAX_WIDGET_PREVIEW_HEIGHT, Math.max(1, Math.ceil(block.height ?? DEFAULT_WIDGET_HEIGHT)));
}

export function resolveWidgetPresentation({
  block,
  expanded,
  isExport,
  measuredHeight,
}: {
  block: RichHtmlWidgetBlock;
  expanded: boolean;
  isExport: boolean;
  measuredHeight: number | null;
}) {
  const longContent = measuredHeight !== null && measuredHeight > MAX_WIDGET_PREVIEW_HEIGHT;
  const fullyExpanded = isExport || expanded;
  let visibleHeight = measuredHeight ?? resolveInitialWidgetHeight(block);
  if (longContent && !fullyExpanded) visibleHeight = MAX_WIDGET_PREVIEW_HEIGHT;
  return { fullyExpanded, longContent, visibleHeight };
}

export function resolveWidgetMeasurementError(error: WidgetLayoutMachineState['error']): string | null {
  if (error === 'invalid-sample') return '内容高度异常，无法安全展开。';
  if (error === 'viewport-feedback') return '内容高度依赖视口，无法确认完整内容可达。';
  if (error === 'unmeasurable-visual-overflow') return '内容包含无法可靠测量的浮动绘制，无法确认完整内容可达。';
  return null;
}
