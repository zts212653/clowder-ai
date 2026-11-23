import { describe, expect, it } from 'vitest';
import { buildAgyProfilePatch } from '../hub-cat-editor.agy';
import { initialState } from '../hub-cat-editor.model';
import { buildCatPayload } from '../hub-cat-editor.payload';

describe('hub-cat-editor AGY Native Neon & Windows paths', () => {
  it('accepts Windows absolute paths and gemini-4-neon-xhigh model IDs', () => {
    const form = {
      ...initialState(),
      catId: 'gemini-neon',
      name: 'Gemini Neon',
      displayName: '霓虹暹罗',
      mentionPatterns: '@neon',
      clientId: 'google' as const,
      carrier: 'cli' as const,
      configurationSource: 'managed_account' as const,
      accountRef: 'gemini',
      defaultModel: 'gemini-4-neon-xhigh',
      cliEffort: 'xhigh',
      agyNativeEnabled: true,
      agyProfileEnabled: true,
      agyProfileId: 'gemini-neon',
      agyAutoApprove: false,
      agyHomeRoot: 'C:\\Users\\Edgar\\.cat-cafe\\agy-profiles',
      agyTrustedWorkspaces: 'D:\\CatWorkSpace\\clowder-ai\n\\\\server\\share\\repo',
    };

    const agyPatch = buildAgyProfilePatch(form, null, 'oauth');
    expect(agyPatch).toEqual({
      agyProfile: {
        enabled: true,
        carrier: 'native',
        profileId: 'gemini-neon',
        homeRoot: 'C:\\Users\\Edgar\\.cat-cafe\\agy-profiles',
        model: 'gemini-4-neon-xhigh',
        autoApprove: false,
        trustedWorkspaces: ['D:\\CatWorkSpace\\clowder-ai', '\\\\server\\share\\repo'],
      },
    });

    const payload = buildCatPayload(form, null, { accountAuthType: 'oauth' }) as Record<string, unknown>;
    expect(payload.cli).toEqual({ effort: 'xhigh' });
    expect(payload.cliConfigArgs).toBeUndefined();
    expect(payload.defaultModel).toBe('gemini-4-neon-xhigh');
  });

  it('rejects relative workspace and profile root paths', () => {
    const form = {
      ...initialState(),
      catId: 'gemini-neon',
      clientId: 'google' as const,
      carrier: 'cli' as const,
      defaultModel: 'gemini-4-neon-xhigh',
      agyNativeEnabled: true,
      agyProfileEnabled: true,
      agyAutoApprove: false,
      agyTrustedWorkspaces: 'relative/path',
    };

    expect(() => buildAgyProfilePatch(form, null, 'oauth')).toThrow('Profile 根目录和批准工作区必须使用绝对路径');
  });
});
