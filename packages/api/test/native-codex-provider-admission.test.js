import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCodexProviderOwnsAuthentication } from '../dist/config/codex-native-provider-admission.js';

const provider = {
  name: 'Fixture',
  base_url: 'https://provider.invalid/v1',
  wire_api: 'responses',
  requires_openai_auth: false,
};
const config = { model_provider: 'fixture', model_providers: { fixture: provider } };

test('native provider admission respects requirements before user provider selection and definition', () => {
  assert.equal(nativeCodexProviderOwnsAuthentication(config, {}), true);
  assert.equal(nativeCodexProviderOwnsAuthentication(config, { model_provider: 'openai' }), false);
  assert.equal(
    nativeCodexProviderOwnsAuthentication(config, {
      model_providers: { fixture: { ...provider, requires_openai_auth: true } },
    }),
    false,
  );
  assert.equal(
    nativeCodexProviderOwnsAuthentication(config, {
      model_providers: { fixture: { requires_openai_auth: false } },
    }),
    false,
    'a partial managed definition cannot borrow the user endpoint',
  );
  assert.equal(nativeCodexProviderOwnsAuthentication(config, { model_providers: { fixture: null } }), false);
  assert.equal(
    nativeCodexProviderOwnsAuthentication(
      { model_provider: 'openai' },
      {
        model_provider: 'fixture',
        model_providers: { fixture: provider },
      },
    ),
    true,
  );
});

test('native provider admission never bypasses a required ChatGPT identity or accepts an invalid transport', () => {
  for (const policy of [
    { forced_login_method: 'chatgpt' },
    { forced_chatgpt_workspace_id: 'fixture-workspace' },
    { allowed_login_methods: ['chatgpt'] },
    { allowed_login_methods: 'invalid' },
  ])
    assert.equal(nativeCodexProviderOwnsAuthentication(config, policy), false);
  assert.equal(nativeCodexProviderOwnsAuthentication(config, { allowed_login_methods: ['api'] }), false);
  for (const overlay of [
    { base_url: 'file:///fixture' },
    { base_url: 'https://user:secret@provider.invalid' },
    { base_url: 'invalid' },
    { wire_api: 'invalid' },
    { requires_openai_auth: 'false' },
  ])
    assert.equal(
      nativeCodexProviderOwnsAuthentication(
        {
          model_provider: 'fixture',
          model_providers: { fixture: { ...provider, ...overlay } },
        },
        {},
      ),
      false,
    );
});
