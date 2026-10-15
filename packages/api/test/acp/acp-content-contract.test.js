import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toAcpPromptContent } from '../../dist/domains/cats/services/agents/providers/acp/acp-prompt-content.js';

for (const type of ['audio', 'resource'])
  test(`unsupported ${type} fails before transport admission`, () => {
    const block =
      type === 'audio'
        ? { type, data: 'synthetic', mimeType: 'audio/wav' }
        : { type, resource: { uri: 'synthetic:fixture', text: 'Synthetic data' } };
    assert.throws(() => toAcpPromptContent([block], {}), /unsupported|未声明/);
  });
test('declared multimodal content and opaque resource refs remain unchanged and snapshotted', () => {
  const original = [
    { type: 'audio', data: 'synthetic', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'synthetic:fixture', text: 'Synthetic data', _meta: { future: true } } },
    { type: 'resource_link', uri: 'synthetic:opaque', name: 'fixture' },
  ];
  const snapshot = toAcpPromptContent(original, { audio: true, embeddedContext: true });
  assert.deepEqual(snapshot, original);
  original[1].resource.text = 'later mutation';
  assert.equal(snapshot[1].resource.text, 'Synthetic data');
});
