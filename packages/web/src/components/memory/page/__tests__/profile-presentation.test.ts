import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ProfileMemoryRead } from '../owner-memory-read';
import { profileIdentity, profileSections, profileText } from '../profile-presentation';

const entry = { layer: 'primer', relationshipKey: 'astra' } as ProfileMemoryRead;
const cats = [
  { id: 'astra-v2', relationshipKey: 'astra', nickname: '小星星', displayName: 'Astra', defaultModel: 'v2' },
  { id: 'other', relationshipKey: 'other', nickname: '小星星', displayName: 'Other', defaultModel: 'other-v1' },
] as CatData[];
describe('profile reading projection', () => {
  it('resolves stable relationship ownership without merging same-name cats', () => {
    const identity = profileIdentity(entry, cats, true);
    expect(identity.title).toBe('与 小星星 的关系画像');
    expect(identity.members.map((cat) => cat.id)).toEqual(['astra-v2']);
    expect(identity.memberLabels).toBe('Astra（v2）');
    expect(profileIdentity({ ...entry, relationshipKey: 'archived-unknown' }, cats, true).members).toEqual([]);
  });
  it('keeps unread membership unknown and only labels a verified missing association as unlinked', () => {
    const unread = profileIdentity(entry, [], false);
    expect(unread.title).toBe('关系画像');
    expect(unread.memberNotice).toBe('成员资料尚未读到');
    expect(unread.members).toEqual([]);
    expect(profileIdentity(entry, [], true).title).toBe('未关联成员的关系画像');
  });
  it('does not infer a relationship key from a matching cat id', () => {
    const missingKey = { ...cats[0], id: entry.relationshipKey, relationshipKey: undefined } as CatData;
    expect(profileIdentity(entry, [missingKey], true).members).toEqual([]);
    expect(profileIdentity(entry, [missingKey], true).title).toBe('未关联成员的关系画像');
  });
  it('keeps card summaries readable without document headings or spaces around inline markup', () => {
    expect(profileText('# 共同画像\n## 相处方式\n先给**结论**，再展开。\n\n![一张木制书架](/bookcase.png)。')).toBe(
      '先给结论，再展开。一张木制书架。',
    );
  });
  it('uses the same friendly member identity as message signatures', () => {
    const member = {
      ...cats[0],
      displayName: '缅因猫 Sol',
      variantLabel: 'GPT-6.1 Sol',
      defaultModel: 'gpt-6.1-sol',
    };
    expect(profileIdentity(entry, [member], true).memberLabels).toBe('缅因猫 Sol（GPT-6.1 Sol）');
  });
  it('keeps western words separated across hard breaks without inserting spaces between Chinese blocks', () => {
    expect(profileText('hello  \nworld\n\nnext **step**')).toBe('hello world next step');
    expect(profileText('第一行  \n第二行\n\n称呼。\n\n示范对象。')).toBe('第一行第二行称呼。示范对象。');
    expect(profileText('保留 **GPT 6.1** 名称。')).toBe('保留 GPT 6.1 名称。');
  });
  it('renders headings and lists as sections while retaining fenced headings as literal content', () => {
    const content =
      '---\nprivate: metadata\n---\n# 关系\n简介。\n## 相处\n- **慢慢讲**\n- 先看图\n## 示例\n```md\n## 只是代码\n```';
    const sections = profileSections(content);
    expect(sections.map((section) => section.title)).toEqual(['', '相处', '示例']);
    expect(sections[0].body).toBe('简介。');
    expect(sections[1].body).toContain('**慢慢讲**');
    expect(sections[2].body).toContain('## 只是代码');
    expect(profileText(content)).not.toMatch(/private:|\*\*/);
  });
});
