#!/usr/bin/env node

const minMajor = Number.parseInt(process.env.CAT_CAFE_NODE_MIN_MAJOR ?? '20', 10);
const maxMajorExclusive = Number.parseInt(process.env.CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE ?? '26', 10);
const version = process.env.CAT_CAFE_TEST_NODE_VERSION ?? process.versions.node;
const major = Number.parseInt(version.split('.')[0] ?? '', 10);

if (process.env.CAT_CAFE_SKIP_NODE_RUNTIME_GUARD === '1') {
  process.exit(0);
}

// Guard: NODE_ENV=production (or npm_config_production=true) causes pnpm to
// skip devDependencies. In this monorepo's current workflows, devDeps
// (TypeScript, Next.js, Tailwind, etc.) are required for ALL builds — build
// tools live in devDeps. If a future deploy path legitimately needs --prod,
// bypass with CAT_CAFE_SKIP_NODE_RUNTIME_GUARD=1.
// This catches the recurring worktree build failure that has hit every cat
// for months (Claude Code shell inherits NODE_ENV=production).
const prodEnv = process.env.NODE_ENV === 'production';
const prodFlag = process.env.npm_config_production === 'true' || process.env.NPM_CONFIG_PRODUCTION === 'true';

if (prodEnv || prodFlag) {
  const reason = prodEnv ? 'NODE_ENV=production' : 'npm_config_production=true';
  console.error('');
  console.error(`[cat-cafe] ❌ ${reason} detected — pnpm will skip devDependencies!`);
  console.error('[cat-cafe] This monorepo needs devDeps (TypeScript, Next.js, Tailwind, etc.) for ALL builds.');
  console.error('[cat-cafe] Fix — prefix your install command:');
  console.error('');
  console.error('  env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm install');
  console.error('');
  console.error('[cat-cafe] Or bypass this guard if you know what you are doing:');
  console.error('');
  console.error('  CAT_CAFE_SKIP_NODE_RUNTIME_GUARD=1 pnpm install');
  console.error('');
  process.exit(1);
}

if (Number.isNaN(major) || major < minMajor || major >= maxMajorExclusive) {
  console.error(
    `[node-runtime] Node ${version} is not supported by this Clowder AI checkout; expected >=${minMajor} <${maxMajorExclusive}.`,
  );
  console.error('[node-runtime] Install the supported local runtime and retry:');
  console.error('  brew install node@24');
  console.error('  PATH="$(brew --prefix node@24)/bin:$PATH" pnpm install --frozen-lockfile');
  console.error('[node-runtime] Or set CAT_CAFE_NODE_BIN=/absolute/path/to/node for startup scripts.');
  process.exit(1);
}
