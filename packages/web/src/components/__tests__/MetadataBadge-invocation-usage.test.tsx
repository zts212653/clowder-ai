// biome-ignore lint/correctness/noUnusedImports: React must be in scope for renderToStaticMarkup JSX
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetadataBadge } from '../MetadataBadge';

describe('MetadataBadge invocation usage', () => {
  it('renders Sol usage as the compact footer shown under an assistant message', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-5.6-sol',
          provider: 'openai',
          usage: {
            inputTokens: 126_626,
            outputTokens: 2_017,
            cacheReadTokens: 125_696,
          },
        }}
      />,
    );

    expect(html).toContain('class="mt-1 text-micro');
    expect(html).toContain('gpt-5.6-sol · openai');
    expect(html).toContain('126.6k');
    expect(html).toContain('2.0k');
    expect(html).toContain('cached 99%');
    expect(html).not.toContain('invocation_usage');
  });
});
