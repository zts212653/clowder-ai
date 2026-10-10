import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { buildCatPayload, initialState } from '../hub-cat-editor.model';
import { buildMemberPatchPayload as buildCatPatchPayload } from '../hub-cat-editor.payload';

const member = {
  id: 'partner',
  name: '伙伴',
  displayName: '伙伴',
  clientId: 'openai',
  configurationSource: 'native_tool',
  accountRef: 'company-codex',
  defaultModel: '',
  avatar: '/avatars/default.png',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@partner'],
  roleDescription: '共同解决问题',
  personality: '细心',
  cli: { command: 'codex', outputFormat: 'json', effort: 'high', carrier: 'app_server' },
  voiceConfig: { voice: 'voice-1', langCode: 'zh', speed: 1 },
  contextWindow: 128000,
  sessionChain: true,
  mcpSupport: true,
} as CatData;

describe('member preferences and execution identity are independent', () => {
  it('keeps the chosen account while inheriting model and restoring effort', () => {
    expect(buildCatPatchPayload({ ...initialState(member), cliEffort: '' }, member)).toEqual({ cli: { effort: null } });
  });
  it('persists a selected native identity on creation', () => {
    const form = { ...initialState(member), cliEffort: '', defaultModel: '' };
    expect(buildCatPayload(form)).toMatchObject({ accountRef: 'company-codex', defaultModel: '' });
  });
  it('only writes the edited preference, preserving voice and other configuration', () => {
    expect(buildCatPatchPayload({ ...initialState(member), cliEffort: 'low' }, member)).toEqual({
      cli: { effort: 'low' },
    });
  });
  it('changing a name does not normalize hidden ACP settings', () => {
    const acp = {
      ...member,
      clientId: 'acp',
      cli: undefined,
      acp: {
        command: 'node',
        startupArgs: ['C:/my tool/bin.js', '--profile', 'acp'],
        supportsMultiplexing: true,
        pool: { idleTtlMs: 61000 },
      },
    } as CatData;
    expect(buildCatPatchPayload({ ...initialState(acp), name: '新名字', displayName: '新名字' }, acp)).toEqual({
      name: '新名字',
      displayName: '新名字',
    });
  });
  it('editing one ACP pool field preserves the exact unedited timeout', () => {
    const acp = {
      ...member,
      clientId: 'acp',
      cli: undefined,
      acp: {
        command: 'node',
        startupArgs: ['entry.js', '--profile', 'acp'],
        pool: { maxLiveProcesses: 1, idleTtlMs: 61000 },
      },
    } as CatData;
    const payload = buildCatPatchPayload({ ...initialState(acp), acpMaxLiveProcesses: '2' }, acp);
    expect(payload.acp).toMatchObject({ pool: { maxLiveProcesses: 2, idleTtlMs: 61000 } });
  });
});
