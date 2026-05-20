'use client';

import DOMPurify from 'dompurify';
import { useEffect, useId, useMemo, useState } from 'react';

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

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const normalizedSource = source.trim();
  const diagramId = useMemo(() => toMermaidId(reactId, normalizedSource), [reactId, normalizedSource]);
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setRenderState({ status: 'loading' });

      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          flowchart: {
            htmlLabels: false,
          },
        });

        const { svg } = await mermaid.render(diagramId, normalizedSource);
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
      }
    }

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [diagramId, normalizedSource]);

  return (
    <div
      data-testid="mermaid-diagram"
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
