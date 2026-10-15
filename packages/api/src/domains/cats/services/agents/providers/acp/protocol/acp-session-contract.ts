import { createHash } from 'node:crypto';
import type { AcpMcpServer, AcpNewSessionResult, AcpResponse } from '../types.js';
import { ACP_CONTRACT_META, AcpCapabilityError, type AcpCapabilitySnapshot, isAcpRecord } from './acp-capabilities.js';

export interface AcpTrustedInstructions {
  revision: string;
  entries: readonly { role: 'system' | 'developer'; content: string }[];
}
export interface AcpSessionOptions {
  requiredMcpServers?: readonly string[];
  instructions?: AcpTrustedInstructions;
}
export type AcpRpcCall = (method: string, params: Record<string, unknown>) => Promise<AcpResponse>;
export interface AcpModelReceipt {
  requestedModel: string;
  effectiveModel: string;
  source: 'session_config' | 'session_models';
  servedModel: 'unknown';
}

function optionsMeta(
  capabilities: AcpCapabilitySnapshot,
  instructions?: AcpTrustedInstructions,
): Record<string, unknown> {
  if (!instructions) return {};
  const contract = capabilities.contract();
  const declaration = contract?.instructions;
  const roles = isAcpRecord(declaration) && Array.isArray(declaration.roles) ? declaration.roles : [];
  if (
    !instructions.revision ||
    instructions.entries.length === 0 ||
    !instructions.entries.every((entry) => roles.includes(entry.role) && entry.content.length > 0)
  ) {
    throw new AcpCapabilityError(
      'trusted_instructions_unsupported',
      'Required native instruction role or revision is unsupported',
    );
  }
  return { _meta: { [ACP_CONTRACT_META]: { instructions } } };
}
function verifyInstructions(
  result: AcpNewSessionResult,
  capabilities: AcpCapabilitySnapshot,
  requested?: AcpTrustedInstructions,
): void {
  if (!requested) return;
  const namespace = result._meta?.[ACP_CONTRACT_META];
  const receipt = isAcpRecord(namespace) ? namespace.instructionsApplied : undefined;
  const declaration = capabilities.contract()?.instructions;
  const sources = isAcpRecord(declaration) && Array.isArray(declaration.nativeSources) ? declaration.nativeSources : [];
  if (
    !isAcpRecord(receipt) ||
    receipt.revision !== requested.revision ||
    receipt.sessionId !== result.sessionId ||
    typeof receipt.nativeSource !== 'string' ||
    !receipt.nativeSource ||
    !sources.includes(receipt.nativeSource) ||
    !Array.isArray(receipt.entries)
  ) {
    throw new AcpCapabilityError('instructions_receipt_invalid', 'Native instructions have no valid applied receipt');
  }
  const entries = receipt.entries;
  if (
    entries.length !== requested.entries.length ||
    requested.entries.some((entry, index) => {
      const applied = entries[index];
      return (
        !isAcpRecord(applied) ||
        applied.role !== entry.role ||
        applied.sha256 !== createHash('sha256').update(entry.content).digest('hex')
      );
    })
  )
    throw new AcpCapabilityError(
      'instructions_receipt_invalid',
      'Native instruction hash or role differs from the compiler output',
    );
}
function sessionResult(value: unknown, expectedId?: string): AcpNewSessionResult {
  if (!isAcpRecord(value))
    throw new AcpCapabilityError('invalid_session_response', 'ACP session response must be an object');
  const id = value.sessionId ?? expectedId;
  if (typeof id !== 'string' || !id || (expectedId && id !== expectedId))
    throw new AcpCapabilityError(
      'session_identity_mismatch',
      'ACP session identity differs from the requested native session',
    );
  return { ...value, sessionId: id } as AcpNewSessionResult;
}
export async function openAcpSession(
  rpc: AcpRpcCall,
  capabilities: AcpCapabilitySnapshot,
  cwd: string,
  servers: AcpMcpServer[],
  options: AcpSessionOptions = {},
  sessionId?: string,
): Promise<AcpNewSessionResult> {
  const meta = optionsMeta(capabilities, options.instructions);
  const mcpServers = capabilities.selectMcp(servers, options.requiredMcpServers);
  const response = await rpc(sessionId ? capabilities.restoreMethod() : 'session/new', {
    ...(sessionId ? { sessionId } : {}),
    cwd,
    mcpServers,
    ...meta,
  });
  const result = sessionResult(response.result, sessionId);
  verifyInstructions(result, capabilities, options.instructions);
  return result;
}
export async function closeAcpSession(
  rpc: AcpRpcCall,
  capabilities: AcpCapabilitySnapshot,
  sessionId: string,
): Promise<void> {
  if (!sessionId || !capabilities.supportsClose())
    throw new AcpCapabilityError('session_close_unsupported', 'Agent has no negotiated session close method');
  await rpc('session/close', { sessionId });
}
export async function readAcpExecutionBinding(
  rpc: AcpRpcCall,
  capabilities: AcpCapabilitySnapshot,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const contract = capabilities.contract();
  if (!isAcpRecord(contract?.methods) || contract.methods['_clowder/v1/execution/read'] !== true)
    throw new AcpCapabilityError('execution_binding_unsupported', 'Agent has no negotiated execution binding method');
  const response = await rpc('_clowder/v1/execution/read', { sessionId });
  if (!isAcpRecord(response.result) || response.result.sessionId !== sessionId)
    throw new AcpCapabilityError('execution_binding_mismatch', 'Execution binding belongs to another native session');
  const value = response.result;
  const hash = (field: unknown): field is string => typeof field === 'string' && /^[a-f0-9]{64}$/.test(field);
  if (
    !hash(value.bindingFingerprint) ||
    !hash(value.accountFingerprint) ||
    !hash(value.policyFingerprint) ||
    !isAcpRecord(value.nativeExecutable) ||
    !hash(value.nativeExecutable.sha256) ||
    typeof value.nativeExecutable.version !== 'string' ||
    !value.nativeExecutable.version ||
    value.nativeExecutable.version.length > 128
  )
    throw new AcpCapabilityError(
      'execution_binding_invalid',
      'Native execution receipt is missing typed binary/account/policy fingerprints',
    );
  return {
    sessionId,
    bindingFingerprint: value.bindingFingerprint,
    accountFingerprint: value.accountFingerprint,
    policyFingerprint: value.policyFingerprint,
    nativeExecutable: { sha256: value.nativeExecutable.sha256, version: value.nativeExecutable.version },
    ...(hash(value.profileFingerprint) ? { profileFingerprint: value.profileFingerprint } : {}),
    verification: 'bridge_reported',
  };
}
function values(option: unknown): { value: string; name?: string }[] {
  if (!Array.isArray(option)) return [];
  return option.flatMap((entry) =>
    !isAcpRecord(entry)
      ? []
      : Array.isArray(entry.options)
        ? values(entry.options)
        : typeof entry.value === 'string'
          ? [{ value: entry.value, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) }]
          : [],
  );
}
/** Acknowledgement alone is not model adoption; retain the agent's config readback. */
export async function applyAcpModel(
  rpc: AcpRpcCall,
  sessionId: string,
  requestedModel: string,
  session: AcpNewSessionResult,
): Promise<AcpModelReceipt> {
  const option = session.configOptions?.find((entry) => entry.category === 'model' || entry.id === 'model');
  if (option) {
    const offered = values(option.options);
    const current = offered.find((entry) => entry.value === option.currentValue);
    const matches = offered.filter((entry) => entry.value === requestedModel || entry.name === requestedModel);
    const target =
      current?.name === requestedModel || current?.value === requestedModel
        ? current.value
        : matches.length === 1
          ? matches[0].value
          : undefined;
    if (!target)
      throw new AcpCapabilityError('model_option_invalid', 'Requested model is not an unambiguous agent option');
    if (option.currentValue === target)
      return { requestedModel, effectiveModel: target, source: 'session_config', servedModel: 'unknown' };
    const response = await rpc('session/set_config_option', { sessionId, configId: option.id, value: target });
    const options =
      isAcpRecord(response.result) && Array.isArray(response.result.configOptions) ? response.result.configOptions : [];
    const adopted = options.find((entry) => isAcpRecord(entry) && entry.id === option.id);
    if (!isAcpRecord(adopted) || adopted.currentValue !== target)
      throw new AcpCapabilityError('model_readback_mismatch', 'Agent did not confirm requested model adoption');
    return { requestedModel, effectiveModel: target, source: 'session_config', servedModel: 'unknown' };
  }
  const models = session.models;
  if (models) {
    const selected = models.availableModels.find((entry) => (entry.modelId ?? entry.id) === requestedModel);
    if (!selected)
      throw new AcpCapabilityError('model_option_invalid', 'Requested model is absent from available models');
    if (models.currentModelId === requestedModel)
      return { requestedModel, effectiveModel: requestedModel, source: 'session_models', servedModel: 'unknown' };
    const response = await rpc('session/set_model', { sessionId, modelId: requestedModel });
    if (!isAcpRecord(response.result) || response.result.currentModelId !== requestedModel)
      throw new AcpCapabilityError('model_readback_mismatch', 'Legacy model method has no confirmed model readback');
    return { requestedModel, effectiveModel: requestedModel, source: 'session_models', servedModel: 'unknown' };
  }
  throw new AcpCapabilityError('model_configuration_unsupported', 'Agent cannot confirm requested model adoption');
}
