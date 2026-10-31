import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionCommandValidator } from '../src/domains/plugin/desktop-window-runtime/admission.js';
import { validateHostCompanionCommand } from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { resolveCompanionArchiveContract } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';

const published = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.24',
  packageDigest: 'sha512-TN23gstQt3AC79zddScxjr9q9ZPGaNn+ieGdrLvfm3Ju+ev1cBjH/z7US8pxP3bLLF6FbFYfPbFmogb9EeIxug==',
};

test('only the immutable published alpha.24 archive selects beta.27', () => {
  assert.equal(resolveCompanionArchiveContract(published), '0.1.0-beta.27');
  for (const unpaired of [
    { ...published, pluginId: 'foreign.companion' },
    { ...published, version: '0.1.0-alpha.23' },
    { ...published, packageDigest: `${published.packageDigest.slice(0, -8)}AAAAAAAA` },
  ])
    assert.equal(resolveCompanionArchiveContract(unpaired), undefined);
});

test('only beta.27 admits the reference-only presentation command on the package and Host boundaries', () => {
  const command = {
    kind: 'presentation.observe',
    event: 'first_text_visible',
    observedAt: Date.now(),
    callId: 'd4b562ec-768c-4102-a83a-ea2f70dcc031',
    reference: { kind: 'native-item', nativeItemId: 'item' },
  };
  assert.equal(companionCommandValidator('0.1.0-beta.27')(command), true);
  assert.equal(validateHostCompanionCommand(command, '0.1.0-beta.27'), true);
  for (const contract of ['0.1.0-beta.21', '0.1.0-beta.23', '0.1.0-beta.24', '0.1.0-beta.25'] as const) {
    assert.equal(companionCommandValidator(contract)(command), false);
    assert.equal(validateHostCompanionCommand(command, contract), false);
  }
  for (const extra of [{ body: 'forged' }, { realtimeSessionId: 'foreign' }, { generation: 99 }])
    assert.equal(validateHostCompanionCommand({ ...command, ...extra }, '0.1.0-beta.27'), false);
});
