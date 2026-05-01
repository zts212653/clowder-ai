#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') result.projectRoot = argv[++i];
    else if (arg === '--target-root') result.targetRoot = argv[++i];
  }
  return result;
}

function defaultProjectRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let current = resolve(scriptDir, '..');
  while (true) {
    const apiModule = resolve(current, 'packages', 'api', 'dist', 'agent-hooks', 'index.js');
    const workspaceFile = resolve(current, 'pnpm-workspace.yaml');
    if (existsSync(apiModule) || existsSync(workspaceFile)) return current;

    const parent = dirname(current);
    if (parent === current) return resolve(scriptDir, '..');
    current = parent;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot ?? process.env.CAT_CAFE_PROJECT_ROOT ?? defaultProjectRoot());
  const targetRoot = resolve(args.targetRoot ?? process.env.CAT_CAFE_TARGET_ROOT ?? homedir());
  const agentHooksModule = resolve(projectRoot, 'packages', 'api', 'dist', 'agent-hooks', 'index.js');

  if (!existsSync(agentHooksModule)) {
    throw new Error(`agent hook module missing: ${agentHooksModule}`);
  }

  const { syncAgentHooks } = await import(pathToFileURL(agentHooksModule).href);
  const status = await syncAgentHooks({ projectRoot, targetRoot });
  console.log(`Agent CLI hook sync status: ${status.status}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
