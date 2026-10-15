import { createHash } from 'node:crypto';
import type { AcpInitializeResult, AcpMcpServer } from '../types.js';

export const ACP_CONTRACT_META = 'clowder.ai/acp.v1';
export class AcpCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AcpCapabilityError';
  }
}
export function isAcpRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
/** Immutable per-connection declarations. They are not native/runtime verification evidence. */
export class AcpCapabilitySnapshot {
  private readonly value: AcpInitializeResult;
  readonly declarationFingerprint: string;
  constructor(value: AcpInitializeResult) {
    if (value?.protocolVersion !== 1)
      throw new AcpCapabilityError('protocol_version_mismatch', 'ACP protocol version must be 1');
    if (!isAcpRecord(value.agentCapabilities))
      throw new AcpCapabilityError('invalid_capabilities', 'ACP agentCapabilities missing');
    this.value = structuredClone(value);
    freeze(this.value);
    this.declarationFingerprint = createHash('sha256').update(JSON.stringify(this.value)).digest('hex');
  }
  read(): AcpInitializeResult {
    return structuredClone(this.value);
  }
  publicProvenance(connectionId: string, launchBindingFingerprint?: string) {
    const caps = this.value.agentCapabilities;
    const contract = this.contract();
    return {
      connectionId,
      declarationFingerprint: this.declarationFingerprint,
      launchBindingFingerprint: launchBindingFingerprint ?? 'unknown',
      declared: {
        protocolVersion: this.value.protocolVersion,
        loadSession: caps.loadSession === true,
        prompt: {
          image: caps.promptCapabilities?.image === true,
          audio: caps.promptCapabilities?.audio === true,
          embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        },
        mcp: { http: caps.mcpCapabilities?.http === true, sse: caps.mcpCapabilities?.sse === true },
        session: { resume: isAcpRecord(caps.sessionCapabilities?.resume), close: this.supportsClose() },
        contractVersion: contract ? 1 : 'unknown',
        promptUsage: isAcpRecord(contract?.usage) && contract.usage.scope === 'prompt',
      },
      hostConsumer: ['image', 'tool_facts', 'permission', 'session_restore', 'instruction_receipt', 'model_readback'],
      nativeVerification: 'unverified' as const,
      nativeExecutable: 'unknown' as const,
      deploymentVerification: 'unknown' as const,
    };
  }
  contract(): Record<string, unknown> | undefined {
    const meta = this.value.agentCapabilities._meta?.[ACP_CONTRACT_META];
    return isAcpRecord(meta) && meta.contractVersion === 1 ? structuredClone(meta) : undefined;
  }
  restoreMethod(): 'session/load' | 'session/resume' {
    const caps = this.value.agentCapabilities;
    if (caps.loadSession === true) return 'session/load';
    if (isAcpRecord(caps.sessionCapabilities?.resume)) return 'session/resume';
    throw new AcpCapabilityError('session_restore_unsupported', 'ACP agent declares neither load nor resume');
  }
  supportsClose(): boolean {
    return isAcpRecord(this.value.agentCapabilities.sessionCapabilities?.close);
  }
  selectMcp(servers: AcpMcpServer[], required: readonly string[] = []): AcpMcpServer[] {
    if (required.some((name) => !servers.some((server) => server.name === name)))
      throw new AcpCapabilityError('required_mcp_missing', 'Required MCP server is absent from the resolved whitelist');
    const caps = this.value.agentCapabilities.mcpCapabilities;
    const selected = servers.filter(
      (server) => !('type' in server) || (server.type === 'http' ? caps?.http === true : caps?.sse === true),
    );
    const omitted = servers.filter((server) => !selected.includes(server));
    if (omitted.some((server) => required.includes(server.name)))
      throw new AcpCapabilityError(
        'mcp_transport_unsupported',
        'Required MCP transport is unsupported by the negotiated agent',
      );
    return selected;
  }
}
