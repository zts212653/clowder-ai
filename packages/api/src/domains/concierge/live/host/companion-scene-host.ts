import type {
  HostScenePutReply,
  HostSceneReply,
  HostSceneWrite,
} from '../../../plugin/desktop-window-runtime/companion-private-wire.js';
import { CompanionBridgeError, type CompanionOwnerClient } from '../companion-owner-client.js';

/** F336 Phase C: the first slice keeps one scene per owner and duty cat: the desktop. */
const DESKTOP_SCENE = 'desktop';

/** The duty cat is the Host's own config, never a value the kernel or the page names. */
async function dutyCatId(client: CompanionOwnerClient): Promise<string> {
  const result = await client.request('/api/concierge/config?view=native');
  const config = result.config;
  const catId = config && typeof config === 'object' ? (config as Record<string, unknown>).dutyCatProfileId : undefined;
  if (typeof catId !== 'string' || !catId) throw new CompanionBridgeError('unavailable');
  return catId;
}

/** The archive's tri-state, plus the cat it belongs to so a later write can prove the same address. */
export async function readCompanionSceneReply(client: CompanionOwnerClient): Promise<HostSceneReply> {
  const catId = await dutyCatId(client);
  return { kind: 'scene', catId, ...(await client.readCompanionScene(catId, DESKTOP_SCENE)) };
}

/** A write lands only on the scene it was read from: a duty change in between is selection_changed. */
export async function writeCompanionSceneReply(
  client: CompanionOwnerClient,
  command: HostSceneWrite,
): Promise<HostScenePutReply> {
  const catId = await dutyCatId(client);
  if (catId !== command.catId) throw new CompanionBridgeError('selection_changed');
  const put = await client.writeCompanionScene(catId, DESKTOP_SCENE, {
    baseRevision: command.baseRevision,
    snapshot: command.snapshot,
  });
  return { kind: 'scene-put', ...put };
}
