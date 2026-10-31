import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { MeetingShareControl } from '../MeetingShareControl';
import { TranscriptLinesV2 } from '../TranscriptLinesV2';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'available', intent: {}, sharing: false, inputLabel: 'RAW INPUT' }),
  })),
}));

describe('R3 independent regression probes', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { React?: typeof React }).React = React;
    writeShellPresentation('classic');
    writeShellLanguage('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as { React?: typeof React }).React;
  });

  it('classic share control neither reads nor subscribes to the v2 language preference', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const subscribe = vi.spyOn(window, 'addEventListener');
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
    expect(container.textContent).toContain('Share transcript');
    expect({
      reads: read.mock.calls.filter(([key]) => key === 'cat-cafe:shell-language').length,
      subscriptions: subscribe.mock.calls.filter(([event]) => event === 'cat-cafe:shell-language-sync').length,
    }).toEqual({ reads: 0, subscriptions: 0 });
  });

  it('actual fixture return assertion must reject replaced transcript bodies and a different full path', async () => {
    writeShellPresentation('v2');
    const oldPath = '/home/user/cat-cafe-f322-voice-meeting/session-A/meeting.md';
    const newPath = '/home/user/cat-cafe-f322-voice-meeting/session-B/meeting.md';
    const show = (text: string, path: string) => (
      <div>
        <span>已停止</span>
        <TranscriptLinesV2
          lines={[{ ts: 101, elapsed_s: 1, chunk_num: 1, asr_latency: 0.3, text }]}
          waiting={false}
          emptyText=""
          waitingText=""
        />
        <span className="font-mono" title={path}>
          {path}
        </span>
      </div>
    );
    await act(async () => {
      root.render(show('Original complete transcript body', oldPath));
    });
    const exactLines = [...container.querySelectorAll('.font-mono')].map((row) => row.textContent ?? '');
    await act(async () => {
      root.render(show('Entirely replaced transcript body', newPath));
    });
    const returned = container.textContent ?? '';
    const source = readFileSync(
      '/home/user/.cat-cafe/evidence/f322-voice-meeting-v2/harness/voice-meeting-v2-fixture.mjs',
      'utf8',
    );
    const pathCheck = source.match(/^\s*const pathRestored = .*;$/m)?.[0];
    const linesCheck = source.match(/^\s*const linesRestored = .*;$/m)?.[0];
    expect(pathCheck).toBeTruthy();
    expect(linesCheck).toBeTruthy();
    const verdict = runInNewContext(
      `${pathCheck}\n${linesCheck}\nreturned.includes('已停止') && pathRestored && linesRestored`,
      { exactTranscriptPath: oldPath, exactLines, returned },
    );
    expect(verdict, 'the harness must reject changed full path and lost original transcript text').toBe(false);
  });
});
