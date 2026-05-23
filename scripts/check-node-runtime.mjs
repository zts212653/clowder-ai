#!/usr/bin/env node

const minMajor = Number.parseInt(process.env.CAT_CAFE_NODE_MIN_MAJOR ?? '20', 10);
const maxMajorExclusive = Number.parseInt(process.env.CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE ?? '26', 10);
const version = process.env.CAT_CAFE_TEST_NODE_VERSION ?? process.versions.node;
const major = Number.parseInt(version.split('.')[0] ?? '', 10);

if (process.env.CAT_CAFE_SKIP_NODE_RUNTIME_GUARD === '1') {
  process.exit(0);
}

if (Number.isNaN(major) || major < minMajor || major >= maxMajorExclusive) {
  console.error(
    `[node-runtime] Node ${version} is not supported by this Cat Cafe checkout; expected >=${minMajor} <${maxMajorExclusive}.`,
  );
  console.error('[node-runtime] Install the supported local runtime and retry:');
  console.error('  brew install node@24');
  console.error('  PATH="$(brew --prefix node@24)/bin:$PATH" pnpm install --frozen-lockfile');
  console.error('[node-runtime] Or set CAT_CAFE_NODE_BIN=/absolute/path/to/node for startup scripts.');
  process.exit(1);
}
