import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(here, '..');
const IMPLEMENTER_PATTERN = /\bimplements\s+(?:[A-Za-z0-9_,<> ]*\b)?(?:AgentService|L0InjectableAgentService)\b/;
const DIRECT_LAUNCH_PATTERNS = [
  /\bspawnCli\s*\(/,
  /\bthis\.spawnFn\s*\(/,
  /\bfetch\s*\(/,
  /\.promptStream\s*\(/,
  /\.sendMessage\s*\(/,
  /\.injectPrompt\s*\(/,
];
const AWAITED_RECORDER_PATTERN = /\bawait[\s\S]{0,180}\bbeforeProviderLaunch\b/;

function matchCount(source, pattern) {
  return (source.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

function directLaunchSiteCount(source, name) {
  const rawCount = DIRECT_LAUNCH_PATTERNS.reduce((count, pattern) => count + matchCount(source, pattern), 0);
  const nonRequestControlLaunches = name.endsWith('ClaudeBgCarrierService.ts')
    ? matchCount(source, /this\.spawnFn\(this\.claudeCommand,\s*\['stop'/)
    : 0;
  return rawCount - nonRequestControlLaunches;
}

function walkTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTypeScriptFiles(path));
    else if (entry.isFile() && extname(entry.name) === '.ts') files.push(path);
  }
  return files;
}

export function scanProviderRequestRecorderCoverage(repoRoot = DEFAULT_REPO_ROOT) {
  const providerRoot = join(repoRoot, 'packages/api/src/domains/cats/services/agents/providers');
  const files = walkTypeScriptFiles(providerRoot);
  const implementers = [];
  const issues = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!IMPLEMENTER_PATTERN.test(source)) continue;
    const name = relative(repoRoot, file);
    implementers.push(name);
    const launchSites = directLaunchSiteCount(source, name);
    const awaitedFences = matchCount(source, AWAITED_RECORDER_PATTERN);
    if (launchSites > awaitedFences) {
      issues.push(
        `${name}: ${launchSites} direct provider launch sites but only ${awaitedFences} awaited beforeProviderLaunch fences`,
      );
    }
  }

  const appServerPath = join(providerRoot, 'CodexAppServerClient.ts');
  const appServerSource = readFileSync(appServerPath, 'utf8');
  const appServerLaunches = matchCount(appServerSource, /this\.request\(\s*['"]turn\/start['"]/);
  const appServerFences = matchCount(appServerSource, AWAITED_RECORDER_PATTERN);
  if (appServerLaunches > appServerFences) {
    issues.push(`${relative(repoRoot, appServerPath)}: turn/start has no awaited beforeProviderLaunch fence`);
  }

  if (implementers.length === 0) issues.push('no AgentService implementers discovered');
  return { implementers: implementers.sort(), issues };
}

export function assertProviderRequestRecorderCoverage(repoRoot = DEFAULT_REPO_ROOT) {
  const result = scanProviderRequestRecorderCoverage(repoRoot);
  if (result.issues.length > 0) {
    throw new Error(
      `F299 provider request recorder census failed:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`,
    );
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const rootFlag = process.argv.indexOf('--root');
  const repoRoot = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1]) : DEFAULT_REPO_ROOT;
  const result = assertProviderRequestRecorderCoverage(repoRoot);
  process.stdout.write(`F299 provider request recorder census OK (${result.implementers.length} implementers)\n`);
}
