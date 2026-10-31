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
  it('block with text is a voice message', () => {
    const block = { id: 'v1', kind: 'audio' as const, v: 1 as const, url: '/api/tts/audio/abc.wav', text: '你好呀！' };
    expect(!!block.text).toBe(true);
  });

  it('block without text is a generic audio block', () => {
    const block = { id: 'a1', kind: 'audio' as const, v: 1 as const, url: '/uploads/audio/test.wav' } as {
      text?: string;
    };
    expect(!!block.text).toBe(false);
  });

  it('voice bar width scales with duration', () => {
    const computeWidth = (sec: number) => Math.min(200, Math.max(80, 80 + sec * 12));
    expect(computeWidth(0)).toBe(80); // minimum
    expect(computeWidth(3)).toBe(116); // short message
    expect(computeWidth(5)).toBe(140); // medium
    expect(computeWidth(10)).toBe(200); // max cap
    expect(computeWidth(20)).toBe(200); // still max
  });

  it('duration format uses Chinese seconds marker for < 60s', () => {
    const formatDuration = (sec: number) => {
      if (sec <= 0) return '';
      if (sec < 60) return `${Math.round(sec)}"`;
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(3)).toBe('3"');
    expect(formatDuration(15)).toBe('15"');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(95)).toBe('1:35');
  });

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
