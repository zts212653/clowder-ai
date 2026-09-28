/**
 * Real mermaid + DOMPurify integration test.
 *
 * Unlike the mock-based mermaid-diagram.test.tsx, this file does NOT mock
 * the mermaid library. It runs the actual mermaid renderer to produce SVG,
 * then passes it through the same DOMPurify config used in MermaidDiagram.tsx.
 *
 * Purpose: catch config mistakes that only surface with real rendering —
 * e.g. htmlLabels placement causing foreignObject which DOMPurify strips.
 *
 * Provenance: clowder-ai#1444
 */
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';

/* ── jsdom SVG polyfills ──────────────────────────────────────
 * mermaid's dagre layout calls getBBox/getComputedTextLength on SVG elements.
 * jsdom doesn't implement SVG geometry, so we polyfill with stub values.
 * Layout accuracy is irrelevant — we only care about the SVG *structure*
 * (foreignObject vs <text>) and whether labels survive DOMPurify.
 */
beforeAll(() => {
  const svgProto = SVGElement.prototype as unknown as Record<string, unknown>;
  if (!svgProto.getBBox) {
    svgProto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20, toJSON: () => '{}' });
  }
  if (!svgProto.getComputedTextLength) {
    svgProto.getComputedTextLength = () => 80;
  }
  const svgSvgProto = SVGSVGElement.prototype as unknown as Record<string, unknown>;
  if (!svgSvgProto.createSVGPoint) {
    svgSvgProto.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 0, y: 0 }) });
  }
});

/** Mirror the exact DOMPurify config from MermaidDiagram.tsx */
function sanitize(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

/** Mirror the exact mermaid.initialize call from MermaidDiagram.tsx */
function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    htmlLabels: false,
  });
}

const FLOWCHART_WITH_CHINESE = `flowchart LR
  A["读状态"] --> B["写状态"]
  B --> C["验证"]`;

describe('Mermaid → DOMPurify real integration', () => {
  it('produces zero foreignObject elements after rendering', async () => {
    initMermaid();
    const { svg } = await mermaid.render('test-fo-check', FLOWCHART_WITH_CHINESE);

    const foreignObjectCount = (svg.match(/<foreignObject/gi) ?? []).length;
    expect(foreignObjectCount).toBe(0);
  });

  it('preserves all node text after DOMPurify sanitization', async () => {
    initMermaid();
    const { svg } = await mermaid.render('test-label-check', FLOWCHART_WITH_CHINESE);
    const sanitized = sanitize(svg);

    expect(sanitized).toContain('读状态');
    expect(sanitized).toContain('写状态');
    expect(sanitized).toContain('验证');
  });

  it('preserves edge label text after DOMPurify sanitization', async () => {
    const withEdgeLabel = `flowchart LR
  A["起点"] -->|"传递"| B["终点"]`;

    initMermaid();
    const { svg } = await mermaid.render('test-edge-label', withEdgeLabel);
    const sanitized = sanitize(svg);

    expect(sanitized).toContain('起点');
    expect(sanitized).toContain('终点');
    expect(sanitized).toContain('传递');
  });
});
