// Public export counterpart of the home inbound guard. No environment bypass.
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolveDeploymentDefaults } from '../packages/shared/src/deployment-defaults.ts';
import { classifyPath, getHomeTerms, getPublicTerms, parseDictionary } from './brand-dictionary-helper.mjs';
import { assertDeploymentBrands } from './deployment-brand-config.mjs';

const fromIndex = process.argv.includes('--from-index');
const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
const exists = (path) =>
  fromIndex
    ? spawnSync('git', ['cat-file', '-e', `:${path}`], { stdio: 'ignore' }).status === 0
    : spawnSync('test', ['-f', path], { stdio: 'ignore' }).status === 0;
const read = (path) => (fromIndex ? git('show', `:${path}`) : readFileSync(path, 'utf8'));
const isRegularRoadmap = (path) => {
  if (fromIndex) return /^100(?:644|755) [a-f0-9]+ 0\t/.test(git('ls-files', '--stage', '--', path));
  try {
    return lstatSync('docs').isDirectory() && lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const fail = (message) => {
  console.error(`Public Brand Guard: ${message}`);
  process.exitCode = 1;
};

try {
  const provenance = JSON.parse(read('.sync-provenance.json'));
  if (
    !/^[a-f0-9]{40}$/.test(provenance.source_commit_sha) ||
    !/^[a-f0-9]{40}$/.test(provenance.target_head_sha) ||
    !Number.isInteger(provenance.manifest_version) ||
    provenance.manifest_version < 1
  ) {
    throw new Error('invalid public provenance');
  }
  if (
    exists('scripts/sync-to-opensource.sh') ||
    spawnSync('git', ['cat-file', '-e', 'HEAD:scripts/sync-to-opensource.sh'], { stdio: 'ignore' }).status === 0
  ) {
    throw new Error('home exporter must retain inbound policy; removing it does not select public policy');
  }
  if (exists('packages/shared/src/deployment-profiles.json')) {
    const file = JSON.parse(read('packages/shared/src/deployment-profiles.json'));
    assertDeploymentBrands(file, parseDictionary(read('assets/brand-dictionary.yaml')), 'opensource');
    const defaults = resolveDeploymentDefaults(file);
    if (
      file.activeProfile !== 'opensource' ||
      Object.keys(file.profiles).join(',') !== 'opensource' ||
      defaults.apiPort !== 3004 ||
      defaults.webPort !== 3003
    ) {
      fail('expected public deployment defaults (frontend 3003, API 3004)');
    }
    if (defaults.roadmapPath !== 'docs/ROADMAP.md') {
      fail('roadmapPath must match the generated artifact docs/ROADMAP.md');
    }
    if (!isRegularRoadmap(defaults.roadmapPath)) {
      fail(`roadmap artifact ${defaults.roadmapPath} must exist as a regular file in a real docs directory`);
    }
  } else {
    fail('public deployment defaults must exist');
  }
  const scopeText = readFileSync(0, 'utf8');
  const scope = scopeText.trimStart().startsWith('[') ? JSON.parse(scopeText) : scopeText.split('\n').filter(Boolean);
  if (!Array.isArray(scope) || scope.some((path) => typeof path !== 'string' || !path || path.includes('\0'))) {
    throw new Error('invalid public path scope');
  }
  console.log(`Public Brand Guard: ${scope.length} scoped file(s), ${fromIndex ? 'index' : 'worktree'}`);
  const required = new Map([
    [
      'packages/web/src/app/layout.tsx',
      ['deploymentDefaults.brand.name', 'deploymentDefaults.brand.tagline', 'favicon.svg', 'icon-192x192.png'],
    ],
    ['packages/web/public/manifest.json', []],
    ['packages/web/src/components/SplitPaneView.tsx', ['deploymentDefaults.brand.name']],
    ['packages/web/src/components/ChatContainerHeader.tsx', ['deploymentDefaults.brand.displayName']],
    ['packages/web/src/components/ThreadIndicator.tsx', ["'cat-cafe'", "'cat-cafe-runtime'"]],
    ['packages/web/src/utils/api-client.ts', ['HttpOnly session cookie', 'client for Clowder AI']],
    ['packages/api/src/index.ts', []],
    ['packages/api/src/config/frontend-origin.ts', []],
    ['packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts', []],
  ]);
  // Sanitized dictionaries can have identical home/public variants. Only home
  // variants absent from the public vocabulary are contamination, never the
  // public product name itself. Compatibility identifiers remain permitted.
  const dictionary = parseDictionary(read('assets/brand-dictionary.yaml'));
  for (const [anchor, expected] of [
    ['assets/system-prompts/fixture.md', 'manual-port'],
    ['packages/web/public/manifest.json', 'brand-sensitive'],
    ['packages/web/public/icons/logo.png', 'brand-sensitive'],
    ['packages/web/public/concierge/skins/ragdoll-v1/pet.json', 'brand-sensitive'],
  ]) {
    if (classifyPath(anchor, dictionary).classification !== expected)
      throw new Error(`dictionary policies missing ${anchor}`);
  }
  const publicVocabulary = new Set(getPublicTerms(dictionary).flatMap((t) => t.publicPatterns));
  const homeBrandTerms = [
    ...new Set(
      getHomeTerms(dictionary)
        .filter((t) => t.severity === 'P1' && t.termClass === 'brand')
        .flatMap((t) => t.homePatterns)
        .filter((term) => !publicVocabulary.has(term)),
    ),
  ];
  if (!publicVocabulary.has('Clowder AI')) throw new Error('public brand dictionary unavailable');
  // Existence invariants apply before content scanning, including staged removals.
  for (const path of ['packages/web/public/icons/favicon.svg']) {
    if (!exists(path)) fail(`${path}: must exist`);
  }
  for (const path of scope) {
    if (!exists(path)) continue; // A staged removal has no content to validate.
    const policy = classifyPath(path, dictionary).classification;
    if (!required.has(path) && !['brand-sensitive', 'manual-port'].includes(policy)) continue;
    const body = read(path);
    if (path === 'packages/web/public/manifest.json') {
      const manifest = JSON.parse(body);
      const { brand } = resolveDeploymentDefaults(JSON.parse(read('packages/shared/src/deployment-profiles.json')));
      for (const [field, value] of Object.entries({
        name: brand.displayName,
        short_name: brand.shortName,
        description: brand.tagline,
      })) {
        if (manifest[field] !== value) fail(`manifest ${field} differs from the selected deployment brand`);
      }
    }
    for (const term of required.get(path) ?? []) {
      if (!body.includes(term))
        fail(`${path}: missing ${term}${term.includes(':3003') ? ' (public frontend port)' : ''}`);
    }
    if (path === 'packages/api/src/config/frontend-origin.ts') {
      if (
        /const\s+DEFAULT_FRONTEND_BASE_URL\s*=\s*deploymentDefaults\.frontendBaseUrl/.test(body) &&
        /import\s*\{[^}]*\bdeploymentDefaults\b[^}]*\}\s*from\s*['"]@cat-cafe\/shared['"]/.test(body)
      ) {
        if (!exists('packages/shared/src/deployment-profiles.json')) fail('missing public deployment defaults');
      } else if (!/const\s+DEFAULT_FRONTEND_BASE_URL\s*=\s*['"]http:\/\/localhost:3003['"]/.test(body)) {
        fail(`${path}: expected public frontend port 3003 in DEFAULT_FRONTEND_BASE_URL`);
      }
    }
    for (const term of homeBrandTerms) {
      if (body.includes(term)) fail(`${path}: home-only brand term ${term}`);
    }
    if (
      ['packages/api/src/index.ts', 'packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts'].includes(
        path,
      ) &&
      /\?\?\s*['"]3002['"]/.test(body)
    )
      fail(`${path}: expected public API fallback 3004, found 3002`);
  }
} catch (error) {
  fail(error.message);
}
