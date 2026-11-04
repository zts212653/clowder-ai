/**
 * F34-b: AudioBlock voice message mode tests
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioBlock } from '@/components/rich/AudioBlock';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(block: Parameters<typeof AudioBlock>[0]['block'], catId = 'codex'): string {
  return renderToStaticMarkup(React.createElement(AudioBlock, { block, catId }));
}

// We test the data-driven logic, not React rendering (no jsdom needed)
describe('AudioBlock voice message detection', () => {
  it('voice transcript text wraps instead of truncating (regression)', () => {
    const html = render({
      id: 'v-wrap',
      kind: 'audio',
      v: 1,
      url: '/api/tts/audio/abc.wav',
      text: '喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵喵',
    });

    // Long transcript should wrap and keep full content visible.
    expect(html).toContain('break-words');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).not.toContain(' truncate');
  });

  it('supports kimi voice color tokens', () => {
    const block = { id: 'v2', kind: 'audio' as const, v: 1 as const, url: '/api/tts/audio/abc.wav', text: '测试' };
    const kimiHtml = render(block, 'kimi');

    expect(kimiHtml).toContain('--color-kimi-bg');
    expect(kimiHtml).toContain('--color-kimi-primary');
  });
});
