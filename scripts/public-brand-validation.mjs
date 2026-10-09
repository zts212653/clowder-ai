// Public export counterpart of the home inbound guard. No environment bypass.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyPath, getHomeTerms, getPublicTerms, parseDictionary } from './brand-dictionary-helper.mjs';

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
  const scope = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  console.log(`Public Brand Guard: ${scope.length} scoped file(s), ${fromIndex ? 'index' : 'worktree'}`);
  const required = new Map([
    [
      'packages/web/src/app/layout.tsx',
      ['Clowder AI', 'Your AI team collaboration space', 'favicon.svg', 'icon-192x192.png'],
    ],
    ['packages/web/public/manifest.json', ['Clowder AI']],
    ['packages/web/src/components/SplitPaneView.tsx', ['Clowder AI']],
    ['packages/web/src/components/ChatContainerHeader.tsx', ['Clowder AI', "'cat-cafe'", "'cat-cafe-runtime'"]],
    ['packages/web/src/utils/api-client.ts', ['HttpOnly session cookie', 'client for Clowder AI']],
    ['packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts', ['http://localhost:3003']],
    ['packages/api/src/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.ts', []],
    ['packages/api/src/index.ts', []],
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
    for (const term of required.get(path) ?? []) {
      if (!body.includes(term))
        fail(`${path}: missing ${term}${term.includes(':3003') ? ' (public frontend port)' : ''}`);
    }
    for (const term of homeBrandTerms) {
      if (body.includes(term)) fail(`${path}: home-only brand term ${term}`);
    }
    if (
      path === 'packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts' &&
      /http:\/\/localhost:3001\b/.test(body)
    )
      fail(`${path}: expected public frontend port 3003, found 3001`);
    if (path === 'packages/api/src/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.ts') {
      if (!/API_SERVER_PORT\s*\?\?\s*['"]3004['"]/.test(body))
        fail(`${path}: expected public API fallback API_SERVER_PORT ?? '3004'`);
      if (/localhost:300[1-4]\b/.test(body)) fail(`${path}: hardcoded localhost port bypasses API_SERVER_PORT`);
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
