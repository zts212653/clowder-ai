import { describe, expect, it } from 'vitest';
import { buildNativeCreationPayload } from '../first-run-quest/native-creation-payload';
import { initialState } from '../hub-cat-editor.model';
import { normalizeMemberDraftForm, resolveDraftCarrier } from '../settings/members/member-carrier-compat';

describe('pre-canonical member drafts', () => {
  it('keeps canonical carrier authoritative over retired fields', () => {
    expect(resolveDraftCarrier({ clientId: 'openai', carrier: 'cli', codexCarrier: 'app_server' })).toBe('cli');
  });
  it('retains explicit exec and ACP choices without changing identity or model', () => {
    for (const [extra, carrier] of [
      [{ codexCarrier: 'exec_json' as const }, 'cli'],
      [{ acpEnabled: true }, 'acp'],
    ] as const) {
      const form = { ...initialState(), clientId: 'openai' as const, defaultModel: 'my-model', ...extra };
      const saved = { ...form };
      Reflect.deleteProperty(saved, 'carrier');
      const normalized = normalizeMemberDraftForm(saved as typeof form);
      expect(normalized.carrier).toBe(carrier);
      expect(normalized.defaultModel).toBe('my-model');
      expect(normalized).not.toHaveProperty('codexCarrier');
      expect(normalized).not.toHaveProperty('acpEnabled');
    }
  });
  it('replays the old Codex creation body without adding a canonical field to its receipt', () => {
    const canonical = {
      ...initialState(),
      clientId: 'openai' as const,
      carrier: 'app_server' as const,
      name: '伙伴',
      displayName: '伙伴',
      catId: 'codex',
      mentionPatterns: '@codex',
    };
    const saved = { ...canonical };
    Reflect.deleteProperty(saved, 'carrier');
    const payload = buildNativeCreationPayload({ ...saved, codexCarrier: 'app_server' } as unknown as typeof canonical);
    expect(payload).not.toHaveProperty('carrier');
    expect(payload.cli).toEqual({ carrier: 'app_server' });
    expect(payload.catId).toBe('codex');
    expect(buildNativeCreationPayload(canonical).carrier).toBe('app_server');
  });
  it('keeps old ACP launch args and native effort in its original creation request', () => {
    const form = initialState();
    Reflect.deleteProperty(form, 'carrier');
    const saved = {
      ...form,
      clientId: 'acp' as const,
      acpEnabled: true,
      cliEffort: 'high',
      acpCommand: 'dsh',
      acpStartupArgs: '--profile "my profile"',
    };
    const payload = buildNativeCreationPayload(saved as unknown as ReturnType<typeof initialState>);
    expect(payload).not.toHaveProperty('carrier');
    expect(payload.acp).toEqual({ command: 'dsh', startupArgs: ['--profile', 'my profile'] });
    expect(payload.cli).toEqual({ effort: 'high' });
  });
});
