import { createPluginMessagingHost, type PluginMessagingHostDeps } from '../host-surface/plugin-messaging-host.js';
import { memberInputPayload } from './input-message.js';
import type { MemberSessionScope, MemberSessionServices } from './types.js';

/** Composition resolves the current package and Host stores. The adapter always
 * binds the execution lease at the actual send boundary, after its awaits. */
export function createMemberSessionMessaging(
  resolveHost: (scope: MemberSessionScope) => Promise<PluginMessagingHostDeps>,
): MemberSessionServices['messaging'] {
  const hostFor = async (input: MemberSessionScope) => {
    const scope = { ...input, assertCurrent: input.assertCurrent.bind(input) };
    await scope.assertCurrent();
    const deps = await resolveHost(scope);
    await scope.assertCurrent();
    return createPluginMessagingHost({
      ...deps,
      pluginInstanceId: scope.pluginInstanceId,
      ownerUserId: scope.ownerUserId,
      assertAdmissionCurrent: scope.assertCurrent,
    });
  };
  return {
    async findSent(input, scope) {
      const original = await (await hostFor(scope)).findSent(input);
      await scope.assertCurrent();
      return original;
    },
    async send(input, scope) {
      return (await hostFor(scope)).send({
        threadId: input.threadId,
        identity: input.identity,
        idempotencyKey: input.idempotencyKey,
        wake: input.wake,
        payload: memberInputPayload(input.content),
      });
    },
  };
}
