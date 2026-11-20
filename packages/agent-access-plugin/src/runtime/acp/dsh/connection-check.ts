import type { AgentAccessAcpChildHandle, AgentAccessDshConnectionInput } from '@clowder-ai/agent-contract/acp';
import { AcpClient, AcpProtocolError } from '../AcpClient.js';
import { applySessionConfiguration } from '../session-configuration.js';
import { attachWorkerChildConnection } from '../worker-child-connection.js';
import { matchDshMissingCredential } from './credential-error.js';

export async function checkDshConnection(
  client: Pick<
    AcpClient,
    'initialize' | 'newSession' | 'setSessionConfigOption' | 'closeSession' | 'promptCollect' | 'close'
  >,
  cwd: string,
  preferences: { model?: string; effort?: string },
) {
  let initialized = false;
  try {
    await client.initialize();
    initialized = true;
    const session = await client.newSession(cwd, []);
    await applySessionConfiguration(client, session, preferences);
    const result = await client.promptCollect(
      session.sessionId,
      'Connection test. Reply only DSH_CONNECTION_OK. Do not use tools or access files.',
      { timeoutMs: 60_000 },
    );
    const text = result.events
      .flatMap(({ update }) => {
        const content = update.content;
        return update.sessionUpdate === 'agent_message_chunk' &&
          content &&
          !Array.isArray(content) &&
          content.type === 'text'
          ? [content.text]
          : [];
      })
      .join('');
    if (result.stopReason !== 'end_turn' || !text.includes('DSH_CONNECTION_OK')) throw Error('dsh_setup_test_failed');
    return { sessionId: session.sessionId };
  } catch (error) {
    const detail =
      error instanceof AcpProtocolError ? JSON.stringify(error.data) : error instanceof Error ? error.message : '';
    if (/dsh_desktop_auth_read_only|Credential store modify failed/.test(detail))
      throw Error('dsh_setup_auth_refresh_required');
    if (error instanceof Error && matchDshMissingCredential(error.message)) throw Error('dsh_setup_credential_missing');
    throw Error(initialized ? 'dsh_setup_test_failed' : 'dsh_setup_start_failed');
  } finally {
    await client.close();
  }
}

export function checkDshConnectionInWorker(
  input: AgentAccessDshConnectionInput,
  launch: () => Promise<AgentAccessAcpChildHandle>,
) {
  const { cwd, model, effort } = input;
  const command = 'dsh';
  const args: string[] = [];
  const client = new AcpClient(
    { command, args, cwd, defaultPermissionDecision: 'reject' },
    {
      // The DSH connection check reports documented status codes only.
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async launch(_config, captureCwdIdentity) {
        captureCwdIdentity();
        const child = await attachWorkerChildConnection(launch);
        return { child, childEnv: {}, spawnLog: { command, cwd, argCount: 0, envKeyCount: 0, pid: child.pid } };
      },
    },
  );
  return checkDshConnection(client, cwd, { model, effort });
}
