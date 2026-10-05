import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALPHA_COORDINATE_VERSION = 1;
// Runtime/standard Alpha/Redis, Service manifest defaults, launcher proxy and
// the F247 remote sidecar. The test checks these against their source controls.
const PROTECTED_PORTS = new Set([
  3001, 3002, 3011, 3012, 3098, 4100, 4111, 5201, 5211, 6379, 6099, 6397, 6398, 6399, 6401, 9876, 9877, 9878, 9879,
  9880, 9881,
]);
const PORT_ROLES = ['frontend', 'api', 'preview', 'service', 'redis'];
const EXACT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_PATH = /^[A-Za-z0-9._/@+-]+$/;

function readProcessCwds() {
  const output = execFileSync('lsof', ['-nP', '-a', '-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!output) throw new Error('Process cwd observation is unreadable');
  const cwds = [];
  let pid;
  for (const line of output.split('\n')) {
    if (/^p[1-9]\d*$/.test(line)) pid = Number(line.slice(1));
    else if (line === 'fcwd' && pid) continue;
    else if (line.startsWith('n') && pid && isAbsolute(line.slice(1))) {
      const raw = line.slice(1);
      cwds.push({ pid, cwd: existsSync(raw) ? realpathSync(raw) : raw });
    } else throw new Error('Process cwd observation is incomplete');
  }
  return cwds;
}

/** A different free tuple cannot authorize rebuilding an already serving checkout. No process is signalled. */
export function assertNamedAlphaNotServing(coordinates, { readCwds = readProcessCwds } = {}) {
  const root = coordinates.alphaRoot;
  const processes = readCwds();
  if (processes.some(({ cwd }) => cwd === root || cwd.startsWith(`${root}/`)))
    throw new Error('Named Alpha checkout has a live process; preserve its serving tree');
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function physicalDirectory(raw) {
  if (typeof raw !== 'string' || !SAFE_PATH.test(raw) || !isAbsolute(raw)) throw new Error('Invalid Alpha directory');
  const absolute = resolve(raw);
  if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory())
    throw new Error('Alpha directory aliases are not permitted');
  return absolute;
}

function assertNotLinked(path) {
  let cursor = resolve(path);
  while (true) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Alpha path contains a symlink');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (cursor === parent) return;
    cursor = parent;
  }
}

function assertMain(root) {
  const common = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (
    basename(root) !== 'cat-cafe' ||
    common !== join(root, '.git') ||
    git(root, ['branch', '--show-current']) !== 'main'
  )
    throw new Error('Named Alpha requires the actual main checkout');
  const controls = [
    'scripts/alpha-worktree.sh',
    'scripts/start-dev.sh',
    'scripts/lib/alpha-coordinates.mjs',
    'scripts/lib/alpha-named-launch.sh',
    'scripts/lib/alpha-redis-process.mjs',
    'scripts/lib/alpha-redis-leases.mjs',
  ];
  try {
    git(root, ['ls-files', '--error-unmatch', '--', ...controls]);
    git(root, ['diff', '--exit-code', 'HEAD', '--', ...controls]);
  } catch {
    throw new Error('Named Alpha requires committed unchanged launcher controls');
  }
  return common;
}

export function deriveNamedAlphaCoordinates({ mainRoot, instance, ports, targetSha }) {
  const root = physicalDirectory(mainRoot);
  assertMain(root);
  if (typeof instance !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(instance) || instance.length > 48)
    throw new Error('Invalid named Alpha instance');
  if (typeof ports !== 'string') throw new Error('Named Alpha requires one explicit port tuple');
  const raw = ports.split(',');
  if (raw.length !== PORT_ROLES.length || raw.some((port) => !/^[1-9]\d*$/.test(port)))
    throw new Error('Invalid named Alpha port tuple');
  const values = raw.map(Number);
  if (
    new Set(values).size !== values.length ||
    values.some((port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535 || PROTECTED_PORTS.has(port))
  )
    throw new Error('Named Alpha ports must be distinct, non-protected ports from 1024 to 65535');
  if (targetSha !== undefined && !EXACT_SHA.test(targetSha)) throw new Error('Invalid Alpha target revision');
  const alphaRoot = join(dirname(root), `cat-cafe-alpha-${instance}`);
  const branch = `alpha/${instance}-main-sync`;
  for (const path of [
    alphaRoot,
    join(alphaRoot, '.cat-cafe'),
    join(alphaRoot, '.cat-cafe/redis'),
    join(alphaRoot, '.cat-cafe/redis-backups'),
    join(alphaRoot, '.cat-cafe/collective-service'),
    join(alphaRoot, '.cat-cafe/uploads'),
    join(alphaRoot, '.cat-cafe/transcripts'),
    join(alphaRoot, '.cat-cafe/stories'),
    join(root, '.env'),
  ])
    assertNotLinked(path);
  return {
    v: ALPHA_COORDINATE_VERSION,
    instance,
    mainRoot: root,
    alphaRoot,
    branch,
    ports: Object.fromEntries(PORT_ROLES.map((role, index) => [role, values[index]])),
    ...(targetSha === undefined ? {} : { targetSha }),
  };
}

export function parseNamedAlphaCoordinates(raw) {
  const candidate = JSON.parse(raw);
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    candidate.v !== ALPHA_COORDINATE_VERSION
  )
    throw new Error('Invalid Alpha coordinate envelope');
  const expected = deriveNamedAlphaCoordinates({
    mainRoot: candidate.mainRoot,
    instance: candidate.instance,
    ports: PORT_ROLES.map((role) => candidate.ports?.[role]).join(','),
    targetSha: candidate.targetSha,
  });
  if (JSON.stringify(candidate) !== JSON.stringify(expected)) throw new Error('Alpha coordinate envelope changed');
  return expected;
}

/** Git registration and history are the existing authority source; the tuple is configuration, not a grant. */
export function assertNamedAlphaCheckout(coordinates, { requireBuilds = false, requireTarget = false } = {}) {
  const { mainRoot, alphaRoot, branch, targetSha } = coordinates;
  const root = physicalDirectory(alphaRoot);
  const common = assertMain(mainRoot);
  const registered = git(mainRoot, ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .some(
      (record) =>
        record.split('\n').includes(`worktree ${root}`) && record.split('\n').includes(`branch refs/heads/${branch}`),
    );
  if (
    !registered ||
    realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common ||
    git(root, ['branch', '--show-current']) !== branch
  )
    throw new Error('Named Alpha checkout is not registered under its exact main branch');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=no']))
    throw new Error('Named Alpha has tracked changes');
  const head = git(root, ['rev-parse', 'HEAD']);
  try {
    git(mainRoot, ['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main']);
  } catch {
    throw new Error('Named Alpha revision is outside main lineage');
  }
  if ((requireTarget && !targetSha) || (targetSha && head !== targetSha))
    throw new Error('Named Alpha target revision changed');
  if (requireBuilds) {
    for (const name of ['shared', 'api', 'mcp-server']) {
      const dist = join(root, 'packages', name, 'dist');
      assertNotLinked(join(dist, 'index.js'));
      assertNotLinked(join(dist, '.build-commit'));
      if (!existsSync(join(dist, 'index.js')) || readFileSync(join(dist, '.build-commit'), 'utf8').trim() !== head)
        throw new Error('Named Alpha compiled revision is not current');
    }
  }
  return head;
}

export function namedAlphaEnvironment(coordinates) {
  if (!coordinates.targetSha) throw new Error('Named Alpha environment requires its frozen target');
  const { mainRoot, alphaRoot, ports } = coordinates;
  return {
    CAT_CAFE_ALPHA_COORDINATES: JSON.stringify(coordinates),
    CAT_CAFE_DEPLOYMENT_ID: 'alpha',
    CAT_CAFE_RUNTIME_ROOT: alphaRoot,
    CAT_CAFE_WORKSPACE_ROOT: mainRoot,
    CAT_CAFE_MCP_SERVER_PATH: join(alphaRoot, 'packages/mcp-server/dist/index.js'),
    CAT_CAFE_DATA_DIR: join(alphaRoot, '.cat-cafe'),
    UPLOAD_DIR: join(alphaRoot, '.cat-cafe/uploads'),
    TRANSCRIPT_DATA_DIR: join(alphaRoot, '.cat-cafe/transcripts'),
    ANNOTATION_DATA_DIR: join(alphaRoot, '.cat-cafe/stories'),
    CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED: '1',
    CAT_CAFE_PROVISION_GLOBAL_SIDECAR: '0',
    CAT_CAFE_DIRECT_NO_WATCH: '1',
    CAT_CAFE_RESPECT_DOTENV_PORTS: '0',
    WORKTREE_PORT_OFFSET: '0',
    API_SERVER_HOST: '127.0.0.1',
    API_SERVER_PORT: String(ports.api),
    FRONTEND_PORT: String(ports.frontend),
    FRONTEND_URL: `http://localhost:${ports.frontend}`,
    PREVIEW_GATEWAY_PORT: String(ports.preview),
    NEXT_PUBLIC_API_URL: `http://localhost:${ports.api}`,
    REDIS_PORT: String(ports.redis),
    REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    REDIS_KEY_PREFIX: 'cat-cafe:',
    REDIS_DATA_DIR: join(alphaRoot, '.cat-cafe/redis'),
    REDIS_BACKUP_DIR: join(alphaRoot, '.cat-cafe/redis-backups'),
    COLLECTIVE_SERVICE_HOST: '127.0.0.1',
    COLLECTIVE_SERVICE_PORT: String(ports.service),
    COLLECTIVE_SERVICE_DATA_DIR: join(alphaRoot, '.cat-cafe/collective-service'),
    COLLECTIVE_SERVICE_PUBLIC_URL: `http://127.0.0.1:${ports.service}`,
    NEXT_PUBLIC_COLLECTIVE_SERVICE_URL: `http://127.0.0.1:${ports.service}`,
    COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS: `http://localhost:${ports.frontend},http://127.0.0.1:${ports.frontend}`,
    ANTHROPIC_PROXY_ENABLED: '0',
    ASR_ENABLED: '0',
    TTS_ENABLED: '0',
    LLM_POSTPROCESS_ENABLED: '0',
    EMBED_ENABLED: '0',
    EMBED_MODE: 'off',
    AUDIO_SERVICE_ENABLED: '0',
    CONNECTOR_GATEWAY_AUTOSTART: '0',
    CAT_CAFE_F247_CLOUD_AUTOSTART: '0',
  };
}

export function validateNamedAlphaEnvironment(env, installationRoot) {
  const coordinates = parseNamedAlphaCoordinates(env.CAT_CAFE_ALPHA_COORDINATES);
  if (physicalDirectory(installationRoot) !== coordinates.alphaRoot) throw new Error('Alpha installation root changed');
  assertNamedAlphaCheckout(coordinates, { requireBuilds: true, requireTarget: true });
  for (const [key, value] of Object.entries(namedAlphaEnvironment(coordinates)))
    if (env[key] !== value) throw new Error(`Alpha environment changed: ${key}`);
  return coordinates;
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag) || options[flag] !== undefined || !args[index + 1])
      throw new Error('Invalid Alpha coordinate arguments');
    options[flag] = args[index + 1];
  }
  return options;
}

function runCli([command, ...args]) {
  if (command === 'derive') {
    const options = parseOptions(args, ['--main-root', '--instance', '--ports', '--target-sha']);
    return JSON.stringify(
      deriveNamedAlphaCoordinates({
        mainRoot: options['--main-root'],
        instance: options['--instance'],
        ports: options['--ports'],
        targetSha: options['--target-sha'],
      }),
    );
  }
  const options = parseOptions(args, ['--record', '--installation-root', '--require-builds']);
  const coordinates = parseNamedAlphaCoordinates(options['--record']);
  if (command === 'inspect') {
    assertNamedAlphaCheckout(coordinates, {
      requireBuilds: options['--require-builds'] === '1',
      requireTarget: options['--require-builds'] === '1',
    });
    return JSON.stringify(coordinates);
  }
  if (command === 'not-serving') {
    assertNamedAlphaCheckout(coordinates);
    assertNamedAlphaNotServing(coordinates);
    return JSON.stringify(coordinates);
  }
  if (command !== 'env' || physicalDirectory(options['--installation-root']) !== coordinates.alphaRoot)
    throw new Error('Invalid Alpha coordinate consumer');
  assertNamedAlphaCheckout(coordinates, { requireBuilds: true, requireTarget: true });
  return Object.entries(namedAlphaEnvironment(coordinates))
    .map(([key, value]) => `${key}\t${value}`)
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`[alpha-coordinates] ${error.message}\n`);
    process.exitCode = 1;
  }
}
