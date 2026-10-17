import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildRetainedClient } from '../../collective-client/scripts/build.mjs';

// First-party product catalog, never selected from a plugin-controlled filesystem path.
const root = new URL('../dist/browser-assets/', import.meta.url);
await mkdir(root, { recursive: true });
const binding = await buildRetainedClient(fileURLToPath(new URL('collective-client/', root)));
await writeFile(
  new URL('catalog.json', root),
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          pluginId: 'official.collective-connector',
          contributionId: 'collective-client-api',
          directory: 'collective-client',
          ...binding,
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
