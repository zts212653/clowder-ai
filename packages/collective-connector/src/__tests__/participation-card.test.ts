import { collectiveParticipationDeclarationSchema } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { participationDeclaration } from '../participation-custody.js';
import type { ConnectorConnectionState, HostRouteConfig } from '../state.js';

it('publishes the same registered Cat card in every allowed Channel without Host-private routes', () => {
  const connection = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    authorizedHumanId: 'human_a',
  } as ConnectorConnectionState;
  const route = {
    revision: 4,
    publicProfiles: {
      sol: { description: '复杂实现', avatarDataUrl: 'data:image/webp;base64,UklGRg==' },
      hidden: { description: '私人资料' },
    },
    channelRoutes: {
      general: {
        channelId: 'general',
        threadId: 'private-internal-id',
        participants: { sol: { displayName: '缅因猫（Sol）' } },
      },
      second: {
        channelId: 'second',
        threadId: 'another-private-id',
        participants: { sol: { displayName: '缅因猫（Sol）' } },
      },
    },
  } as HostRouteConfig;
  const declaration = participationDeclaration(connection, route);
  expect(declaration.agents).toEqual([
    {
      catId: 'sol',
      displayName: '缅因猫（Sol）',
      channelIds: ['general', 'second'],
      description: '复杂实现',
      avatarDataUrl: 'data:image/webp;base64,UklGRg==',
    },
  ]);
  expect(JSON.stringify(declaration)).not.toContain('private-internal-id');
  expect(JSON.stringify(declaration)).not.toContain('私人资料');
});

it('keeps the maximum admitted roster below the Service request-body ceiling', () => {
  const connection = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    authorizedHumanId: 'human_aaaaaaaa',
  } as ConnectorConnectionState;
  const participants = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`cat-${index}`, { displayName: `猫 ${index}` }]),
  );
  const publicProfiles = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `cat-${index}`,
      { description: '中'.repeat(120), avatarDataUrl: `data:image/webp;base64,${'A'.repeat(1_176)}` },
    ]),
  );
  const route = {
    revision: 1,
    publicProfiles,
    channelRoutes: { general: { channelId: 'general', threadId: 'internal', participants } },
  } as HostRouteConfig;
  const declaration = participationDeclaration(connection, route);
  expect(collectiveParticipationDeclarationSchema.parse(declaration)).toEqual(declaration);
  expect(Buffer.byteLength(JSON.stringify(declaration))).toBeLessThan(256 * 1_024);
});
