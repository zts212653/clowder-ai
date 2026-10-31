// biome-ignore lint/correctness/noUnusedImports: React must be in scope for renderToStaticMarkup JSX
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetadataBadge } from '../MetadataBadge';

describe('MetadataBadge invocation usage', () => {
  it('renders the persisted execution account rather than consulting the current binding or renamed account', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'gpt-6.1-sol',
          provider: 'openai',
          executionAccount: {
            accountRef: 'account-a',
            displayName: '原备注 A',
            authType: 'oauth',
            accountRevision: 'revision-a',
          },
        }}
      />,
    );
    expect(html).toContain('data-execution-account="account-a"');
    expect(html).toContain('执行账号：原备注 A');
  });
  it('identifies the original account on a Realtime transcript', () => {
    const html = renderToStaticMarkup(
      <MetadataBadge
        metadata={{
          model: 'realtime',
          provider: 'openai',
          executionAccount: {
            accountRef: 'account-a',
            displayName: '原备注 A',
            authType: 'oauth',
            accountRevision: 'revision-a',
          },
        }}
      />,
    );
    expect(html).toContain('Realtime 执行账号：原备注 A');
  });
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
    expect(html).not.toContain('$');
    expect(html).not.toContain('invocation_usage');
  });
});
