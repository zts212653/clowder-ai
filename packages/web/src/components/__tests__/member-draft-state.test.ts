import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { initialState } from '../hub-cat-editor.model';
import { buildMemberPatchPayload } from '../hub-cat-editor.payload';
import {
  type MemberDraft,
  persistMemberDraft,
  readMemberDraft,
  rebaseMemberDraft,
} from '../settings/members/member-editor-state';
import { type RuntimeChoice, switchMemberRuntime } from '../settings/members/member-runtime-draft';

const original = {
  id: 'draft',
  name: '伙伴',
  displayName: '伙伴',
  clientId: 'openai',
  carrier: 'cli',
  configurationSource: 'native_tool',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@draft'],
  defaultModel: '',
  accountRef: 'company',
  personality: '认真',
  configurationRevision: 'before',
  cli: { effort: 'high' },
} as CatData;

describe('member drafts survive navigation and concurrent edits', () => {
  it('isolates AGY profile permissions per tool and restores the exact persisted profile draft', () => {
    const agy = {
      ...original,
      clientId: 'google',
      carrier: 'acp',
      defaultModel: 'gemini-4-argon-high',
      agyProfile: {
        enabled: false,
        carrier: 'acp',
        profileId: 'isolated-argon',
        homeRoot: '/profiles',
        model: 'gemini-4-argon-high',
        autoApprove: true,
        trustedWorkspaces: ['/approved'],
      },
      acp: { command: '/installed/agy_acp_server.par', startupArgs: [] },
    } as CatData;
    const start: MemberDraft = {
      version: 1,
      baseline: agy,
      form: initialState(agy),
      section: 'advanced',
      templateId: null,
    };
    const away = switchMemberRuntime(start, {
      id: 'codex',
      label: 'Codex',
      clientId: 'openai',
      installed: true,
      models: [],
    });
    expect(away.form.agyAcpEnabled).toBe(false);
    expect(away.form.agyAutoApprove).toBe(false);
    expect(away.form.agyHomeRoot).toBe('');
    persistMemberDraft('agy-roundtrip', away);
    const back = switchMemberRuntime(readMemberDraft('agy-roundtrip')!, {
      id: 'agy',
      label: 'AGY ACP',
      clientId: 'google',
      installed: true,
      models: [],
      acp: { command: agy.acp!.command, startupArgs: [] },
    });
    expect(back.form).toEqual(start.form);
    expect(buildMemberPatchPayload(back.form, agy)).toEqual({});
  });
  it('preserves ACP commands, pool settings and hidden extensions across a persisted runtime round trip', () => {
    const acpCat = {
      ...original,
      clientId: 'acp',
      carrier: 'acp',
      acp: {
        command: 'C:/tools/node.exe',
        startupArgs: ['C:/tools/dsh cli.js', '--profile', 'acp'],
        transport: 'stdio',
        pool: { maxLiveProcesses: 1, idleTtlMs: 123456 },
        env: { CUSTOM: 'keep' },
      },
    } as CatData;
    const dsh: RuntimeChoice = {
      id: 'dsh',
      label: 'DSH',
      clientId: 'acp',
      models: [],
      installed: true,
      acp: { command: acpCat.acp!.command, startupArgs: acpCat.acp!.startupArgs },
    };
    const codex: RuntimeChoice = { id: 'codex', label: 'Codex', clientId: 'openai', models: [], installed: true };
    const start: MemberDraft = {
      version: 1,
      baseline: acpCat,
      form: initialState(acpCat),
      section: 'runtime',
      templateId: null,
    };
    const away = switchMemberRuntime(start, codex);
    away.form.defaultModel = 'my-codex-model';
    away.form.nickname = 'new nickname';
    persistMemberDraft('acp-roundtrip', away);
    const back = switchMemberRuntime(readMemberDraft('acp-roundtrip')!, dsh);
    expect(buildMemberPatchPayload(back.form, acpCat)).toEqual({ nickname: 'new nickname' });
    expect(switchMemberRuntime(back, codex).form.defaultModel).toBe('my-codex-model');
  });
  it('keeps the selected account, local effort and section when returning from account management', () => {
    const draft: MemberDraft = {
      version: 1,
      baseline: original,
      form: { ...initialState(original), cliEffort: 'low' },
      section: 'context',
      templateId: null,
    };
    expect(persistMemberDraft('instance-a:user-a:member', draft)).toBe(true);
    expect(readMemberDraft('instance-a:user-a:member')).toEqual(draft);
    expect(readMemberDraft('instance-b:user-a:member')).toBeNull();
  });
  it('rebases only edited fields and reads concurrent untouched changes from the server', () => {
    const draft: MemberDraft = {
      version: 1,
      baseline: original,
      form: { ...initialState(original), cliEffort: 'low' },
      section: 'runtime',
      templateId: null,
    };
    const latest = {
      ...original,
      name: '新名字',
      displayName: '新名字',
      accountRef: 'personal',
      configurationRevision: 'after',
    };
    const next = rebaseMemberDraft(draft, latest);
    expect(next.form).toMatchObject({ cliEffort: 'low', name: '新名字', accountRef: 'personal' });
    expect(next.baseline?.configurationRevision).toBe('after');
  });
  it('does not treat migration of an old carrier as a local edit during rebase', () => {
    const baseline = { ...original, cli: { ...original.cli, carrier: 'app_server' } };
    const form = { ...initialState(original), nickname: 'local nickname', codexCarrier: 'app_server' };
    Reflect.deleteProperty(baseline, 'carrier');
    Reflect.deleteProperty(form, 'carrier');
    sessionStorage.setItem(
      'legacy-carrier-rebase',
      JSON.stringify({
        version: 1,
        baseline,
        form,
        section: 'runtime',
        templateId: null,
      }),
    );
    const draft = readMemberDraft('legacy-carrier-rebase')!;
    const latest = { ...original, carrier: 'cli' as const, configurationRevision: 'after' };
    const rebased = rebaseMemberDraft(draft, latest);
    expect(rebased.form).toMatchObject({ nickname: 'local nickname', carrier: 'cli' });
    expect(buildMemberPatchPayload(rebased.form, latest)).toEqual({ nickname: 'local nickname' });
  });
});
