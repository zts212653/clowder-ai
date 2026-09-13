/**
 * Strict ZCode 0.16.3 app-server result shapes from the 0.16.3 bundle schemas:
 * protocol name/version, session snapshot (Rse), and session/send accepted (RLi).
 */

export const ZCODE_PROTOCOL = { name: 'ZCode Protocol', version: 1 };

export const AVAILABLE_MODELS = ['main', 'anthropic/GLM-5.2'];

export function isUnsupportedExplicitModel(model) {
  if (!model || typeof model !== 'object') return true;
  const providerId = typeof model.providerId === 'string' ? model.providerId.trim() : '';
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
  if (!providerId || !modelId) return true;
  const ref = `${providerId}/${modelId}`;
  return !AVAILABLE_MODELS.includes(ref);
}

export function sessionSnapshot(sessionId, rec = {}) {
  const now = Date.now();
  const cwd = rec.cwd || process.cwd();
  const envModel = rec.envModel || 'GLM-5.2';
  const model = { providerId: 'anthropic', modelId: envModel };
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  return {
    protocol: ZCODE_PROTOCOL,
    session: {
      sessionId,
      workspace,
      sessionKind: 'interactive',
      title: '',
      mode: 'yolo',
      status: 'idle',
      model,
      createdAt: rec.createdAt ?? now,
      updatedAt: rec.updatedAt ?? now,
    },
    settings: {
      model: { current: model, available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: 'yolo' },
    },
    projection: {
      sessionId,
      status: 'idle',
      mode: 'yolo',
      turnCount: rec.history?.length ?? 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: rec.seq ?? 0,
      stateRevision: rec.stateRevision ?? 0,
      pendingRequestIds: [],
    },
    messages: [],
  };
}

export function sendAccepted(sessionId, stateRevision) {
  return { accepted: true, sessionId, stateRevision };
}

export function assertStrictSnapshot(result, sessionId) {
  if (result?.protocol?.name !== ZCODE_PROTOCOL.name) {
    throw new Error(`snapshot protocol.name must be "${ZCODE_PROTOCOL.name}"`);
  }
  if (result?.protocol?.version !== ZCODE_PROTOCOL.version) {
    throw new Error('snapshot protocol.version must be 1');
  }
  if (result?.session?.sessionId !== sessionId) {
    throw new Error('snapshot session.sessionId mismatch');
  }
  if (!result?.session?.workspace?.workspacePath || !result?.session?.workspace?.workspaceKey) {
    throw new Error('snapshot session.workspace is required');
  }
  if (!Array.isArray(result?.messages) || !result?.settings?.model?.current || !result?.runtime) {
    throw new Error('snapshot missing required settings/runtime/messages');
  }
}

export function assertSendAccepted(result, sessionId) {
  if (result?.accepted !== true) throw new Error('session/send must return accepted:true');
  if (result?.sessionId !== sessionId) throw new Error('session/send sessionId mismatch');
  if (typeof result?.stateRevision !== 'number' || result.stateRevision < 0) {
    throw new Error('session/send stateRevision must be a nonnegative int');
  }
}
