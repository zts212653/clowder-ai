import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TtsVoiceSelection } from '@cat-cafe/shared';
import { resolveCatVoice } from '../src/config/cat-voices.js';
import { StreamingTtsChunker } from '../src/domains/cats/services/tts/StreamingTtsChunker.js';
import { VoiceBlockSynthesizer } from '../src/domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { fixture } from './helpers/voice-selection-fixture.js';

for (const receipts of [
  ['a', 'b'],
  ['a', undefined, 'b'],
  [undefined, 'a', 'b'],
  ['a', 'unavailable'],
]) {
  for (const entrance of ['stream', 'live', 'voice-block', 'resolved-block']) {
    test(`${entrance} stops a changed reader reference across ${receipts.join(' → ')}`, async () => {
      const f = await fixture(true);
      const source = resolveCatVoice('opus').config.refAudio;
      assert.ok(source);
      await chmod(source, 0);
      let calls = 0;
      f.registry.getDefault().synthesize = async () => ({
        audio: Buffer.from('audio'),
        format: 'wav',
        referenceAudio: (() => {
          const receipt = receipts[calls++];
          return receipt === undefined
            ? undefined
            : receipt === 'unavailable'
              ? { status: 'unavailable' as const }
              : { status: 'used' as const, sha256: receipt.repeat(64) };
        })(),
      });
      if (entrance === 'resolved-block') {
        const blocks = await new VoiceBlockSynthesizer(f.registry, join(f.root, 'cache')).resolveVoiceBlocks(
          [{ kind: 'audio', v: 1, id: 'sequence-error', url: '', text: '长语音必须保持同一参考。'.repeat(40) }],
          'opus',
        );
        assert.equal(blocks[0].kind, 'card');
        assert.match(JSON.stringify(blocks[0]), /参考音频.*变化/);
      } else if (entrance === 'voice-block') {
        await assert.rejects(
          new VoiceBlockSynthesizer(f.registry, join(f.root, 'cache')).resynthesize(
            '长语音必须保持同一参考。'.repeat(40),
            'opus',
          ),
          /参考音频.*变化/,
        );
      } else if (entrance === 'stream') {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/tts/stream',
          headers: { 'x-cat-cafe-user': 'voice-test' },
          payload: { catId: 'opus', text: '第一句。第二句。第三句。' },
        });
        const events = response.body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)));
        assert.equal(events.filter((event) => event.type === 'chunk').length, receipts.length - 1);
        assert.match(events.find((event) => event.type === 'error')?.error ?? '', /参考音频.*变化/);
      } else {
        const events: { type: string; voiceSelection?: TtsVoiceSelection }[] = [];
        const chunker = new StreamingTtsChunker({
          catId: 'opus',
          invocationId: 'reader-change',
          threadId: 'reader-change',
          voiceResolution: resolveCatVoice('opus'),
          ttsRegistry: f.registry,
          broadcaster: {
            broadcastToRoom: (_room, _type, event) => {
              events.push(event as (typeof events)[number]);
            },
          },
        });
        chunker.feed('第一句。第二句。第三句。');
        await chunker.flush();
        assert.equal(events.filter((event) => event.type === 'voice_chunk').length, receipts.length - 1);
        assert.match(
          events.find((event) => event.type === 'voice_stream_end')?.voiceSelection?.warnings.join(' ') ?? '',
          /参考音频.*变化/,
        );
      }
      assert.equal(calls, receipts.length, 'stop the remaining operation after detecting a reader change');
    });
  }
}
