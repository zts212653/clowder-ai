import type { DesktopWindowContribution } from '@clowder-ai/plugin-contract';
import { desktopWindowManifest, windowHtml } from './f317-window-manifest.fixture.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

export { desktopWindowManifest, windowHtml } from './f317-window-manifest.fixture.js';

export async function desktopWindowFixture(
  body = windowHtml,
  worker?: string,
  bridgeVersion: DesktopWindowContribution['bridgeVersion'] = '1.0.0',
) {
  const f = await staticEditorFixture(desktopWindowManifest(body, bridgeVersion), body, worker);
  return { ...f, entry: { ...f.entry } };
}
