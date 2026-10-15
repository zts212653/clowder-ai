import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// An isolated compatibility experiment; no workspace/global dependency mutation.
const source = resolve('.cat-cafe/tmp/acp-prototypes/claude');
const target = resolve('.cat-cafe/tmp/acp-prototypes/claude-sdk-0.3.285-aligned');
const sdk = await realpath('packages/api/node_modules/@anthropic-ai/claude-agent-sdk');
const sdkPackage = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
if (sdkPackage.version !== '0.3.285') throw new Error('Upgrade SDK pin mismatch');
await mkdir(target, { recursive: true });
for (const file of ['src', 'tsconfig.json', 'package.json', 'package-lock.json']) {
  await cp(join(source, file), join(target, file), { recursive: true });
}
await mkdir(join(target, 'node_modules', '@anthropic-ai'), { recursive: true });
async function linkVerified(from, to) {
  try {
    await symlink(from, to, 'junction');
  } catch (error) {
    if (error.code !== 'EEXIST' || (await realpath(from)) !== (await realpath(to))) throw error;
  }
}
for (const entry of await readdir(join(source, 'node_modules'), { withFileTypes: true })) {
  if (entry.name === '@anthropic-ai' || entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink()))
    continue;
  await linkVerified(join(source, 'node_modules', entry.name), join(target, 'node_modules', entry.name));
}
// Copy the SDK artifact so its supported ^4 Zod peer resolves to the bridge's
// Zod 4.4.3. The installed pnpm artifact otherwise resolves zod@3's v4 shim.
await cp(sdk, join(target, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
const anthropicSdk = await realpath(join(sdk, '..', 'sdk'));
await linkVerified(anthropicSdk, join(target, 'node_modules', '@anthropic-ai', 'sdk'));
const file = join(target, 'src/acp-agent.ts');
let text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
if (!text.includes('      case "mid_conv_system":')) throw new Error('Upgrade content-union anchor missing');
text = text.replace('      case "mid_conv_system":', '      case "mcp_tool_listing":');
await writeFile(file, text);
const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
pkg.dependencies['@anthropic-ai/claude-agent-sdk'] = '0.3.285';
pkg.devDependencies['@anthropic-ai/sdk'] = JSON.parse(
  await readFile(join(anthropicSdk, 'package.json'), 'utf8'),
).version;
await writeFile(join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await writeFile(
  join(target, 'upgrade-binding.json'),
  JSON.stringify(
    {
      baseBridgePin: 'd0aafb1ca26427285ffaeac8d8a4452fff28e9c3',
      sdkVersion: sdkPackage.version,
      zodVersion: JSON.parse(await readFile(join(source, 'node_modules/zod/package.json'), 'utf8')).version,
      anthropicSdkVersion: pkg.devDependencies['@anthropic-ai/sdk'],
      dependencyOverride:
        'Copied installed SDK; aligned supported peer versions. Base npm lock is historical, not an updated lock.',
      contentUnionPatch:
        'Removed retired mid_conv_system; mcp_tool_listing follows the existing non-rendered content branch.',
      productionEnabled: false,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ target, sdkVersion: sdkPackage.version, productionEnabled: false }));
