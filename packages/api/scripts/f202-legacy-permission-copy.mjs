/**
 * One-time C1 cutover asset, NOT a runtime API or SDK capability.
 * The cutover owner supplies the installed, reviewed target and its declared operation.
 * An authenticated owner-local request authorizes the copy; request.body is never a source
 * of identity, Redis keys, plugin coordinates or permission state. No route is registered here.
 * The existing operation service invokes the admitted package; that package owns validation,
 * insert-only CAS and its import receipt. A 200 operation response alone is not parity proof.
 * No Redis client is created here and no legacy key is modified/deleted.
 */
import { createHash } from 'node:crypto';
import { requirePluginOwnerLocalAccess } from '../dist/routes/plugin-access-guards.js';

const CONNECTORS = new Set(['feishu', 'dingtalk', 'wecom', 'wecom-bot', 'telegram', 'weixin', 'xiaoyi']);
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_GROUPS = 5000;

// Transport canonicalization only: do not decode the connector's stored JSON or flags.
function canonicalHash(hash) {
  if (!hash || typeof hash !== 'object' || Array.isArray(hash)) throw new TypeError('invalid legacy hash');
  return `{${Object.keys(hash)
    .sort()
    .map((key) => {
      if (typeof hash[key] !== 'string') throw new TypeError('invalid legacy hash value');
      return `${JSON.stringify(key)}:${JSON.stringify(hash[key])}`;
    })
    .join(',')}}`;
}

export async function copyLegacyConnectorPermissions({ request, redis, operations, connectorId, target }) {
  const access = requirePluginOwnerLocalAccess(request, 'write');
  if ('error' in access) return { status: access.status, body: { error: access.error } };
  if (request.body?.confirmed !== true) return { status: 400, body: { error: 'Owner confirmation is required' } };
  if (!CONNECTORS.has(connectorId)) throw new TypeError('unknown legacy connector');
  for (const key of ['pluginId', 'operationKey', 'actionId']) {
    if (typeof target?.[key] !== 'string' || !target[key].trim()) throw new TypeError(`missing trusted ${key}`);
  }
  if (target.operationKey !== 'legacy_permissions' || target.actionId !== 'import') {
    throw new TypeError('unexpected legacy import operation');
  }
  // Use the supplied isolated/authorized client's native keyPrefix. MULTI reads a consistent
  // pair of hashes; manual key concatenation would double-prefix a production client.
  const result = await redis
    .multi()
    .hgetall(`connector-perm:${connectorId}`)
    .hgetall(`connector-perm-groups:${connectorId}`)
    .exec();
  if (!result || result.length !== 2 || result.some(([error]) => error)) {
    throw new Error('legacy permission snapshot read failed');
  }
  const snapshot = { config: result[0][1], groups: result[1][1] };
  if (!snapshot.config || !snapshot.groups || Array.isArray(snapshot.config) || Array.isArray(snapshot.groups)) {
    throw new Error('legacy permission snapshot is invalid');
  }
  if (
    Object.keys(snapshot.groups).length > MAX_GROUPS ||
    Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES
  ) {
    return { status: 413, body: { error: 'legacy permission snapshot exceeds cutover bound' } };
  }
  // Keep raw fields: absent adminOpenIds differs from an explicit JSON "[]".
  const canonical = `{"config":${canonicalHash(snapshot.config)},"groups":${canonicalHash(snapshot.groups)}}`;
  const sourceDigest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const envelope = { protocolVersion: 1, sourceDigest, snapshot };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_SNAPSHOT_BYTES) {
    return { status: 413, body: { error: 'legacy permission envelope exceeds cutover bound' } };
  }
  return operations.runAction(target.pluginId, target.operationKey, target.actionId, envelope);
}
