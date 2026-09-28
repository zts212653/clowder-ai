import { CODEX_CUA_SERVER_NAME, type CodexMcpCapabilityApprovalEvidence } from './CodexMcpCapabilityCorrelation.js';
import {
  type CodexMcpFormParams,
  isMcpCapabilityApprovalMarker,
  mcpCapabilityApprovalMetaSchema,
} from './CodexRuntimeInteractionSchema.js';

type JsonObject = Record<string, unknown>;

const PENCIL_CAPABILITY = {
  serverName: 'cua_repl',
  connectorId: 'computer-use',
  appId: 'dev.pencil.desktop',
  capabilityId: 'pencil',
} as const;

type CodexMcpCapabilityReasonCode =
  | 'capability_provenance_invalid'
  | 'capability_unsupported'
  | 'capability_unavailable';

/**
 * Resolve provider-internal capability consent from the invocation's already
 * admitted MCP surface. Returning null deliberately preserves genuine forms.
 */
export function resolveCodexMcpCapabilityResponse(
  params: CodexMcpFormParams,
  declaredMcpServerNames: readonly string[] | undefined,
  approvalEvidence?: CodexMcpCapabilityApprovalEvidence,
  rawParams?: unknown,
): JsonObject | null {
  if (!isMcpCapabilityApprovalMarker(params._meta)) return null;

  const parsed = mcpCapabilityApprovalMetaSchema.safeParse(params._meta);
  if (!parsed.success) return unavailableCapabilityResponse('capability_provenance_invalid');
  const raw = asRecord(rawParams);
  if (
    !raw ||
    raw.serverName !== params.serverName ||
    raw.threadId !== params.threadId ||
    raw.turnId !== params.turnId
  ) {
    return unavailableCapabilityResponse('capability_provenance_invalid');
  }

  const isPencilCapability =
    params.serverName === PENCIL_CAPABILITY.serverName &&
    parsed.data.connector_id === PENCIL_CAPABILITY.connectorId &&
    parsed.data.tool_params.app === PENCIL_CAPABILITY.appId;
  if (isPencilCapability) {
    if (!declaredMcpServerNames?.includes(PENCIL_CAPABILITY.capabilityId)) {
      return unavailableCapabilityResponse('capability_unavailable', PENCIL_CAPABILITY.capabilityId);
    }
    return pencilCapabilityResponse();
  }

  const isProviderNativeComputerUse =
    params.serverName === CODEX_CUA_SERVER_NAME && parsed.data.connector_id === PENCIL_CAPABILITY.connectorId;
  if (!isProviderNativeComputerUse) return unavailableCapabilityResponse('capability_unsupported');
  if (!parsed.data.callId || !params.turnId) {
    return unavailableCapabilityResponse('capability_provenance_invalid');
  }
  if (
    !approvalEvidence?.isProviderAutoReviewApproved({
      threadId: params.threadId,
      turnId: params.turnId,
      callId: parsed.data.callId,
    })
  ) {
    return unavailableCapabilityResponse('capability_unavailable');
  }
  return providerReviewedCapabilityResponse();
}

function pencilCapabilityResponse(): JsonObject {
  return {
    action: 'accept',
    content: { source: 'computer-use-persisted-state', scope: 'session' },
    _meta: {
      source: 'cat-cafe-capability-lifecycle',
      persist: 'session',
      capabilityId: PENCIL_CAPABILITY.capabilityId,
    },
  };
}

function providerReviewedCapabilityResponse(): JsonObject {
  return {
    action: 'accept',
    content: { source: 'provider-auto-review', scope: 'session' },
    _meta: {
      source: 'cat-cafe-capability-lifecycle',
      persist: 'session',
    },
  };
}

function unavailableCapabilityResponse(reasonCode: CodexMcpCapabilityReasonCode, capabilityId?: string): JsonObject {
  return {
    action: 'decline',
    content: null,
    _meta: {
      source: 'cat-cafe-capability-lifecycle',
      reasonCode,
      ...(capabilityId ? { capabilityId } : {}),
    },
  };
}

function asRecord(input: unknown): JsonObject | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as JsonObject) : null;
}
