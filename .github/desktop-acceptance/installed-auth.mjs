import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNativeAuthProvider } from '../../scripts/test-helpers/native-auth-providers.mjs';
import { collectChecks } from './checks.mjs';

const [installation, evidence, fixtureRoot] = process.argv.slice(2);
const resolveFromApi = createRequire(path.resolve(installation, 'packages/api/package.json')).resolve;
let scripts;
const result = await collectChecks(['installed-runtime', 'kimi', 'opencode', 'dsh'], async (check) => {
  if (check === 'installed-runtime') {
    const entry = fs.realpathSync(resolveFromApi('@cat-cafe/mcp-server/dist/secret-runtime.js'));
    const relative = path.relative(fs.realpathSync(installation), entry);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Runtime resolved outside the installation',
    );
    const runtimeScripts = new URL('./runtime/scripts/', pathToFileURL(entry));
    fs.accessSync(runtimeScripts);
    scripts = runtimeScripts;
    return;
  }
  if (!scripts) return { status: 'not_run', reason: 'installed-runtime-unavailable' };
  await assertNativeAuthProvider(check, scripts, fs.mkdtempSync(path.join(fixtureRoot, 'native-auth-')));
});
fs.writeFileSync(
  path.join(evidence, 'native-auth-checks.json'),
  JSON.stringify(
    {
      status: result.status,
      code: result.status === 'failed' ? 'installed-native-auth-assertion' : undefined,
      scripts: scripts?.href,
      checks: result.checks,
      errors: result.errors.map(({ message }) => message),
    },
    null,
    2,
  ),
);
