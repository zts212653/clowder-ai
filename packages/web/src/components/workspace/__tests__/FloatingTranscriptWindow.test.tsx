import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloatingTranscriptWindow } from '../FloatingTranscriptWindow';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('FloatingTranscriptWindow', () => {
  const sampleLines = [
    { ts: 1715400000, elapsed_s: 10, chunk_num: 1, asr_latency: 0.3, text: '你好世界' },
    { ts: 1715400003, elapsed_s: 13, chunk_num: 2, asr_latency: 0.25, text: '第二句话' },
  ];

  it('renders transcript lines', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={sampleLines} connected={true} recording={false} onClose={() => {}} />,
    );
    expect(html).toContain('你好世界');
    expect(html).toContain('第二句话');
  });

  it('shows recording indicator when active', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={true}
        sourceLabel="Google Chrome"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Google Chrome');
  });

  it('shows empty state when no lines and not recording', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={[]} connected={false} recording={false} onClose={() => {}} />,
    );
    expect(html).toContain('No transcript');
  });

  it('renders minimize button', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={sampleLines} connected={true} recording={false} onClose={() => {}} />,
    );
    expect(html).toContain('Minimize');
  });

  it('renders chunk count in footer', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={sampleLines} connected={true} recording={false} onClose={() => {}} />,
    );
    expect(html).toContain('2 chunks');
  });

  it('shows SSE connection status', () => {
    const htmlConnected = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={[]} connected={true} recording={false} onClose={() => {}} />,
    );
    expect(htmlConnected).toContain('SSE');

    const htmlDisconnected = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={[]} connected={false} recording={false} onClose={() => {}} />,
    );
    expect(htmlDisconnected).toContain('disconnected');
  });

  it('applies tabIndex=-1 to prevent focus stealing', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow lines={[]} connected={true} recording={false} onClose={() => {}} />,
    );
    expect(html).toContain('tabindex="-1"');
  });

  it('shows Passive button when advisory mode is passive', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={true}
        onClose={() => {}}
        advisoryMode="passive"
        onToggleAdvisory={() => {}}
      />,
    );
    expect(html).toContain('Passive');
    expect(html).not.toContain('>Advisory<');
  });

  it('shows Advisory button when advisory mode is active', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={true}
        onClose={() => {}}
        advisoryMode="active"
        onToggleAdvisory={() => {}}
      />,
    );
    expect(html).toContain('>Advisory<');
  });

  it('renders advisory banner with talking point', () => {
    const advisory = {
      type: 'intervention_advisory' as const,
      ts: 1715400010,
      reason: 'keyword_match',
      confidence: 0.8,
      source_chunk_num: 5,
      source_text: 'budget discussion',
      talking_point: 'budget under 50k',
    };
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={true}
        recording={true}
        onClose={() => {}}
        advisory={advisory}
        advisoryMode="active"
        onToggleAdvisory={() => {}}
        onAdvisoryDismiss={() => {}}
        onAdvisoryDnd={() => {}}
      />,
    );
    expect(html).toContain('Topic match');
    expect(html).toContain('budget under 50k');
    expect(html).toContain('DND');
  });

  it('shows saved path when not recording', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={false}
        recording={false}
        savedPath="/tmp/meeting-2026-05-12.md"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Transcript:');
    expect(html).toContain('/tmp/meeting-2026-05-12.md');
  });

  it('hides saved path while recording', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={true}
        recording={true}
        savedPath="/tmp/meeting-2026-05-12.md"
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain('Transcript:');
  });

  it('shows recording path when not recording', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={false}
        recording={false}
        savedPath="/tmp/transcript.md"
        savedRecordingPath="/tmp/recording.mp3"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Transcript:');
    expect(html).toContain('/tmp/transcript.md');
    expect(html).toContain('Recording:');
    expect(html).toContain('/tmp/recording.mp3');
  });

  it('shows Pause button when recording and not paused', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={true}
        onClose={() => {}}
        onStop={() => {}}
        onPause={() => {}}
      />,
    );
    expect(html).toContain('Pause');
  });

  it('shows Resume button and paused indicator when paused', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={true}
        paused={true}
        onClose={() => {}}
        onStop={() => {}}
        onResume={() => {}}
      />,
    );
    expect(html).toContain('Resume');
    expect(html).toContain('Paused');
  });

  it('shows source selector and Start button when not recording', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={[]}
        connected={true}
        recording={false}
        onClose={() => {}}
        sources={{ apps: ['Google Chrome', 'Zoom'], mics: [{ index: 0, name: 'MacBook Pro Mic', default: true }] }}
        onStart={() => {}}
      />,
    );
    expect(html).toContain('Google Chrome');
    expect(html).toContain('Zoom');
    expect(html).toContain('Start');
  });

  it('hides source selector when recording is active', () => {
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={true}
        recording={true}
        onClose={() => {}}
        sources={{ apps: ['Google Chrome'], mics: [] }}
        onStart={() => {}}
      />,
    );
    expect(html).not.toContain('Start');
  });

  it('renders advisory banner even in passive mode (backend is authority)', () => {
    const advisory = {
      type: 'intervention_advisory' as const,
      ts: 1715400010,
      reason: 'question_detected',
      confidence: 0.8,
      source_chunk_num: 5,
      source_text: 'What do you think?',
      talking_point: null,
    };
    const html = renderToStaticMarkup(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected={true}
        recording={true}
        onClose={() => {}}
        advisory={advisory}
        advisoryMode="passive"
        onToggleAdvisory={() => {}}
        onAdvisoryDismiss={() => {}}
        onAdvisoryDnd={() => {}}
      />,
    );
    expect(html).toContain('Question detected');
  });
});
