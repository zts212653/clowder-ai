'use client';

import DOMPurify from 'dompurify';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { readShellPresentation, useShellPresentation } from './shell/shell-presentation';

type RenderState =
  | { status: 'loading'; svg?: undefined; error?: undefined }
  | { status: 'ready'; svg: string; error?: undefined }
  | { status: 'error'; svg?: undefined; error: string };

function hashSource(source: string): string {
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function toMermaidId(id: string, source: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '') || 'diagram';
  return `mermaid-${safeId}-${hashSource(source)}`;
}

function removeOwnedMermaidScratch(renderId: string): void {
  document.getElementById(`d${renderId}`)?.remove();
  document.getElementById(`i${renderId}`)?.remove();
}

export function MermaidDiagram({ source }: { source: string }) {
  const presentation = useShellPresentation();
  const reactId = useId();
  const renderGeneration = useRef(0);
  const normalizedSource = source.trim();
  const diagramId = useMemo(() => toMermaidId(reactId, normalizedSource), [reactId, normalizedSource]);
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // A cancelled classic render can finish after v2 has started. Its cleanup
    // must never target the new render's scratch, even with identical source.
    const renderId = presentation === 'v2' ? `${diagramId}-v2-${++renderGeneration.current}` : diagramId;
    const cleanV2Scratch = () => {
      if (presentation === 'v2' || readShellPresentation() === 'v2') removeOwnedMermaidScratch(renderId);
    };

    async function renderDiagram() {
      setRenderState({ status: 'loading' });

      try {
        const mermaid = (await import('mermaid')).default;
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          // Top-level htmlLabels overrides all diagram types.
          // Nested flowchart.htmlLabels does NOT suppress foreignObject
          // in mermaid 11.15.0 when securityLevel='strict' — the strict
          // sandbox forces HTML labels back on. Top-level wins.
          // See: clowder-ai#1444
          htmlLabels: false,
          // Mermaid otherwise leaves its error SVG in document.body before rejecting.
          // V2 owns error presentation here; suppress the global fallback so Mermaid
          // cleans its temporary DOM and cannot scroll the whole document.
          suppressErrorRendering: presentation === 'v2',
        });

        const { svg } = await mermaid.render(renderId, normalizedSource);
        const safeSvg = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });

        if (!cancelled) setRenderState({ status: 'ready', svg: safeSvg });
      } catch (error) {
        if (!cancelled) {
          setRenderState({
            status: 'error',
            error: error instanceof Error ? error.message : '无法渲染 Mermaid 图表',
          });
        }
      } finally {
        if (cancelled) cleanV2Scratch();
      }
    }

    void renderDiagram();
    return () => {
      cancelled = true;
      cleanV2Scratch();
    };
  }, [diagramId, normalizedSource, presentation]);

  return (
    <div
      data-testid="mermaid-diagram"
      // The renderer owns every character in here — typeset SVG, loading copy, error copy —
      // none of which exists in the Markdown source. It is interface state, not quotable
      // message content, so selections touching it are refused.
      data-quote-exclude
      className="my-3 overflow-x-auto rounded-md border border-cafe bg-cafe-white p-3 text-cafe-primary"
    >
      {renderState.status === 'ready' ? (
        <div
          className="[&>svg]:h-auto [&>svg]:max-w-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid returns SVG markup; DOMPurify sanitizes it before injection.
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : null}
      {renderState.status === 'loading' ? (
        <div className="text-xs text-cafe-muted">正在渲染 Mermaid 图表...</div>
      ) : null}
      {renderState.status === 'error' ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-conn-red-text">Mermaid 图表渲染失败：{renderState.error}</div>
          <pre className="overflow-x-auto rounded bg-cafe-surface-sunken p-3 text-xs leading-5 text-cafe-secondary">
            {normalizedSource}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
