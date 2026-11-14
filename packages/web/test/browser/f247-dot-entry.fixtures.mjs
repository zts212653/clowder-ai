import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { operationFieldProjection } from '../../../api/dist/domains/plugin/manager/plugin-manager-field-projection.js';

// Exercise the exact bundled package's schema and status projection. HTTP and
// the provider subscription callback remain explicit UI contract boundaries.
const bundle = new URL('../../../api/src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.52/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', bundle), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'dot-browser-package-'));
const modulePath = join(temporary, 'journey-projection.mjs');
await writeFile(
  modulePath,
  execFileSync('tar', ['-xOf', new URL('package.tgz', bundle).pathname, 'package/dist/journey-projection.js']),
);
export const { projectDotJourney } = createRequire(import.meta.url)(modulePath);
after(() => rm(temporary, { recursive: true, force: true }));
export const configFields = manifest.configuration
  .filter((field) => field.key === 'subscription' || field.key === 'connection')
  .map((field) => operationFieldProjection(field, undefined, manifest.configuration, {}));
export const setupSteps = manifest.steps;

export const personalProState = {
  pluginId: 'personal-chrome-host',
  channel: 'developer_preview',
  platform: 'darwin',
  platformSupport: 'supported',
  artifact: { helper: 'absent', extension: 'chrome_web_store' },
  distribution: { channel: 'chrome_web_store', integration: 'ready', publication: 'unavailable' },
  config: { status: 'absent' },
  authorization: { status: 'empty', count: 0, limit: 4, conversations: [] },
  intent: { status: 'developer_preview' },
  live: { status: 'dormant' },
};
export function managerDot(installed, enabled) {
  return {
    pluginId: manifest.pluginId,
    pluginInstanceId: installed ? 'pi_dot' : null,
    displayName: manifest.name,
    description: manifest.description.default,
    publisher: 'Clowder AI',
    source: { kind: 'catalog', catalogId: 'chatgpt-dot', packageName: '@clowder-ai/chatgpt-dot', trust: 'official' },
    availableVersion: manifest.version,
    installedVersion: installed ? manifest.version : null,
    packageDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    artifact: installed ? 'installed' : 'absent',
    config: 'ready',
    auth: 'not_required',
    intent: enabled ? 'enabled' : 'disabled',
    live: enabled ? 'running' : 'stopped',
    lifecycleRevision: installed ? 1 : null,
    capabilitySummary: [],
    actions: { install: !installed, setEnabled: installed, uninstall: installed, blockingReasons: [] },
  };
}
