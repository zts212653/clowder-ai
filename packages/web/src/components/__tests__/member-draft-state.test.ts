import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { initialState } from '../hub-cat-editor.model';
import {
  type MemberDraft,
  persistMemberDraft,
  readMemberDraft,
  rebaseMemberDraft,
} from '../settings/members/member-editor-state';

const original = {
  id: 'draft',
  name: '伙伴',
  displayName: '伙伴',
  clientId: 'openai',
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
});
