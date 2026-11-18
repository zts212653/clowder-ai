import {
  type AgentAccessA2ASubmit,
  type AgentAccessA2ATurn,
  type AgentAccessDiscoveryHost,
  type AgentAccessRoleMutation,
  type AgentAccessRoleStore,
  agentAccessDetectRequestSchema,
  agentAccessKimiEventRequestSchema,
  agentAccessKimiLaunchRequestSchema,
  agentAccessLoginRequestSchema,
} from '@clowder-ai/agent-contract';
import { type AgentAccessAcpChildHandle, agentAccessDshConnectionInputSchema } from '@clowder-ai/agent-contract/acp';
import { builtInAgentClients, inspectNativeAccessCandidate } from './discovery/agent-client-catalog.js';
import { nativeRuntimeReadiness } from './discovery/native-runtime-readiness.js';
import { discoverNativeRuntimes } from './discovery/native-runtimes.js';

import { readRoles } from './roles/role-card.js';
import { writeRole } from './roles/write-role.js';
import { runA2ATurn } from './runtime/a2a-turn.js';
import { checkDshConnectionInWorker } from './runtime/acp/dsh/connection-check.js';
import { normalizeKimiEvent } from './runtime/kimi-event-parser.js';
import { buildKimiLaunchArguments } from './runtime/kimi-launch-arguments.js';

export default {
  create() {
    return {
      start(host: { agentAccess?: AgentAccessDiscoveryHost; agentRoleStore?: AgentAccessRoleStore }) {
        const { agentAccess: discovery, agentRoleStore } = host;
        if (!discovery) throw new Error('Agent access Host discovery port is unavailable');
        return {
          actions: {
            configure(input: unknown) {
              if (input && typeof input === 'object' && 'operation' in input) {
                const { launch } = agentAccessKimiLaunchRequestSchema.parse(input);
                return buildKimiLaunchArguments(launch);
              }
              return { clients: builtInAgentClients };
            },
            parseNativeEvent(input: unknown) {
              return normalizeKimiEvent(agentAccessKimiEventRequestSchema.parse(input).event);
            },
            testDshConnection({ input, launch }: { input: unknown; launch: () => Promise<AgentAccessAcpChildHandle> }) {
              return checkDshConnectionInWorker(agentAccessDshConnectionInputSchema.parse(input), launch);
            },
            async login(input: unknown) {
              const { id, refresh = false } = agentAccessLoginRequestSchema.parse(input);
              return inspectNativeAccessCandidate(discovery, id, refresh);
            },
            openSession(input: { resume?: { onUnavailable: 'fail' | 'start_new' } }) {
              return input.resume?.onUnavailable === 'fail'
                ? { ok: false, code: 'resume_unavailable', reason: 'remote A2A does not expose resumable sessions' }
                : { ok: true, binding: { state: 'pending_first_input' } };
            },
            cancel() {
              return { ok: false, code: 'unsupported' };
            },
            release() {
              return { ok: true };
            },
            startTurn({ input, submit }: { input: AgentAccessA2ATurn; submit: AgentAccessA2ASubmit }) {
              return runA2ATurn(input, submit);
            },
            ...(agentRoleStore
              ? {
                  readRoles: () => readRoles(agentRoleStore),
                  writeRole: (request: AgentAccessRoleMutation) => writeRole(agentRoleStore, discovery, request),
                }
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
