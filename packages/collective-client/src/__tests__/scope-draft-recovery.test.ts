// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest';
import { recoverOwnScopeDrafts } from '../collective-scope-recovery.js';

afterEach(() => localStorage.clear());

it('recovers only this Human and service scope, without retained quote or recipient references', () => {
  const scope = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    humanId: 'human_aaaaaaaa',
    reason: 'membership_lost' as const,
  };
  const ownKey = 'collective-draft:svc_aaaaaaaa:col_aaaaaaaa:human_aaaaaaaa:general:evt_source';
  const wrongKeys = [
    'collective-draft:svc_aaaaaaaa:col_aaaaaaaa:human_bbbbbbbb:general:channel',
    'collective-draft:svc_bbbbbbbb:col_aaaaaaaa:human_aaaaaaaa:general:channel',
    'collective-draft:svc_aaaaaaaa:col_bbbbbbbb:human_aaaaaaaa:general:channel',
  ];
  localStorage.setItem(
    ownKey,
    JSON.stringify({
      body: '自己没发出的话',
      recipient: { kind: 'agent', agentId: 'sol' },
      recipientLabel: 'Sol',
      replyToEventId: 'evt_private',
      artifactSelections: [{ quote: '不可再查看的正文' }],
    }),
  );
  for (const key of wrongKeys) localStorage.setItem(key, JSON.stringify({ body: '别的现场或别人的草稿' }));
  localStorage.setItem(`${ownKey}-malformed`, '{');
  expect(recoverOwnScopeDrafts(scope)).toEqual([{ key: ownKey, body: '自己没发出的话' }]);
  expect(JSON.parse(localStorage.getItem(ownKey) ?? 'null')).toEqual({
    body: '自己没发出的话',
    recipient: { kind: 'channel' },
    recipientLabel: '',
  });
  for (const key of wrongKeys) expect(localStorage.getItem(key)).toContain('别的现场或别人的草稿');
});
