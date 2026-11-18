import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCatVoice } from '../src/config/cat-voices.js';
import { prepareResolvedCatVoice } from '../src/domains/cats/services/tts/cat-voice-synthesis.js';
import { prepareTtsIdentity } from '../src/domains/cats/services/tts/TtsSynthesisIdentity.js';
import { fixture } from './helpers/voice-selection-fixture.js';

for (const backend of ['edge-tts', 'mlx-audio', 'sapi', 'piper']) {
  test(`${backend} reports preset capability from the actual backend without inventing a default voice`, async (t) => {
    const f = await fixture();
    t.after(() => f.app.close());
    const previous = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = previous;
    });
    const model =
      backend === 'mlx-audio' ? 'mlx-community/Kokoro-82M-bf16' : backend === 'piper' ? 'zh_CN-huayan-medium' : backend;
    globalThis.fetch = async () =>
      Response.json({ status: 'ok', model, backend, capabilities: ['speech-stream-route-v1'] });
    const identity = await prepareTtsIdentity('http://127.0.0.1:19889', model, join(f.root, 'cache'));
    const supported = backend === 'edge-tts' || backend === 'mlx-audio';
    assert.equal(identity.voiceIdSupport, supported);
    const { voiceSelection: selection } = prepareResolvedCatVoice(
      resolveCatVoice('opus'),
      { ...f.registry.getDefault(), ...identity },
      { voice: 'zh-CN-XiaoxiaoNeural' },
    );
    assert.equal(selection.referenceStatus, 'unsupported');
    assert.equal(selection.effective.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(selection.effective.refAudio, undefined);
    const warning = selection.warnings.join(' ');
    assert.doesNotMatch(warning, /未确认|尚未确认/);
    if (supported) assert.doesNotMatch(warning, /默认音色/);
    else assert.match(warning, /不按声音 ID/);
  });
}
