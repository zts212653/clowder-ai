#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
  const agentHooksDirectory = resolve(projectRoot, 'packages', 'api', 'dist', 'agent-hooks');
  const bundledAgentHooksModule = resolve(agentHooksDirectory, 'index.desktop.js');
  const agentHooksModule = existsSync(bundledAgentHooksModule)
    ? bundledAgentHooksModule
    : resolve(agentHooksDirectory, 'index.js');
  const started = performance.now();
  const initialCpu = process.cpuUsage();
  const logFiles = [
    resolve(projectRoot, '.installer-logs', 'agent-hooks.log'),
    resolve(targetRoot, '.cat-cafe', 'installer-logs', 'agent-hooks.log'),
  ];
  const emit = (event) => {
    const line = `[agent-hook-install] ${JSON.stringify({
      version: 1,
      component: 'node',
      pid: process.pid,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      ...event,
    })}\n`;
    process.stdout.write(line);
    for (const logFile of logFiles) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, line, 'utf8');
        break;
      } catch {
        // Original-user hooks may not write Program Files. Try only the owned profile.
      }
    }
  };
  const phase = async (name, work) => {
    const phaseStarted = performance.now();
    const cpu = process.cpuUsage();
    const mark = (state) => {
      const used = process.cpuUsage(cpu);
      emit({
        phase: name,
        state,
        durationMs: Math.round((performance.now() - phaseStarted) * 100) / 100,
        userCpuMs: used.user / 1000,
        systemCpuMs: used.system / 1000,
      });
    };
    mark('started');
    try {
      const result = await work();
      mark('completed');
      return result;
    } catch (error) {
      mark('failed');
      throw error;
    }
  };

  const { syncAgentHooks } = await phase('module-import', () => import(pathToFileURL(agentHooksModule).href));
  const status = await phase('hook-sync', () => syncAgentHooks({ projectRoot, targetRoot, diagnostics: emit }));
  const healthStatus = ['configured', 'missing', 'stale', 'unsupported', 'error'].includes(status.status)
    ? status.status
    : 'error';
  const used = process.cpuUsage(initialCpu);
  emit({
    phase: 'sync-result',
    state: 'completed',
    healthStatus,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    userCpuMs: used.user / 1000,
    systemCpuMs: used.system / 1000,
  });
}

main().catch(() => {
  console.error('Agent CLI hook sync failed; inspect the fixed-phase installation diagnostics.');
  process.exit(1);
});
