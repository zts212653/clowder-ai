'use client';
import type { RichHtmlWidgetBlock } from '@/stores/chat-types';
import { HtmlWidgetBlock } from '../rich/HtmlWidgetBlock';

/** #1642 compatibility entry; the shared HTML renderer owns sanitization, sandbox and Works scrolling. */
export function ArtifactWidgetFrame({ block }: { block: RichHtmlWidgetBlock }) {
  return <HtmlWidgetBlock block={block} presentation="workspace" />;
}
