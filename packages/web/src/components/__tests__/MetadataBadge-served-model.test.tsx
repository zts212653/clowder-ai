// biome-ignore lint/correctness/noUnusedImports: React must be in scope for renderToStaticMarkup JSX
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessageMetadata } from '@/stores/chatStore';
import { MetadataBadge } from '../MetadataBadge';

/** Visible text only (tags stripped, entities decoded) — what the reader actually sees, tooltip excluded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

describe('MetadataBadge served model (F319)', () => {
  it('shows requested → served when the upstream answered with a different model', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-6-astra',
          provider: 'openai',
          servedModel: 'gpt-5.6-luna',
          servedResponseId: 'resp_0d46',
        }}
      />,
    );
    expect(html).toContain('gpt-6-astra → gpt-5.6-luna');
    expect(html).toContain('上游应答');
    expect(html).toContain('data-served-model="gpt-5.6-luna"');
    expect(html).not.toContain('data-served-consistent');
  });

  it('Phase F: a reroute carries its own amber warning pill (replaces the detached blue banner)', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-5.6-sol',
          provider: 'openai',
          servedModel: 'gpt-6-sol',
          servedResponseId: 'resp_076e',
        }}
      />,
    );
    expect(visibleText(html)).toContain('上游换模');
    expect(html).toContain('data-served-reroute="true"');
    // Designed SVG icon inside the pill (repo UI guard forbids raw emoji / symbol glyphs).
    expect(html).toMatch(/data-served-reroute="true"[^>]*><svg[^>]*data-icon="reroute-warning"[^>]*aria-hidden="true"/);
    expect(visibleText(html)).not.toContain('⚠');
    expect(html).toContain('bg-conn-amber-bg');
    expect(html).toContain(
      'title="请求 gpt-5.6-sol，上游实际应答 gpt-6-sol · response resp_076e（上游自述，非权重验证）"',
    );
  });

  it('Phase F: expanding shows the full response id OUTSIDE the button (button text is not selectable)', async () => {
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const id = 'resp_076e2f61593637ea016ab2b4e5778c87d08d21ce41619e7d16';
    act(() => {
      root.render(
        <MetadataBadge
          metadata={{ model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-6-sol', servedResponseId: id }}
        />,
      );
    });
    expect(container.querySelector('[data-served-response-id]')).toBeNull();
    act(() => {
      (container.querySelector('[data-testid="message-metadata"]') as HTMLButtonElement).click();
    });
    const idEl = container.querySelector(`[data-served-response-id="${id}"]`);
    expect(idEl?.textContent).toContain(id);
    expect(idEl?.closest('button')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('Phase F: consistent / unobserved replies carry no reroute pill', () => {
    const cases: ChatMessageMetadata[] = [
      { model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-5.6-sol' },
      { model: 'gpt-5.6-sol', provider: 'openai' },
      { model: '', provider: 'openai', servedModel: 'gpt-6-sol' },
    ];
    for (const metadata of cases) {
      const html = renderToStaticMarkup(<MetadataBadge metadata={metadata} />);
      expect(html).not.toContain('data-served-reroute');
      expect(visibleText(html)).not.toContain('上游换模');
    }
  });

  it('renders exactly as before when the served model was not observed', () => {
    const html = renderToStaticMarkup(<MetadataBadge metadata={{ model: 'gpt-6-astra', provider: 'openai' }} />);
    expect(visibleText(html)).toBe('gpt-6-astra · openai');
    expect(html).not.toContain('data-served-consistent');
    expect(html).not.toContain('turn-state');
  });
});

describe('MetadataBadge three facts (F319 Phase E)', () => {
  it('observed & consistent: light ✓, visible turn-state length, tooltip says self-declared not weight-verified', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-5.6-sol',
          provider: 'openai',
          servedModel: 'GPT-5.6-Sol',
          upstreamTurnStateLength: 312,
        }}
      />,
    );
    const text = visibleText(html);
    expect(text).toContain('gpt-5.6-sol · openai');
    expect(text).toContain('✓');
    expect(text).toContain('turn-state 312');
    expect(text).not.toContain('→');
    expect(html).toContain('data-served-consistent="true"');
    expect(html).toContain('title="上游自述一致（response.model，非权重验证）· turn-state 312"');
  });

  it('observed & consistent without turn-state: shows 未观测 instead of hiding it', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge metadata={{ model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-5.6-sol' }} />,
    );
    const text = visibleText(html);
    expect(text).toContain('✓');
    expect(text).toContain('turn-state 未观测');
    expect(html).toContain('data-turn-state="unobserved"');
    expect(html).toContain('title="上游自述一致（response.model，非权重验证）· turn-state 未观测"');
  });

  it('a turn-state length of 0 is an observed value, not 未观测', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{ model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-5.6-sol', upstreamTurnStateLength: 0 }}
      />,
    );
    expect(visibleText(html)).toContain('turn-state 0');
    expect(html).toContain('data-turn-state="0"');
  });

  it('observed & different: amber A → B plus the turn-state length, no ✓', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-6-astra',
          provider: 'openai',
          servedModel: 'gpt-5.6-luna',
          servedResponseId: 'resp_0d46',
          upstreamTurnStateLength: 292,
        }}
      />,
    );
    const text = visibleText(html);
    expect(text).toContain('gpt-6-astra → gpt-5.6-luna（上游应答）');
    expect(text).toContain('turn-state 292');
    expect(text).not.toContain('✓');
    expect(html).toContain(
      '上游 response resp_0d46 自述的模型与请求不同（response.model，非权重验证）· turn-state 292',
    );
  });

  it('observed & different without turn-state: says 未观测', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge metadata={{ model: 'gpt-6-astra', provider: 'openai', servedModel: 'gpt-5.6-luna' }} />,
    );
    expect(visibleText(html)).toContain('turn-state 未观测');
  });

  it('requested model unknown: no ✓ (nothing was compared), tooltip says so, turn-state still shown', () => {
    for (const model of ['', '   ']) {
      const html = renderToStaticMarkup(
        <MetadataBadge
          metadata={{ model, provider: 'openai', servedModel: 'gpt-5.6-sol', upstreamTurnStateLength: 312 }}
        />,
      );
      const text = visibleText(html);
      expect(text).not.toContain('✓');
      expect(text).not.toContain('→');
      expect(text).toContain('turn-state 312');
      expect(html).not.toContain('data-served-consistent');
      expect(html).toContain(
        'title="上游自述 gpt-5.6-sol（response.model，非权重验证）· 请求模型未知 · turn-state 312"',
      );
    }
  });

  it('a non-finite turn-state length is 未观测', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-5.6-sol',
          provider: 'openai',
          servedModel: 'gpt-5.6-sol',
          upstreamTurnStateLength: Number.NaN,
        }}
      />,
    );
    expect(visibleText(html)).toContain('turn-state 未观测');
  });

  it('never claims verification', () => {
    const variants = [
      { model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-5.6-sol', upstreamTurnStateLength: 312 },
      { model: 'gpt-5.6-sol', provider: 'openai', servedModel: 'gpt-5.6-sol' },
      { model: 'gpt-6-astra', provider: 'openai', servedModel: 'gpt-5.6-luna', servedResponseId: 'resp_1' },
      { model: 'gpt-6-astra', provider: 'openai' },
    ];
    for (const metadata of variants) {
      const html = renderToStaticMarkup(<MetadataBadge metadata={metadata} />);
      expect(html).not.toMatch(/verified|已验证|已核对/i);
    }
  });
});
