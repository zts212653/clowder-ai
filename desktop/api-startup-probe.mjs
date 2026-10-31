// Preload runs before the API's static module graph, preserving its argv/entrypoint.
// Fields deliberately exclude paths, environment, configuration and credentials.
import { registerHooks } from 'node:module';
import { isMainThread, threadId } from 'node:worker_threads';
import { readAheadApi } from './api-startup-read-ahead.mjs';

const started = performance.now();
const moduleGroups = new Map();
const uniqueModuleUrls = new Set();
function moduleGroup(url) {
  if (String(url).startsWith('node:')) return 'builtin';
  const dependency = String(url).split('/node_modules/');
  if (dependency.length < 2) return 'application';
  const name = dependency.at(-1).match(/^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:\/|$)/)?.[1];
  return name?.slice(0, 100) ?? 'dependency';
}
let moduleLoads = 0,
  fileModuleLoads = 0,
  builtinModuleLoads = 0,
  moduleReadMs = 0,
  moduleResolveMs = 0,
  lastReport = started;
const hook = isMainThread
  ? registerHooks({
      resolve(specifier, context, next) {
        const began = performance.now();
        try {
          return next(specifier, context);
        } finally {
          moduleResolveMs += performance.now() - began;
        }
      },
      load(url, context, next) {
        const began = performance.now();
        try {
          return next(url, context);
        } finally {
          const elapsed = performance.now() - began;
          moduleLoads++;
          uniqueModuleUrls.add(url);
          if (String(url).startsWith('file:')) fileModuleLoads++;
          if (String(url).startsWith('node:')) builtinModuleLoads++;
          moduleReadMs += elapsed;
          const name = moduleGroup(url);
          const group = moduleGroups.get(name) ?? { name, loads: 0, readMs: 0 };
          group.loads++;
          group.readMs += elapsed;
          moduleGroups.set(name, group);
          if (performance.now() - lastReport > 5000) {
            lastReport = performance.now();
            milestone('module-loading');
          }
        }
      },
    })
  : null;
function milestone(phase) {
  const resource = process.resourceUsage();
  console.info(
    '[api-startup]',
    JSON.stringify({
      phase,
      pid: process.pid,
      threadId,
      moduleLoads,
      loadHookCalls: moduleLoads,
      uniqueModuleUrls: uniqueModuleUrls.size,
      fileModuleLoads,
      builtinModuleLoads,
      moduleReadMs: Math.round(moduleReadMs),
      moduleResolveMs: Math.round(moduleResolveMs),
      moduleGroups: [...moduleGroups.values()]
        .sort((a, b) => b.readMs - a.readMs)
        .slice(0, 12)
        .map((group) => ({ ...group, readMs: Math.round(group.readMs) })),
      elapsedMs: Math.round(performance.now() - started),
      processUptimeMs: Math.round(process.uptime() * 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      userCpuMs: Math.round(resource.userCPUTime / 1000),
      systemCpuMs: Math.round(resource.systemCPUTime / 1000),
    }),
  );
  if (phase === 'http-listening') hook?.deregister();
}
globalThis.__clowderStartupMilestone = milestone;
milestone('node-bootstrap');
process.once('exit', (code) => milestone(`exit:${code}`));
if (isMainThread) {
  milestone('program-read-ahead-start');
  const heartbeat = setInterval(() => milestone('program-read-ahead-progress'), 5000);
  try {
    console.info('[api-startup-read-ahead]', JSON.stringify(await readAheadApi(process.argv[1])));
  } finally {
    clearInterval(heartbeat);
    milestone('program-read-ahead-complete');
  }
}
