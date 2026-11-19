import {
  AGENT_ACCESS_ACP_PROCESS_ACTION,
  AGENT_ACCESS_ACP_SESSION_ACTION,
  type AgentAccessA2ASubmit,
  type AgentAccessA2ATurn,
  type AgentAccessDiscoveryHost,
  type AgentAccessRoleMutation,
  type AgentAccessRoleStore,
  agentAccessCodexAppServerThreadPlanSchema,
  agentAccessCodexAppServerThreadRequestSchema,
  agentAccessCodexAppServerTurnPlanSchema,
  agentAccessCodexAppServerTurnRequestSchema,
  agentAccessCodexExecLaunchRequestSchema,
  agentAccessDetectRequestSchema,
  agentAccessLoginRequestSchema,
  agentAccessNativeEventRequestSchema,
  agentAccessNativeLaunchRequestSchema,
  agentAccessOpenCodeFinalizerRequestSchema,
  codexManagedLoginArgs,
} from '@clowder-ai/agent-contract';
import {
  type AgentAccessAcpChildHandle,
  agentAccessAcpModelSelectionSchema,
  agentAccessDshConnectionInputSchema,
} from '@clowder-ai/agent-contract/acp';
import { builtInAgentClients, inspectNativeAccessCandidate } from './discovery/agent-client-catalog.js';
import { nativeRuntimeReadiness } from './discovery/native-runtime-readiness.js';
import { discoverNativeRuntimes } from './discovery/native-runtimes.js';

import { readRoles } from './roles/role-card.js';
import { writeRole } from './roles/write-role.js';
import { runA2ATurn } from './runtime/a2a-turn.js';
import { checkDshConnectionInWorker } from './runtime/acp/dsh/connection-check.js';
import { createAcpProcessActions } from './runtime/acp/process-connection.js';
import { resolveSessionModelConfigOption } from './runtime/acp/session-configuration.js';
import { projectAgyOutput, summarizeAgyTurn } from './runtime/agy/agy-output.js';
import { projectCatAgentOutput } from './runtime/catagent-events.js';
import { projectClaudeBatch } from './runtime/claude/project-claude-batch.js';
import { projectClaudeOutput } from './runtime/claude/project-claude-output.js';
import { buildCodexAppServerThreadParams, buildCodexAppServerTurnParams } from './runtime/codex-appserver-params.js';
import { buildCodexExecLaunchArguments } from './runtime/codex-exec-launch-arguments.js';
import { normalizeKimiEvent } from './runtime/kimi-event-parser.js';
import { buildKimiLaunchArguments } from './runtime/kimi-launch-arguments.js';
import { normalizeOpenCodeEvent } from './runtime/opencode-event-parser.js';
import {
  buildOpenCodeLaunchArguments,
  buildOpenCodeNoToolFinalizerArguments,
} from './runtime/opencode-launch-arguments.js';

export default {
  create() {
    return {
      start(host: { agentAccess?: AgentAccessDiscoveryHost; agentRoleStore?: AgentAccessRoleStore }) {
        const { agentAccess: discovery, agentRoleStore } = host;
        if (!discovery) throw new Error('Agent access Host discovery port is unavailable');
        const acpProcesses = createAcpProcessActions();
        return {
          actions: {
            acpDshTurn: acpProcesses.acpDshTurn,
            [AGENT_ACCESS_ACP_PROCESS_ACTION]: acpProcesses.acpProcess,
            [AGENT_ACCESS_ACP_SESSION_ACTION]: acpProcesses.acpSession,
            projectCatAgentOutput,
            projectAgyOutput,
            summarizeAgyTurn,
            configure(input: unknown) {
              if (input && typeof input === 'object' && 'operation' in input) {
                const request = agentAccessNativeLaunchRequestSchema.parse(input);
                return request.client === 'kimi'
                  ? buildKimiLaunchArguments(request.launch)
                  : buildOpenCodeLaunchArguments(request.launch);
              }
              return { clients: builtInAgentClients };
            },
            planCodexExec(input: unknown) {
              const { launch } = agentAccessCodexExecLaunchRequestSchema.parse(input);
              return buildCodexExecLaunchArguments(launch);
            },
            planCodexLogin() {
              return codexManagedLoginArgs;
            },
            planCodexAppServerThread(input: unknown) {
              const request = agentAccessCodexAppServerThreadRequestSchema.parse(input);
              return agentAccessCodexAppServerThreadPlanSchema.parse(buildCodexAppServerThreadParams(request));
            },
            planCodexAppServerTurn(input: unknown) {
              const request = agentAccessCodexAppServerTurnRequestSchema.parse(input);
              return agentAccessCodexAppServerTurnPlanSchema.parse(buildCodexAppServerTurnParams(request));
            },
            planFinalizer(input: unknown) {
              const { launch } = agentAccessOpenCodeFinalizerRequestSchema.parse(input);
              return buildOpenCodeNoToolFinalizerArguments(launch);
            },
            parseNativeEvent(input: unknown) {
              const request = agentAccessNativeEventRequestSchema.parse(input);
              return request.client === 'kimi'
                ? normalizeKimiEvent(request.event)
                : normalizeOpenCodeEvent(request.event);
            },
            selectAcpModel(input: unknown) {
              const request = agentAccessAcpModelSelectionSchema.parse(input);
              return resolveSessionModelConfigOption(request, request.model);
            },
            projectClaudeOutput,
            projectClaudeBatch,
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
          stop: acpProcesses.stop,
        };
      },
    };
  },
};
