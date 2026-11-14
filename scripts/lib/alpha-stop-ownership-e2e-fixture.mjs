import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { previewProcessRecordId } from './preview-process-record-key.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function copyScript(srcRel, destRoot, mode = 0o644) {
  const dest = join(destRoot, srcRel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(REPO_ROOT, srcRel)), { mode });
}

export async function createIsolatedAlphaE2EFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-e2e-ownership-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const originDir = join(root, 'origin.git');
  const mainDir = join(root, 'cat-cafe');
  const alphaDir = join(root, 'cat-cafe-alpha');
  const stateDir = join(root, 'preview-state');
  mkdirSync(stateDir, { recursive: true });

  const frontendPort = await freePort();
  const apiPort = await freePort();
  const previewGatewayPort = await freePort();
  const servicePort = await freePort();
  const redisPort = await freePort();
  const preloadPath = join(root, 'virtual-port-3011.mjs');
  writeFileSync(
    preloadPath,
    `import net from 'node:net';\nconst orig = net.createConnection;\nnet.createConnection = function patched(...args) {\n  if (args[0] && typeof args[0] === 'object' && Number(args[0].port) === 3011) {\n    return orig.call(this, { ...args[0], port: ${frontendPort} }, ...args.slice(1));\n  }\n  return orig.apply(this, args);\n};\n`,
  );
  const virtualPort3011PreloadUrl = pathToFileURL(preloadPath).href;

  execFileSync('git', ['init', '--bare', originDir], { stdio: 'ignore' });
  execFileSync('git', ['clone', originDir, mainDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Alpha E2E'], { cwd: mainDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'alpha-e2e@example.com'], { cwd: mainDir, stdio: 'ignore' });

  copyScript('scripts/alpha-worktree.sh', mainDir, 0o755);
  for (const name of readdirSync(join(REPO_ROOT, 'scripts'))) {
    if (name.endsWith('.mjs') && !name.includes('.test.')) copyScript(`scripts/${name}`, mainDir, 0o755);
  }
  for (const name of readdirSync(join(REPO_ROOT, 'scripts/lib'))) {
    if ((name.endsWith('.mjs') || name.endsWith('.sh')) && !name.includes('.test.'))
      copyScript(`scripts/lib/${name}`, mainDir, 0o644);
  }

  const realStartDev = readFileSync(join(REPO_ROOT, 'scripts/start-dev.sh'), 'utf8');
  const guardCallMatch = realStartDev.match(/^\s*ensure_supported_node_runtime\s+.*$/m);
  if (!guardCallMatch) throw new Error('Could not locate ensure_supported_node_runtime call in scripts/start-dev.sh');
  const launchChildMatch = realStartDev.match(/^launch_daemon_child\(\)\s*\{[\s\S]*?^\}/m);
  if (!launchChildMatch) throw new Error('Could not locate launch_daemon_child() in scripts/start-dev.sh');

  writeFileSync(
    join(mainDir, 'scripts/start-dev.sh'),
    `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/node-runtime-guard.sh"
${guardCallMatch[0].trim()}
verified_runtime_artifacts_for_current_tree() { return 1; }
${launchChildMatch[0]}
DAEMON_MODE=false
DAEMON_CHILD=false
ORIG_ARGS=("$@")
for a in "$@"; do
  case "$a" in
    --daemon|-d) DAEMON_MODE=true ;;
    --cat-cafe-daemon-token=*) DAEMON_CHILD=true ;;
  esac
done
if [ "$DAEMON_MODE" = true ] && [ "$DAEMON_CHILD" = false ]; then
  DAEMON_LOG_FILE="$PROJECT_ROOT/.daemon.log"
  node "$SCRIPT_DIR/daemon-state.mjs" prepare --home "$HOME" --project-root "$PROJECT_ROOT" --deployment-id "\${CAT_CAFE_DEPLOYMENT_ID:-worktree}"
  TOKEN="$(node -e "console.log(require('node:crypto').randomUUID())")"
  RESTART_ARGS=()
  for a in "\${ORIG_ARGS[@]}"; do
    case "$a" in
      --daemon|-d) ;;
      *) RESTART_ARGS+=("$a") ;;
    esac
  done
  launch_daemon_child "$0" "$TOKEN" "\${RESTART_ARGS[@]}"
  disown "$DAEMON_PID" 2>/dev/null || true
  if ! node "$SCRIPT_DIR/daemon-state.mjs" write --home "$HOME" --project-root "$PROJECT_ROOT" --deployment-id "\${CAT_CAFE_DEPLOYMENT_ID:-worktree}" --pid "$DAEMON_PID" --launch-token "$TOKEN" --log-file "$DAEMON_LOG_FILE" --frontend-port "\${FRONTEND_PORT:-3011}" --api-port "\${API_SERVER_PORT:-3012}" --redis-port "\${REDIS_PORT:-6397}" --preview-port "\${PREVIEW_GATEWAY_PORT:-4111}" >/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    exit 1
  fi
  exit 0
fi
node -e "const http=require('node:http');const s=http.createServer((_,r)=>r.end('ok'));s.listen(Number(process.env.API_SERVER_PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));" &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; exit 0' TERM INT
wait "$SERVER_PID"
`,
    { mode: 0o755 },
  );

  execFileSync('git', ['add', '.'], { cwd: mainDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: mainDir, stdio: 'ignore' });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: mainDir, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: mainDir, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', alphaDir, '-b', 'alpha/main-sync', 'origin/main'], {
    cwd: mainDir,
    stdio: 'ignore',
  });

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: alphaDir, encoding: 'utf8' }).trim();
  for (const dir of [
    'node_modules/.pnpm',
    'packages/web/node_modules/next',
    'packages/api/node_modules/tsx',
    'packages/mcp-server/node_modules/typescript',
    '.cat-cafe/redis',
  ])
    mkdirSync(join(alphaDir, dir), { recursive: true });
  writeFileSync(join(alphaDir, 'packages/web/node_modules/next/package.json'), '{}\n');
  writeFileSync(join(alphaDir, 'packages/api/node_modules/tsx/package.json'), '{}\n');
  writeFileSync(join(alphaDir, 'packages/mcp-server/node_modules/typescript/package.json'), '{}\n');
  writeFileSync(join(alphaDir, '.cat-cafe/redis/dump.rdb'), 'REDIS0012');
  for (const pkg of ['shared', 'api', 'mcp-server']) {
    mkdirSync(join(alphaDir, `packages/${pkg}/dist`), { recursive: true });
    writeFileSync(join(alphaDir, `packages/${pkg}/dist/index.js`), 'export {};\n');
    writeFileSync(join(alphaDir, `packages/${pkg}/dist/.build-commit`), `${head}\n`);
  }

  const previewId = previewProcessRecordId(mainDir, 3011);
  const completionPath = join(stateDir, `${previewId}.8d8b705b-c972-4c84-9c23-6e2f9a966aab.completion.json`);
  const completionBytes = `${JSON.stringify({
    version: 2,
    pid: 900000999,
    expiresAt: '2026-11-08T11:30:15.897Z',
    exitCode: 128,
    commandExitCode: 128,
    runnerExitCode: 128,
    cleanupExitCode: null,
    forced: false,
    cleanupOwnerStatus: 'unclaimed',
    completedAt: '2026-11-08T03:31:45.662Z',
  })}\n`;
  writeFileSync(
    join(stateDir, `${previewId}.json`),
    `${JSON.stringify({
      version: 1,
      id: previewId,
      cwd: mainDir,
      port: 3011,
      command: ['pnpm', 'alpha:start', '--', '--no-quick'],
      origin: 'detached',
      pid: 900000999,
      processStartedAt: 'Sun Nov  8 03:30:15 2026',
      processCommand: 'dead-supervisor',
      startedAt: '2026-11-08T03:30:15.931Z',
      expiresAt: '2026-11-08T11:30:15.897Z',
      completionPath,
      logPath: join(stateDir, `${previewId}.log`),
    })}\n`,
  );
  writeFileSync(completionPath, completionBytes);
  const historicalPredecessorPath = join(stateDir, '406ff05731d624d5.json');
  const historicalPredecessorBytes = `${JSON.stringify({
    version: 1,
    id: '406ff05731d624d5',
    cwd: join(root, 'cat-cafe-f290-historical'),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: 'detached',
    pid: 900000998,
    processStartedAt: 'Tue Aug 25 08:39:44 2026',
    processCommand: '/usr/bin/env node /opt/homebrew/bin/pnpm alpha:start',
    startedAt: '2026-08-25T15:39:44.886Z',
    logPath: join(stateDir, '406ff05731d624d5.log'),
  })}\n`;
  writeFileSync(historicalPredecessorPath, historicalPredecessorBytes);

  const guardSh = readFileSync(join(REPO_ROOT, 'scripts/lib/node-runtime-guard.sh'), 'utf8');
  const maxMajorMatch = guardSh.match(
    /CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE="\$\{CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE:-(\d+)\}"/,
  );
  if (!maxMajorMatch) throw new Error('Could not locate CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE in node-runtime-guard.sh');
  const unsupportedMajor = maxMajorMatch[1];
  const unsupportedNodeVersion = `${unsupportedMajor}.0.0`;
  const barrierMarkerPath = join(root, '.daemon-json-barrier-met');

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'node'),
    `#!/bin/bash
if [ "\${CAT_CAFE_NODE_RUNTIME_GUARD_REEXEC:-0}" != "1" ] && [ "\${1:-}" = "-p" ]; then
  parent_cmd="$(ps -ww -p "$PPID" -o command= 2>/dev/null || true)"
  case "$parent_cmd" in
    *--cat-cafe-daemon-token=*)
      for _ in $(seq 1 200); do
        if compgen -G "$HOME/.cat-cafe/daemons/alpha-*/daemon.json" >/dev/null; then
          : > "${barrierMarkerPath}"
          break
        fi
        sleep 0.01
      done
      case "\${2:-}" in
        *split*) printf '${unsupportedMajor}\\n' ;;
        *) printf '${unsupportedNodeVersion}\\n' ;;
      esac
      exit 0
      ;;
  esac
fi
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binDir, 'brew'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'redis-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(
    join(binDir, 'lsof'),
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *:${apiPort}) exec /usr/sbin/lsof "$@" ;;
    *:3011|*:3012|*:4111|*:5211|*:${previewGatewayPort}|*:${servicePort}) exit 1 ;;
  esac
done
exec /usr/sbin/lsof "$@"
`,
    { mode: 0o755 },
  );

  return {
    root,
    mainDir,
    alphaDir,
    stateDir,
    binDir,
    apiPort,
    previewGatewayPort,
    servicePort,
    redisPort,
    previewId,
    completionPath,
    completionBytes,
    historicalPredecessorPath,
    historicalPredecessorBytes,
    virtualPort3011PreloadUrl,
    unsupportedNodeVersion,
    barrierMarkerPath,
  };
}
