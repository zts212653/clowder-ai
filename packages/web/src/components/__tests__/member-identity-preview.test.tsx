import { createCatId, resolveMemberIdentity } from '@cat-cafe/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MemberIdentityPreview } from '../settings/MemberIdentityPreview';

it('shows authoritative values, field sources and the suppressed dossier block', () => {
  const value = resolveMemberIdentity(
    {
      id: createCatId('preview'),
      name: 'Partner',
      displayName: 'Partner',
      clientId: 'acp',
      carrier: 'acp',
      avatar: '',
      color: { primary: '', secondary: '' },
      mentionPatterns: ['@preview'],
      defaultModel: '',
      mcpSupport: false,
      roleDescription: '新角色',
      personality: '',
      teamStrengths: '新定位',
      identitySources: { roleDescription: 'variant', personality: 'variant' },
    },
    { entityId: 'cat:preview', l0SelfDescription: '旧自述', l0RosterSummary: '旧定位' },
  );
  const html = renderToStaticMarkup(<MemberIdentityPreview value={value} />);
  expect(html).toContain('新角色');
  expect(html).toContain('角色：成员配置');
  expect(html).toContain('（空）');
  expect(html).toContain('档案自述');
  expect(html).toContain('后续调用');
  expect(html).not.toContain('旧自述');
  expect(html).not.toContain('旧定位');
});
