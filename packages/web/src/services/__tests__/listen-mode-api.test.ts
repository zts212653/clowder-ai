import { describe, expect, it } from 'vitest';
import { readListenSynthesisEvents } from '../listenModeApi';

describe('readListenSynthesisEvents', () => {
  it('emits the final SSE event even when the stream closes without a trailing blank line', async () => {
    const body = [
      'data: {"type":"chunk","audioBase64":"AAAA","format":"wav","isFinalChunk":true}',
      '',
      'data: {"type":"asset","audioUrl":"/audio/a.wav","assetId":"a.wav","cached":false,"bytes":4}',
    ].join('\n');
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });

    const events = [];
    for await (const event of readListenSynthesisEvents(response)) events.push(event);

    expect(events.map(({ type }) => type)).toEqual(['chunk', 'asset']);
  });
});
