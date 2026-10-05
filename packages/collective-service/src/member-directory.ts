import type { CollectiveMemberDirectory } from '@cat-cafe/shared';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { ServiceState } from './state.js';

export function readMemberDirectory(
  state: ServiceState,
  sessionToken: string,
  collectiveId: string,
): CollectiveMemberDirectory {
  const { human } = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  requireMembership(state, collectiveId, human.humanId);
  const humans = Object.values(state.memberships)
    .filter((membership) => membership.collectiveId === collectiveId && membership.status === 'active')
    .flatMap((membership) => {
      const member = state.humans[membership.humanId];
      return member
        ? [
            {
              humanId: member.humanId,
              displayName: member.displayName,
              role: membership.role,
              ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
            },
          ]
        : [];
    });
  const memberIds = new Set(humans.map((member) => member.humanId));
  const cafes = Object.values(state.connections).flatMap((connection) =>
    connection.collectiveId === collectiveId &&
    connection.status === 'connected' &&
    connection.authorizedHumanId &&
    memberIds.has(connection.authorizedHumanId)
      ? [
          {
            connectionId: connection.connectionId,
            endpointId: connection.endpointId,
            endpointLabel: connection.endpointLabel,
            humanId: connection.authorizedHumanId,
          },
        ]
      : [],
  );
  return { humans, cafes };
}
