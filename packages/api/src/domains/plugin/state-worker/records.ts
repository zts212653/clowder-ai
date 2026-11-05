import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCall, parseLease, parseSession } from '../host-broker/snapshot.js';
import { DEFAULT_PLUGIN_CONTRACT_RUNTIME } from '../host-inventory/contract-policy.js';
import type {
  PackageAdmissionContractRuntime,
  PackageManifestValidationResult,
} from '../host-inventory/manifest-verifier.js';
import { parseInstance, parsePackage } from '../host-inventory/snapshot.js';
import type { StateEntity } from './protocol.js';

// This cache lives only in this worker/build. Content, not a claimed package digest,
// identifies each result. A new build/rules implementation creates a new rules identity.
const rules = createHash('sha256');
const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js';
for (const relative of [
  '../host-inventory/snapshot.js',
  '../host-inventory/contract-policy.js',
  '../desktop-window-runtime/presentation-manifest.js',
]) {
  rules.update(readFileSync(new URL(relative.replace(/\.js$/, `.${extension}`), import.meta.url)));
}
rules.update(readFileSync(new URL(import.meta.resolve('@clowder-ai/plugin-contract'))));
const ruleIdentity = rules.digest('hex');
const packages = new Map<string, unknown>();
const manifestResults = new Map<string, PackageManifestValidationResult>();
export const cachedContract: PackageAdmissionContractRuntime = {
  manifestContractRange: DEFAULT_PLUGIN_CONTRACT_RUNTIME.manifestContractRange,
  validateManifest(value) {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(value);
    const identity = `${ruleIdentity}:${contentHash(json)}`;
    let result = manifestResults.get(identity);
    if (!result) {
      result = DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(value);
      manifestResults.set(identity, result);
    }
    return result;
  },
};
export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function decodeRecord(entity: StateEntity, json: string, hash: string): unknown {
  const actualHash = contentHash(json);
  if (actualHash !== hash) throw new Error('Plugin state record content hash mismatch');
  const identity = `${ruleIdentity}:${actualHash}`;
  if (entity === 'package' && packages.has(identity)) return packages.get(identity);
  const value: unknown = JSON.parse(json);
  let parsed: unknown;
  switch (entity) {
    case 'package':
      parsed = parsePackage(value, 0, cachedContract);
      break;
    case 'instance':
      parsed = parseInstance(value, 0);
      break;
    case 'session':
      parsed = parseSession(value, 0);
      break;
    case 'lease':
      parsed = parseLease(value, 0);
      break;
    case 'call':
      parsed = parseCall(value, 0);
      break;
    default:
      parsed = value;
  }
  if (entity === 'package') packages.set(identity, parsed);
  return parsed;
}

export function recordColumns(entity: StateEntity, value: unknown) {
  const r = value as Record<string, unknown>;
  const text = (key: string) => (typeof r[key] === 'string' ? (r[key] as string) : null);
  const key =
    entity === 'package'
      ? text('packageDigest')
      : entity === 'instance'
        ? text('pluginInstanceId')
        : entity === 'session'
          ? text('connectionId')
          : entity === 'lease'
            ? text('runtimeLeaseId')
            : entity === 'call'
              ? text('ledgerKey')
              : entity === 'feature'
                ? text('executionLease')
                : JSON.stringify([text('pluginInstanceId'), entity === 'epoch' ? r.integrityEpoch : r.featureId]);
  if (!key) throw new Error(`Missing ${entity} record identity`);
  return {
    key,
    pluginId: text('pluginId'),
    instanceId: text('pluginInstanceId'),
    sessionId: text('brokerSessionId'),
    packageDigest: text('packageDigest') ?? text('packageRevision'),
    phase: text('phase') ?? text('lifecycleState') ?? text('state') ?? text('packageState'),
  };
}
