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
      sol: { displayLabel: '小太阳', description: '复杂实现', avatarDataUrl: 'data:image/webp;base64,UklGRg==' },
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
      displayLabel: '小太阳',
      channelIds: ['general', 'second'],
      description: '复杂实现',
      avatarDataUrl: 'data:image/webp;base64,UklGRg==',
    },
  ]);
  expect(collectiveParticipationDeclarationSchema.parse(declaration)).toEqual(declaration);
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
      {
        displayLabel: '中'.repeat(120),
        description: '中'.repeat(120),
        avatarDataUrl: `data:image/webp;base64,${'A'.repeat(1_176)}`,
      },
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

it('publishes optional short names on a legacy materialized route and rejects invalid labels', () => {
  const connection = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    authorizedHumanId: 'human_a',
  } as ConnectorConnectionState;
  const route = {
    revision: 1,
    agentRoutes: {
      'human_a:sol': {
        catId: 'sol',
        threadId: 'private',
        participation: { displayName: 'Sol full identity', channelIds: ['general'] },
      },
    },
    publicProfiles: { sol: { displayLabel: '砚砚' }, hidden: { displayLabel: 'Private' } },
  } as HostRouteConfig;
  expect(participationDeclaration(connection, route).agents).toEqual([
    { catId: 'sol', displayName: 'Sol full identity', displayLabel: '砚砚', channelIds: ['general'] },
  ]);
  for (const displayLabel of ['', '  ', '中'.repeat(121)])
    expect(() =>
      collectiveParticipationDeclarationSchema.parse({
        ...participationDeclaration(connection, route),
        agents: [{ catId: 'sol', displayName: 'Sol', displayLabel, channelIds: ['general'] }],
      }),
    ).toThrow();
  expect(
    collectiveParticipationDeclarationSchema.parse({
      ...participationDeclaration(connection, route),
      agents: [{ catId: 'sol', displayName: 'Sol', channelIds: ['general'] }],
    }).agents[0],
  ).not.toHaveProperty('displayLabel');
});
