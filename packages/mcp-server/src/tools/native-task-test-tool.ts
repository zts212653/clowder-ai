import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';
import { resolveInvocationCredentials } from './invocation-auth.js';
import { runSandboxedNativeTaskTest } from './native-task-test-runner.js';

const grantSchema = z
  .object({
    v: z.literal(1),
    taskId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    testFile: z.string().min(1),
  })
  .strict();

function localCallbackOrigin(): URL {
  const raw = process.env.CAT_CAFE_API_URL;
  if (!raw) throw new Error('Native test callback origin is unavailable');
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Native test callback origin must be loopback');
  }
  return url;
}

async function fetchNativeTestGrant(signal?: AbortSignal) {
  const { invocationId, callbackToken } = resolveInvocationCredentials();
  if (!invocationId || !callbackToken) throw new Error('Native test requires an active invocation credential');
  const response = await fetch(new URL('/api/callbacks/native-test-grant', localCallbackOrigin()), {
    method: 'GET',
    headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    redirect: 'error',
  });
  if (response.status !== 200) throw new Error(`Native test grant rejected (${response.status})`);
  return grantSchema.parse(await response.json());
}

/** The model supplies no command, path, cwd, or arguments. The callback owner supplies one test target. */
export async function handleNativeTaskTest(_input: Record<string, never>, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const grant = await fetchNativeTestGrant(signal);
    const result = await runSandboxedNativeTaskTest(grant, signal);
    const body = JSON.stringify({ taskId: grant.taskId, ...result });
    return result.status === 'passed' || result.status === 'failed' ? successResult(body) : errorResult(body);
  } catch (error) {
    return errorResult(
      JSON.stringify({
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'Native task test failed',
      }),
    );
  }
}

const sourceRef = 'file:packages/mcp-server/src/tools/native-task-test-tool.ts' as const;
export const nativeTaskTestTools = [
  defineMcpTool({
    name: 'cat_cafe_run_task_test',
    description:
      'Run the one exact Node test bound by the current operator-issued coding Task. ' +
      'Use when: you have edited the authorized task files and need to run their assigned regression test. ' +
      'Not for: arbitrary commands, package scripts, another Task, or a long managed job. ' +
      'Output: typed pass/fail/cancel/timeout with bounded test output. ' +
      'GOTCHA: no command, path or cwd input is accepted; the host resolves the live Task and the test runs in a read-only OS sandbox.',
    operation: {
      kind: 'single',
      action: 'command',
      inputSchema: {},
      boundary: {
        risk: { level: 'destructive', openWorld: false },
        authorizationPaths: [
          {
            principal: 'invocation-cat',
            credentialSource: 'callback-principal',
            scope: { kind: 'owner-private' },
            enforcementRef: 'file:packages/api/src/routes/callback-native-test-grant.ts',
          },
        ],
      },
    },
    implementation: bindMcpImplementation(
      'module:./tools/native-task-test-tool.js#handleNativeTaskTest',
      handleNativeTaskTest,
      (_input, extra) => handleNativeTaskTest({}, extra.signal),
    ),
    policy: {
      resourceFamily: 'task-workflow',
      schemaDelivery: { policy: 'host-default', evidenceRef: sourceRef },
      runtimeProfiles: ['full'],
      owner: { domainCell: 'architecture-cell:hub-action-surface', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: 'file:docs/features/F325-antigravity-native-parity.md',
      },
      activeState: 'canonical',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: sourceRef }],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/native-task-test-tool.test.js' }],
    },
  }),
] as const;
