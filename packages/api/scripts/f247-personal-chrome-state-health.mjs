import { readPersonalChromePairingRecord } from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';
import { probeNativeHostHealth } from './f247-personal-chrome-health-probe.mjs';

function projectHealthResult(state, health, expectedRevisions) {
  if (typeof health === 'boolean') {
    state.live.status =
      state.artifact.helper === 'stale' && health ? 'restart_required' : health ? 'connected' : 'dormant';
    return;
  }
  state.live.status = health.status === 'ready' ? 'connected' : health.status;
  state.live.expectedRevisions = expectedRevisions;
  if (health.observedRevisions) state.live.observedRevisions = health.observedRevisions;
  if (typeof health.errorCode === 'string') state.live.errorCode = health.errorCode;
}

export async function projectPersonalChromeLiveState({
  state,
  installation,
  pairingRecordPath,
  conversationId,
  probeLive,
}) {
  if (!installation) return;
  const expectedRevisions = {
    helper: installation.expectedArtifactDigest ?? installation.artifactDigest,
    extension: '0.2.5',
    pageAdapter: '2026-08-27.1',
  };
  try {
    const record =
      probeLive === probeNativeHostHealth
        ? await readPersonalChromePairingRecord(pairingRecordPath)
        : { pairingSecret: 'injected-probe' };
    const health = await probeLive({
      socketPath: installation.socketPath,
      pairingSecret: record.pairingSecret,
      expectedRevisions,
      conversationId,
    });
    projectHealthResult(state, health, expectedRevisions);
  } catch (error) {
    if (error?.code === 'STALE_HELPER_PROTOCOL') {
      state.live = { status: 'stale_adapter', expectedRevisions, errorCode: 'STALE_HELPER_PROTOCOL' };
      return;
    }
    state.live.status = state.artifact.helper === 'stale' ? 'restart_required' : 'degraded';
  }
}
