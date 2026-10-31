const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** Use the config emitted by this production build, never its build-time plugins. */
function loadDesktopWebConfig(web, requireWeb = createRequire(path.join(web, 'package.json'))) {
  let manifest;
  let revision;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(web, '.next', 'required-server-files.json'), 'utf8'));
    revision = fs.readFileSync(path.join(web, '.next', '.build-commit'), 'utf8').trim();
  } catch {
    throw new Error('Packaged Next production config or build identity is missing or invalid');
  }
  const config = manifest?.config;
  if (
    manifest?.version !== 1 ||
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    config.distDir !== '.next' ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    !config.env ||
    typeof config.env !== 'object' ||
    Array.isArray(config.env) ||
    config.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION !== revision
  ) {
    throw new Error('Packaged Next production config does not match its build identity');
  }
  if (config.images?.unoptimized !== true) {
    throw new Error(
      'Packaged Next production config requires desktop images without an installation cache; rebuild Web for Desktop',
    );
  }
  try {
    if (!fs.readFileSync(path.join(web, '.next', 'BUILD_ID'), 'utf8').trim()) throw new Error('Empty BUILD_ID');
  } catch {
    throw new Error('Packaged Next production config BUILD_ID is missing or invalid');
  }

  const requireNext = createRequire(requireWeb.resolve('next/package.json'));
  // Next 14's serialized-config branch returns before loadEnvConfig. Preserve its
  // production file loading and process-env precedence before taking that branch.
  requireNext('@next/env').loadEnvConfig(web, false, {
    info() {},
    error() {
      console.error('Could not load production environment configuration');
    },
  });
  // This is the same mechanism used by this Next version's generated standalone
  // server. Passing `conf` alone does not reach NextCustomServer.prepare's router.
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  return config;
}

module.exports = { loadDesktopWebConfig };
