#!/usr/bin/env node
import { engineAt, nodeInfo, probeNode, smokeNativeModules, validateNode } from './lib/build-node.mjs';

const [mode, root, platform, arch, executable, apiDir] = process.argv.slice(2);
try {
  if (
    !root ||
    !['host', 'node', 'artifact'].includes(mode) ||
    !['darwin', 'win32'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  ) {
    throw new Error(
      'Usage: verify-build-node.mjs <host|node|artifact> <root> <darwin|win32> <arm64|x64> [node-executable] [api-dir]',
    );
  }
  const engine = engineAt(root);
  const builtWith = validateNode(nodeInfo(), { engine, platform, arch });
  // The first execution inside a freshly packaged macOS app can exceed the
  // standalone Node probe budget. Keep a bounded installed-artifact budget;
  // never retry a failed probe or accept an artifact without executing it.
  const artifactTimeout = platform === 'darwin' ? 120000 : 30000;
  if (mode !== 'host') {
    if (!executable) throw new Error('Bundled Node executable required');
    const start = Date.now();
    validateNode(probeNode(executable, mode === 'artifact' ? artifactTimeout : 15000), {
      engine,
      platform,
      arch,
      builtWith,
    });
    process.stderr.write(`Bundled Node version/ABI/target verified in ${Date.now() - start} ms\n`);
  }
  if (mode === 'artifact') {
    if (!apiDir) throw new Error('Deployed API directory required');
    process.stderr.write(smokeNativeModules(executable, apiDir, artifactTimeout));
  }
  process.stdout.write(`${builtWith.version}\n`);
} catch (error) {
  console.error(
    `[desktop-node] ${error.message}\nFix: use a supported native Node runtime and rebuild the deploy artifacts; no version is guessed.`,
  );
  process.exitCode = 1;
}
