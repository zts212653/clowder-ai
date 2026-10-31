import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MemberPanel } from '../MemberPanel.js';

it('shows a joined member who has never posted, without deriving membership from message authors', () => {
  const html = renderToStaticMarkup(
    <MemberPanel
      member="members"
      members={{
        humans: [{ humanId: 'human_aaaaaaaa', displayName: '安静看讨论的新朋友', role: 'member' }],
        cafes: [],
      }}
      participants={[]}
      events={[]}
      onSelect={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(html).toContain('安静看讨论的新朋友');
  expect(html).not.toContain('这里还没有消息');
});

it('uses the published Cat avatar and introduction in the member list and profile', () => {
  const avatarDataUrl = 'data:image/webp;base64,UklGRg==';
  const members = {
    humans: [{ humanId: 'human_aaaaaaaa', displayName: 'You', role: 'steward' as const }],
    cafes: [
      {
        connectionId: 'con_aaaaaaaa',
        endpointId: 'end_aaaaaaaa',
        endpointLabel: 'You 的 Café',
        humanId: 'human_aaaaaaaa',
      },
    ],
  };
  const participants = [
    {
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      endpointId: 'end_aaaaaaaa',
      endpointLabel: 'You 的 Café',
      humanId: 'human_aaaaaaaa',
      humanDisplayName: 'You',
      catId: 'sol',
      displayName: '缅因猫（Sol）',
      channelIds: ['general'],
      participationRevision: 1,
      availability: 'declared' as const,
      description: '复杂实现',
      avatarDataUrl,
    },
  ];
  const props = { members, participants, events: [], onSelect: () => undefined, onClose: () => undefined };
  const roster = renderToStaticMarkup(<MemberPanel {...props} member="members" />);
  const profile = renderToStaticMarkup(
    <MemberPanel {...props} member={{ kind: 'agent', connectionId: 'con_aaaaaaaa', catId: 'sol' }} />,
  );
  expect(roster).toContain('缅因猫（Sol）');
  expect(roster).toContain(avatarDataUrl);
  expect(profile).toContain('复杂实现');
  expect(profile).toContain(avatarDataUrl);
});
