import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { recommendNativePartners } from '../native-onboarding';

const templates = [
  { id: 'ragdoll', name: '布偶猫', nickname: '宪宪' },
  { id: 'maine-coon', name: '缅因猫', nickname: '砚砚' },
].map((template) => ({
  ...template,
  avatar: '',
  color: { primary: '#123456', secondary: '#abcdef' },
  roleDescription: '伙伴',
  personality: '可靠',
}));
const runtimes = [
  { id: 'claude', label: 'Claude Code', clientId: 'anthropic' as const, installed: true, models: ['opus'] },
  {
    id: 'codex',
    label: 'Codex',
    clientId: 'openai' as const,
    installed: true,
    configuredModel: 'configured',
    models: ['configured'],
  },
  {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: true,
    models: [],
    acp: { command: 'node', startupArgs: ['dsh.js', '--profile', 'acp'] },
  },
];

describe('native onboarding recommendations', () => {
  it('keeps distinct tools needing ACP setup visible instead of deduplicating absent descriptors', () => {
    const pending = ['DSH', 'Pi'].map((label) => ({
      id: label.toLowerCase(),
      label,
      clientId: 'acp' as const,
      installed: true,
      models: [],
    }));
    expect(recommendNativePartners(pending, templates, [], 'journey').map((p) => p.runtime.label)).toEqual([
      'DSH',
      'Pi',
    ]);
  });
  it('never treats a real short-hash collision as the same ACP partner', () => {
    const peers = ['1e1unfl', 'hlxo45'].map((profile) => ({
      ...runtimes[2],
      label: 'DSH',
      acp: { command: 'dsh', startupArgs: ['--profile', profile], transport: 'stdio' as const },
    }));
    const partners = recommendNativePartners(peers, templates, [], 'journey-123456');
    expect(new Set(partners.map((p) => p.id)).size).toBe(2);
    expect(partners.map((p) => p.form.catId)).toEqual(['dsh', 'dsh-2']);
  });
  it('allocates short IDs in the complete existing namespace without changing runtime descriptors', () => {
    const existing = [
      {
        id: 'codex',
        carrier: 'cli' as const,
        displayName: 'Existing Codex',
        clientId: 'openai',
        defaultModel: 'old-model',
        avatar: '',
        color: { primary: '#123456', secondary: '#abcdef' },
        roleDescription: '',
        personality: '',
        configurationSource: 'managed_account',
        mentionPatterns: [],
        roster: { available: false, family: 'codex', roles: ['assistant'], lead: false, evaluation: '' },
      },
    ] satisfies CatData[];
    const partners = recommendNativePartners(
      [...runtimes, { ...runtimes[2], id: 'dsh-other', acp: { command: 'node', startupArgs: ['other.js'] } }],
      templates,
      existing,
      'journey-123456',
    );
    expect(partners.map((p) => p.form.catId)).toEqual(['claude-code', 'codex-2', 'dsh', 'dsh-2']);
    expect(partners[3].form.acpStartupArgs).toContain('other.js');
  });
  it('reserves aliases case-insensitively across existing and newly recommended partners', () => {
    const existing = { id: 'legacy', configurationSource: 'managed_account', mentionPatterns: ['@Codex'] } as CatData;
    const partners = recommendNativePartners(
      [...runtimes, { ...runtimes[2], id: 'dsh-other', acp: { command: 'node', startupArgs: ['other-dsh.js'] } }],
      templates,
      [existing],
      'journey-123456',
    );
    expect(partners.find((p) => p.id === 'codex')?.form.mentionPatterns).toBe('@codex-2');
    expect(partners.filter((p) => p.runtime.clientId === 'acp').map((p) => p.form.mentionPatterns)).toEqual([
      '@dsh',
      '@dsh-2',
    ]);
  });
  it('recommends all three real tools with independent roles and inherited defaults', () => {
    const partners = recommendNativePartners(runtimes, templates, [], 'journey-123456');
    expect(partners).toHaveLength(3);
    expect(partners.every((p) => p.selected)).toBe(true);
    expect(new Set(partners.map((p) => p.form.catId)).size).toBe(3);
    for (const partner of partners) {
      const payload = buildCatPayload(partner.form);
      expect(payload.configurationSource).toBe('native_tool');
      expect(payload.defaultModel).toBe('');
      expect(payload.accountRef).toBeUndefined();
      expect(payload).not.toHaveProperty('cli.effort');
    }
    expect(buildCatPayload(partners[2].form)).toHaveProperty('acp', runtimes[2].acp);
  });
  it('does not select unavailable tools or unsafe ACP descriptors', () => {
    const partners = recommendNativePartners(
      [
        { ...runtimes[0], installed: false },
        { ...runtimes[2], acp: undefined },
      ],
      templates,
      [],
      'journey-123456',
    );
    expect(partners.every((p) => !p.selected)).toBe(true);
  });
  it('deduplicates DSH descriptors and preserves stable retry identities', () => {
    const partners = recommendNativePartners(
      [...runtimes, { ...runtimes[2], id: 'acp:existing' }],
      templates,
      [],
      'journey-123456',
    );
    expect(partners).toHaveLength(3);
    expect(partners.map((p) => p.form.catId)).toEqual(
      recommendNativePartners(runtimes, templates, [], 'journey-123456').map((p) => p.form.catId),
    );
  });
  it('retains the DSH retry id after the runtime becomes a registered ACP member', () => {
    const first = recommendNativePartners([runtimes[2]], templates, [], 'journey-123456')[0];
    const restored = recommendNativePartners(
      [{ ...runtimes[2], id: 'acp:created-member', acp: { ...runtimes[2].acp!, transport: 'stdio' as const } }],
      templates,
      [],
      'journey-123456',
    )[0];
    expect(restored.id).toBe(first.id);
    expect(restored.form.catId).toBe(first.form.catId);
  });
});
