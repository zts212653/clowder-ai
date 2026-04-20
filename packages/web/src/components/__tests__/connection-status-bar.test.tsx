import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectionStatusBar } from '../ConnectionStatusBar';

describe('ConnectionStatusBar', () => {
  it('returns null when everything is healthy and no offline snapshot is shown', () => {
    const html = renderToStaticMarkup(
      <ConnectionStatusBar
        api="online"
        socket="online"
        upstream="online"
        isReadonly={false}
        checkedAt={Date.now()}
        isOfflineSnapshot={false}
      />,
    );
    expect(html).toBe('');
  });

  it('renders three channels and readonly hint when connectivity is broken', () => {
    const html = renderToStaticMarkup(
      <ConnectionStatusBar
        api="offline"
        socket="offline"
        upstream="degraded"
        isReadonly
        checkedAt={Date.now()}
        isOfflineSnapshot
      />,
    );
    expect(html).toContain('本地 API');
    expect(html).toContain('Socket');
    expect(html).toContain('上游模型');
    expect(html).toContain('输入区已切换为只读模式');
  });

  it('shows snapshot hint when using cached history in non-readonly mode', () => {
    const html = renderToStaticMarkup(
      <ConnectionStatusBar
        api="online"
        socket="online"
        upstream="online"
        isReadonly={false}
        checkedAt={null}
        isOfflineSnapshot
      />,
    );
    expect(html).toContain('本地离线快照');
    expect(html).toContain('等待探测中');
  });
});
