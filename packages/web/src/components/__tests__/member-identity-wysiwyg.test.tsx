import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { initialState } from '../hub-cat-editor.model';
import { buildMemberPatchPayload } from '../hub-cat-editor.payload';
import { MemberAdditionalFields } from '../settings/members/MemberAdditionalFields';

const member = {
  id: 'opus55',
  name: 'Opus',
  displayName: 'Opus',
  nickname: '宪宪',
  clientId: 'anthropic',
  carrier: 'cli',
  defaultModel: 'opus',
  avatar: '',
  color: { primary: '', secondary: '' },
  mentionPatterns: ['@opus55'],
  roleDescription: '负责架构',
  personality: '温柔',
  teamStrengths: '自己的分工',
  caution: '',
  strengths: ['保留旧标签'],
  identitySources: {
    roleDescription: 'variant',
    personality: 'template',
    teamStrengths: 'variant',
    caution: 'template',
  },
  identityProfile: { entityId: 'cat:opus55', l0RosterSummary: '画像里的分工', l0RoutingNote: '画像里的限制' },
} satisfies CatData & { identitySources: object; identityProfile: object };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(cat: CatData = member) {
  function Editor() {
    const [form, setForm] = useState(initialState(cat));
    return (
      <MemberAdditionalFields
        section="identity"
        cat={cat}
        form={form}
        patch={(p) => setForm((f) => ({ ...f, ...p }))}
        t={(zh) => zh}
        editing
        strategy={null}
        patchStrategy={() => {}}
      />
    );
  }
  await act(async () => root.render(<Editor />));
}
function area(label: string) {
  const field = [...host.querySelectorAll('label')].find((el) =>
    el.querySelector('span')?.textContent?.startsWith(label),
  );
  return field?.querySelector('textarea') as HTMLTextAreaElement;
}
async function fill(label: string, value: string) {
  await act(async () => {
    const field = area(label);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('groups the shared form and shows provenance beside the actual effective roster values', async () => {
  await render();
  expect([...host.querySelectorAll('[data-member-identity-fields] h3')].map((el) => el.textContent)).toEqual([
    '人设',
    '名册',
  ]);
  expect(host.textContent).not.toContain('更多角色设置');
  expect(host.textContent).not.toContain('保留旧标签');
  expect(area('限制与注意事项').placeholder).toBe('画像里的限制');
  expect(host.textContent).toContain('替代了能力画像里的「画像里的分工」');
  expect(host.textContent).toContain('默认');
  expect(host.querySelector('a[href="/settings?s=profiles#profile-opus55"]')).not.toBeNull();
  const labels = [...host.querySelectorAll('label > span')].map((el) => el.textContent);
  expect(labels.indexOf('版本备注')).toBe(labels.indexOf('昵称') + 1);
});

it('shows a draft override immediately and restores the profile by clearing that field', async () => {
  await render();
  await fill('限制与注意事项', '这回只做审查');
  expect(host.textContent).toContain('替代了能力画像里的「画像里的限制」');
  const field = area('限制与注意事项').closest('label')!;
  const reset = [...field.querySelectorAll('button')].find((el) => el.textContent === '改用能力画像');
  expect(reset).toBeDefined();
  await act(async () => reset!.click());
  expect(area('限制与注意事项').value).toBe('');
  expect(area('限制与注意事项').placeholder).toBe('画像里的限制');
  expect(field.textContent).not.toContain('替代了');
});

it('shows role fallback and an honest missing-profile link without inventing a profile', async () => {
  await render({ ...member, id: 'deepseek-flash', teamStrengths: '', identityProfile: null });
  expect(area('团队分工').placeholder).toBe('负责架构');
  expect(host.textContent).toContain('沿用职责');
  expect(host.textContent).toContain('还没有能力画像');
  await fill('职责', '新的职责');
  expect(area('团队分工').placeholder).toBe('新的职责');
  expect(host.textContent).not.toContain('替代了');
});

it('does not present an ignored template sentence as the effective profile text', async () => {
  await render({
    ...member,
    teamStrengths: '旧模板',
    identitySources: { teamStrengths: 'template', caution: 'template' },
  });
  expect(area('团队分工').value).toBe('');
  expect(area('团队分工').placeholder).toBe('画像里的分工');
  expect(host.textContent).not.toContain('替代了');
});

it('can author the old template wording from an inherited empty field', async () => {
  await render({
    ...member,
    teamStrengths: '旧模板',
    identitySources: { teamStrengths: 'template', caution: 'template' },
  });
  await fill('团队分工', '旧模板');
  expect(area('团队分工').value).toBe('旧模板');
  expect(host.textContent).toContain('替代了能力画像里的「画像里的分工」');
});

it('keeps inherited text out of unrelated saves while allowing that exact wording to be authored', () => {
  const cat = {
    ...member,
    teamStrengths: '旧模板',
    identitySources: { teamStrengths: 'template' as const, caution: 'template' as const },
  };
  const form = initialState(cat);
  expect(form.teamStrengths).toBe('');
  expect(buildMemberPatchPayload({ ...form, nickname: '新昵称' }, cat)).not.toHaveProperty('teamStrengths');
  expect(buildMemberPatchPayload({ ...form, teamStrengths: '旧模板' }, cat)).toMatchObject({ teamStrengths: '旧模板' });
});

it('marks a template nickname as default and updates its source when edited', async () => {
  await render({ ...member, identitySources: { ...member.identitySources, nickname: 'template' } });
  const field = [...host.querySelectorAll('label')].find((el) =>
    el.querySelector('span')?.textContent?.startsWith('昵称'),
  );
  expect(field?.textContent).toContain('默认');
  const input = field?.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '自己写的昵称');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(field?.textContent).not.toContain('默认');
});
