import {
  type AgentAccessDiscoveryHost,
  type AgentAccessRoleMutation,
  type AgentAccessRoleStore,
  agentAccessDetectRequestSchema,
} from '@clowder-ai/agent-contract';
import { nativeRuntimeReadiness } from './discovery/native-runtime-readiness.js';
import { discoverNativeRuntimes } from './discovery/native-runtimes.js';

import { writeRole } from './roles/write-role.js';

export default {
  create() {
    return {
      start(host: { agentAccess?: AgentAccessDiscoveryHost; agentRoleStore?: AgentAccessRoleStore }) {
        const { agentAccess: discovery, agentRoleStore } = host;
        if (!discovery) throw new Error('Agent access Host discovery port is unavailable');
        return {
          actions: {
            ...(agentRoleStore
              ? { writeRole: (request: AgentAccessRoleMutation) => writeRole(agentRoleStore, request) }
              : {}),
            async detect(input: unknown) {
              const { refresh } = agentAccessDetectRequestSchema.parse(input);
              const context = await discovery.readDetectionContext();
              const { runtimes } = await discoverNativeRuntimes(context);
              const observations = await Promise.allSettled(
                runtimes.map(async (runtime) => ({
                  ...runtime,
                  readiness: await nativeRuntimeReadiness(
                    runtime,
                    context.projectRoot,
                    refresh,
                    discovery.inspectNativeLogin,
                  ),
                })),
              );
              return {
                candidates: observations.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
                partialFailures: observations.flatMap((result, index) =>
                  result.status === 'rejected' ? [{ id: runtimes[index].id }] : [],
                ),
              };
            },
          },
          stop() {},
        };
      },
    };
  },
};
