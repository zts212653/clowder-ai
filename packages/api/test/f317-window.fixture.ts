import { createHash } from 'node:crypto';
import type { DesktopWindowContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

export const windowHtml = '<!doctype html><html><body>Companion fixture; no media requested</body></html>';
export function desktopWindowManifest(
  body = windowHtml,
  bridgeVersion: DesktopWindowContribution['bridgeVersion'] = '1.0.0',
): PluginManifest {
  return {
    pluginId: 'dev.clowder.window-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Window',
    runtime: { transport: 'builtin' },
    features: [
      {
        id: 'body',
        name: 'Body',
        resources: [],
        capabilities: ['windows.create'],
        contributions: [{ type: 'desktop-window', id: 'body' }],
      },
    ],
    contributions: [
      {
        type: 'desktop-window',
        id: 'body',
        role: 'companion',
        bridgeVersion,
        surface: {
          entrypoint: 'renderer/index.html',
          integrity: `sha256-${createHash('sha256').update(body).digest('base64')}`,
        },
        presentation: {
          width: 320,
          height: 350,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
        },
      },
    ],
  };
}

export async function desktopWindowFixture(
  body = windowHtml,
  worker?: string,
  bridgeVersion: DesktopWindowContribution['bridgeVersion'] = '1.0.0',
) {
  const f = await staticEditorFixture(desktopWindowManifest(body, bridgeVersion), body, worker);
  return { ...f, entry: { ...f.entry, effectiveGrants: ['windows.create' as const] } };
}
