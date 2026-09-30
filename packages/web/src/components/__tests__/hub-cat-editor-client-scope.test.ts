/**
 * clowder-ai#768: the client/account/model precedence as one transformation.
 *
 * Cross-family review (terra) asked for this to be testable in isolation rather than
 * re-derived per editor path, because the original defects were the same rule applied
 * differently in two places.
 */
import { describe, expect, it } from 'vitest';
import { clientSwitchPatch, modelScopeKey, resolveScopedDefaultModel } from '../hub-cat-editor.client-scope';
import type { HubCatEditorFormState } from '../hub-cat-editor.model';

const form = (over: Partial<HubCatEditorFormState> = {}): HubCatEditorFormState =>
  ({
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-7',
    provider: 'anthropic',
    cliEffort: 'high',
    codexCarrier: 'exec_json',
    accountRef: 'builtin_anthropic',
    acpEnabled: false,
    acpCommand: '',
    acpStartupArgs: '',
    ...over,
  }) as HubCatEditorFormState;

describe('clientSwitchPatch', () => {
  it('drops every field scoped to the client being left', () => {
    const patch = clientSwitchPatch(form(), 'openai');
    expect(patch.clientId).toBe('openai');
    expect(patch.defaultModel).toBe('');
    expect(patch.provider).toBe('');
    expect(patch.cliEffort).toBe('');
    expect(patch.codexCarrier).toBe('');
  });

  it('turns off a transport the next client cannot show', () => {
    // opencode offers CLI/ACP; anthropic does not, so its selector is hidden — a
    // surviving acpEnabled would be saved by buildAcpPatch() with nothing on screen.
    const patch = clientSwitchPatch(form({ clientId: 'opencode', acpEnabled: true }), 'anthropic');
    expect(patch.acpEnabled).toBe(false);
  });

  it('keeps ACP on when the next client also offers it, re-defaulting the command', () => {
    const patch = clientSwitchPatch(form({ clientId: 'opencode', acpEnabled: true, acpCommand: 'opencode' }), 'kimi');
    expect(patch.acpEnabled).toBe(true);
    expect(patch.acpCommand).toBe('kimi');
  });

  it('preserves an ACP command the user customized', () => {
    const patch = clientSwitchPatch(form({ clientId: 'opencode', acpEnabled: true, acpCommand: 'my-agent' }), 'kimi');
    expect(patch.acpCommand).toBeUndefined();
  });

  it('forces ACP on for the transport-only client', () => {
    expect(clientSwitchPatch(form(), 'acp').acpEnabled).toBe(true);
  });
});

describe('resolveScopedDefaultModel', () => {
  const base = {
    currentModel: '',
    accountModels: [] as string[],
    templateDefaultModel: undefined,
    scopeChanged: false,
  };

  it('prefers the account model list over the template default', () => {
    expect(
      resolveScopedDefaultModel({ ...base, accountModels: ['glm-5.2'], templateDefaultModel: 'claude-opus-4-7' }),
    ).toBe('glm-5.2');
  });

  it('falls back to the template default when the account exposes no models', () => {
    expect(resolveScopedDefaultModel({ ...base, templateDefaultModel: 'gemini-3.1-pro' })).toBe('gemini-3.1-pro');
  });

  it('keeps a user value while the scope is unchanged', () => {
    expect(
      resolveScopedDefaultModel({
        ...base,
        currentModel: 'my-custom-model',
        accountModels: ['glm-5.2'],
        scopeChanged: false,
      }),
    ).toBeNull();
  });

  it('re-resolves once the scope changes, so a template default cannot outlive its account', () => {
    // The #768 failure: an API-key account leaves provider empty, so a bare foreign
    // model id fails save validation and the template-created member cannot be saved.
    expect(
      resolveScopedDefaultModel({
        ...base,
        currentModel: 'claude-opus-4-7',
        accountModels: ['glm-5.2'],
        templateDefaultModel: 'claude-opus-4-7',
        scopeChanged: true,
      }),
    ).toBe('glm-5.2');
  });

  it('reports no change when the resolved model already matches', () => {
    expect(
      resolveScopedDefaultModel({ ...base, currentModel: 'glm-5.2', accountModels: ['glm-5.2'], scopeChanged: true }),
    ).toBeNull();
  });

  it('leaves the field alone when nothing can be resolved', () => {
    expect(resolveScopedDefaultModel({ ...base, currentModel: 'kept', scopeChanged: true })).toBeNull();
  });
});

describe('modelScopeKey', () => {
  it('separates client from account so either change re-resolves', () => {
    expect(modelScopeKey('anthropic', 'a')).not.toBe(modelScopeKey('openai', 'a'));
    expect(modelScopeKey('anthropic', 'a')).not.toBe(modelScopeKey('anthropic', 'b'));
  });
});
