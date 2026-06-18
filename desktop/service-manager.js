// ServiceManager — spawns and monitors Redis, API, and Web processes.
// Used by the Electron main process to manage backend services.

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 120_000;
const REDIS_FALLBACK_PORT_CHECK_MS = 5_000;

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';
// process.arch: 'arm64' | 'x64' — matches electron-builder ${arch} substitution,
// so extraResources like bundled/redis-darwin-${arch} map directly to these dirs.
const ARCH_SEG = process.arch === 'arm64' ? 'arm64' : 'x64';

// Resolve the per-user writable data root. Extracted to module level so
// LOG_FILE can be set before ServiceManager is instantiated.
function resolveUserDataDir() {
  if (IS_MAC) {
    const home = process.env.HOME || os.homedir();
    return path.join(home, 'Library', 'Application Support', 'Clowder AI');
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(localAppData, 'Clowder AI');
}

// Desktop log alongside API logs in the user data directory.
// Prior location (os.tmpdir()) was hard to find for debugging.
const USER_DATA_DIR = resolveUserDataDir();
const LOG_DIR_DESKTOP = path.join(USER_DATA_DIR, 'data', 'logs');
try {
  fs.mkdirSync(LOG_DIR_DESKTOP, { recursive: true });
} catch {}
const LOG_FILE = path.join(LOG_DIR_DESKTOP, 'desktop.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// Resolve node executable: prefer installer-bundled node, then system node,
// then Electron's own node. A bundled node guarantees clean installs (no
// pre-existing Node.js) still work on both Windows and macOS.
function resolveNode(projectRoot) {
  if (projectRoot) {
    // Windows layout (Inno Setup): {root}/node/node.exe
    // macOS layout (electron-builder extraResources): {root}/node/bin/node
    const candidates = IS_WIN
      ? [path.join(projectRoot, 'node', 'node.exe')]
      : [path.join(projectRoot, 'node', 'bin', 'node')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  try {
    const lookupCmd = IS_WIN ? 'where node' : 'which node';
    const result = execSync(lookupCmd, { timeout: 5000, encoding: 'utf-8' }).trim();
    const first = result.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}
  const systemCandidates = IS_WIN
    ? [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'node', 'node.exe'),
      ]
    : [
        '/opt/homebrew/bin/node', // Apple Silicon Homebrew
        '/usr/local/bin/node', // Intel Homebrew / manual install
        '/usr/bin/node',
      ];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return null; // Signal that Node.js is not available
}

class ServiceManager {
  constructor(projectRoot, { frontendPort, apiPort, onStatus }) {
    this.root = projectRoot;
    this.frontendPort = frontendPort;
    this.apiPort = apiPort;
    this.onStatus = onStatus || (() => {});
    this.procs = {};
    this.memoryMode = false;
  }

  async startAll() {
    log(`=== ServiceManager.startAll() ===`);
    log(`projectRoot: ${this.root}`);

    // ---- Pre-flight checks ----
    const nodeExe = resolveNode(this.root);
    if (!nodeExe) {
      throw new Error('Node.js not found. Please install Node.js >= 20 from https://nodejs.org/');
    }
    log(`Node.js found: ${nodeExe}`);

    const apiEntry = path.join(this.root, 'packages', 'api', 'dist', 'index.js');
    if (!fs.existsSync(apiEntry)) {
      throw new Error(`API entry missing: ${apiEntry}. The installer may be corrupted.`);
    }
    log(`API entry exists: ${apiEntry}`);

    // pnpm deploy --node-linker=hoisted puts deps under packages/{api,web}/node_modules.
    // There is intentionally no root-level node_modules in the installed layout.
    const apiNmDir = path.join(this.root, 'packages', 'api', 'node_modules');
    if (!fs.existsSync(apiNmDir)) {
      throw new Error(`API node_modules missing at ${apiNmDir}. The installer may be corrupted.`);
    }
    log(`API node_modules exists: ${apiNmDir}`);

    // ---- User data directory (writable, outside Program Files) ----
    const userDataDir = this._getUserDataDir();
    this._ensureUserDataDir(userDataDir);
    log(`User data dir: ${userDataDir}`);

    // NOTE: workspace junction repair must happen at install time (admin).
    // Runtime repair in Program Files fails with EPERM for non-admin users.

    // ---- Redis ----
    this.onStatus('Starting Redis...');
    await this._startRedis(userDataDir);
    log(`Redis phase complete. memoryMode=${this.memoryMode}`);

    // ---- API ----
    this.onStatus('Starting API server...');
    let apiReady = false;
    try {
      await this._startApi(nodeExe, userDataDir);
      apiReady = true;
    } catch (err) {
      log(`API first-attempt failed: ${err.message}`);
      // If API failed and we haven't tried memory mode yet, retry with MEMORY_STORE=1
      if (!this.memoryMode) {
        this.onStatus('API failed — retrying with memory store...');
        log('Retrying API with MEMORY_STORE=1');
        this.memoryMode = true;
        try {
          await this._startApi(nodeExe, userDataDir);
          apiReady = true;
        } catch (err2) {
          log(`API retry also failed: ${err2.message}`);
          throw new Error(`API server failed to start:\n${err2.message}`);
        }
      } else {
        throw err;
      }
    }

    if (!apiReady) {
      throw new Error('API server did not start');
    }

    // ---- Web ----
    this.onStatus('Starting Web frontend...');
    this._startNextJs();
    log(`Web process spawned, waiting for port ${this.frontendPort}`);
    await this._waitForPort(this.frontendPort, 'Web');

    this.onStatus('Ready!');
  }

  _getUserDataDir() {
    return resolveUserDataDir();
  }

  _ensureUserDataDir(baseDir) {
    const dirs = [
      baseDir,
      path.join(baseDir, 'data', 'transcripts'),
      path.join(baseDir, 'data', 'logs', 'api'),
      path.join(baseDir, 'data', 'connector-media'),
      path.join(baseDir, 'uploads'),
      // Writable project root for the API. The install dir (Program Files) is
      // read-only for non-admin users, but the API writes many files under
      // {projectRoot}/.cat-cafe/ (cat-catalog.json, governance-registry.json,
      // packs/, tool-usage-archive.jsonl, accounts.json, credentials.json).
      // These paths are resolved from findMonorepoRoot(process.cwd()) and have
      // no per-path env overrides, so the API cwd must be a writable dir with
      // a pnpm-workspace.yaml marker.
      path.join(baseDir, 'data', 'redis'),
      path.join(baseDir, 'project'),
      path.join(baseDir, 'project', '.cat-cafe'),
    ];
    for (const d of dirs) {
      try {
        if (!fs.existsSync(d)) {
          fs.mkdirSync(d, { recursive: true });
        }
      } catch (err) {
        log(`Warning: failed to create directory ${d}: ${err.message}`);
      }
    }
    const projectDir = path.join(baseDir, 'project');
    const marker = path.join(projectDir, 'pnpm-workspace.yaml');
    if (!fs.existsSync(marker)) {
      try {
        fs.writeFileSync(marker, 'packages: []\n', 'utf-8');
      } catch (err) {
        log(`Warning: failed to plant workspace marker ${marker}: ${err.message}`);
      }
    }

    // Mirror read-only install-dir resources into the project dir via symlinks.
    // Without these, findMonorepoRoot(cwd) resolves to the project dir but
    // docs/cat-cafe-skills/packages are not under it — so API routes like
    // /api/docs, capabilities.ts skill listing, and MCP server spawning
    // (resolve(projectRoot, 'packages/mcp-server/dist/memory.js')) all fail.
    // Windows uses NTFS junctions (no admin needed, absolute paths). macOS
    // uses plain directory symlinks.
    const linkType = IS_WIN ? 'junction' : 'dir';
    const mirrors = ['.claude', 'assets', 'cat-cafe-skills', 'docs', 'guides', 'packages', 'plugins', 'scripts'];

    // Helper: remove a junction or symlink. On Windows, NTFS junctions are
    // directory reparse points — fs.unlinkSync calls DeleteFileW which fails
    // on directory entries (EPERM). fs.rmdirSync calls RemoveDirectoryW which
    // correctly removes junctions without recursing into the target.
    const removeLink = (linkPath) => {
      if (IS_WIN) {
        try {
          fs.rmdirSync(linkPath);
        } catch {
          fs.unlinkSync(linkPath); // fallback for true symlinks
        }
      } else {
        fs.unlinkSync(linkPath);
      }
    };

    for (const name of mirrors) {
      const src = path.join(this.root, name);
      const dst = path.join(projectDir, name);
      if (!fs.existsSync(src)) {
        log(`Skipping mirror ${name} — source missing at ${src}`);
        continue;
      }
      try {
        // lstatSync does NOT follow symlinks/junctions — it inspects the
        // link entry itself. existsSync follows the target, so a broken
        // junction (target path removed after reinstall) returns false
        // even though the junction entry still occupies the path, causing
        // symlinkSync to fail with EEXIST.
        let dstStat = null;
        try {
          dstStat = fs.lstatSync(dst);
        } catch {
          // Path doesn't exist at all — proceed to create
        }
        if (dstStat?.isSymbolicLink()) {
          // Verify junction/symlink target matches current install root.
          // After reinstall to a different path, stale junctions cause
          // UNKNOWN errors because the old target no longer exists.
          try {
            const target = fs.readlinkSync(dst);
            if (path.resolve(target) === path.resolve(src)) continue;
            removeLink(dst);
            log(`Removed stale ${linkType}: ${dst} (was -> ${target})`);
          } catch {
            try {
              removeLink(dst);
            } catch {
              // Ignore — symlinkSync below will report the real error
            }
          }
        } else if (dstStat?.isDirectory()) {
          // On Windows, lstatSync().isSymbolicLink() can return false for
          // NTFS junctions (IO_REPARSE_TAG_MOUNT_POINT ≠ SYMLINK tag),
          // making them appear as plain directories. Probe with readlinkSync
          // to detect hidden junctions; real directories throw EINVAL.
          if (IS_WIN) {
            try {
              const target = fs.readlinkSync(dst);
              // readlinkSync succeeded → it's a junction, not a real dir.
              if (path.resolve(target) === path.resolve(src)) continue;
              removeLink(dst);
              log(`Removed stale junction (was dir-flagged): ${dst} (was -> ${target})`);
            } catch {
              continue; // Genuine directory — don't replace
            }
          } else {
            continue; // Real directory on macOS — don't replace
          }
        }
        fs.symlinkSync(src, dst, linkType);
        log(`Mirror ${linkType} created: ${dst} -> ${src}`);
      } catch (err) {
        log(`Warning: failed to create ${linkType} ${dst}: ${err.message}`);
      }
    }

    // Verify critical junctions are traversable. On Windows, freshly-created
    // NTFS junctions occasionally return UNKNOWN errors from readFileSync
    // even though the link entry and target both exist (observed on first
    // launch after installer on clean machines). Removing and recreating
    // the junction resolves it — so retry once if the probe fails.
    const criticalProbes = [
      { mirror: 'cat-cafe-skills', probe: path.join('refs', 'shared-rules.md') },
      { mirror: 'plugins', probe: path.join('github', 'plugin.yaml') },
    ];
    for (const { mirror, probe } of criticalProbes) {
      const probePath = path.join(projectDir, mirror, probe);
      const src = path.join(this.root, mirror);
      const dst = path.join(projectDir, mirror);
      try {
        fs.readFileSync(probePath, 'utf-8');
      } catch (probeErr) {
        log(`Junction probe FAILED for ${probePath}: ${probeErr.message} — rebuilding`);
        try {
          removeLink(dst);
        } catch {
          /* best effort */
        }
        try {
          fs.symlinkSync(src, dst, linkType);
          // Second attempt — verify again
          fs.readFileSync(probePath, 'utf-8');
          log(`Junction rebuilt and verified: ${dst} -> ${src}`);
        } catch (retryErr) {
          log(`Junction rebuild ALSO FAILED: ${retryErr.message}`);
        }
      }
    }

    // scripts/ has no node_modules. compile-system-prompt-l0.mjs uses ESM
    // `import { catRegistry } from '@cat-cafe/shared'` — Node ESM ignores
    // NODE_PATH and only walks the filesystem node_modules chain.
    // Three creation paths (first one wins):
    //   1. macOS: afterPack.js bakes the symlink into the .app bundle
    //   2. Windows installer: Inno Setup [Run] creates junction (admin)
    //   3. Runtime (here): safety net for portable zip (writable dir) and
    //      dev builds. On installed Windows (Program Files) this silently
    //      fails with EPERM — fine, path 2 already created it.
    const scriptsNmSrc = path.join(this.root, 'packages', 'api', 'node_modules');
    const scriptsNmDst = path.join(this.root, 'scripts', 'node_modules');
    if (fs.existsSync(scriptsNmSrc) && !fs.existsSync(scriptsNmDst)) {
      try {
        if (IS_WIN) {
          fs.symlinkSync(scriptsNmSrc, scriptsNmDst, 'junction');
        } else {
          fs.symlinkSync(path.relative(path.dirname(scriptsNmDst), scriptsNmSrc), scriptsNmDst);
        }
        log(`scripts/node_modules -> packages/api/node_modules (${IS_WIN ? 'junction' : 'symlink'})`);
      } catch (err) {
        // Expected to fail on installed Windows (Program Files is read-only).
        // Inno Setup already created the junction during install.
        log(`Warning: scripts/node_modules link: ${err.message}`);
      }
    }
  }

  _getOrCreateTelemetrySalt(userDataDir) {
    const saltFile = path.join(userDataDir, 'telemetry-salt.txt');
    try {
      if (fs.existsSync(saltFile)) {
        return fs.readFileSync(saltFile, 'utf-8').trim();
      }
    } catch {}
    const salt = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(saltFile, salt, 'utf-8');
    } catch (err) {
      log(`Warning: failed to persist telemetry salt: ${err.message}`);
    }
    return salt;
  }

  async _startApi(nodeExe, userDataDir) {
    const apiEntry = path.join(this.root, 'packages', 'api', 'dist', 'index.js');
    // Copy cat-template.json from install root to the writable project dir,
    // and point the API at that copy via CAT_TEMPLATE_PATH. Otherwise the
    // API's cat-config-loader derives projectRoot=dirname(templatePath) from
    // the install location and tries to bootstrap .cat-cafe/cat-catalog.json
    // inside Program Files → EPERM → fallback to placeholder model names.
    const userProjectDir = path.join(userDataDir, 'project');
    const templateSrc = path.join(this.root, 'cat-template.json');
    const templateDst = path.join(userProjectDir, 'cat-template.json');
    try {
      if (fs.existsSync(templateSrc)) {
        const srcStat = fs.statSync(templateSrc);
        const dstStat = fs.existsSync(templateDst) ? fs.statSync(templateDst) : null;
        if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
          fs.copyFileSync(templateSrc, templateDst);
          log(`cat-template.json copied to ${templateDst}`);
        }
      } else {
        log(`WARNING: cat-template.json missing at ${templateSrc}`);
      }
    } catch (err) {
      log(`Warning: failed to mirror cat-template.json: ${err.message}`);
    }

    const envOverrides = this._buildApiEnv(userDataDir);
    if (fs.existsSync(templateDst)) {
      envOverrides.CAT_TEMPLATE_PATH = templateDst;
    }
    // cwd must be a writable dir containing pnpm-workspace.yaml so that the
    // API's findMonorepoRoot() anchors on it, not on Program Files.
    this._startProcess('api', nodeExe, [apiEntry], { envOverrides, cwd: userProjectDir });
    log(`API process spawned, waiting for port ${this.apiPort}`);
    await this._waitForPort(this.apiPort, 'API');
  }

  _buildApiEnv(userDataDir) {
    const salt = this._getOrCreateTelemetrySalt(userDataDir);
    return {
      TELEMETRY_HMAC_SALT: salt,
      EVIDENCE_DB: path.join(userDataDir, 'evidence.sqlite'),
      TRANSCRIPT_DATA_DIR: path.join(userDataDir, 'data', 'transcripts'),
      LOG_DIR: path.join(userDataDir, 'data', 'logs', 'api'),
      UPLOAD_DIR: path.join(userDataDir, 'uploads'),
      CONNECTOR_MEDIA_DIR: path.join(userDataDir, 'data', 'connector-media'),
      TTS_CACHE_DIR: path.join(userDataDir, 'data', 'tts-cache'),
      AUDIT_LOG_DIR: path.join(userDataDir, 'data', 'audit-logs'),
      CLI_RAW_ARCHIVE_DIR: path.join(userDataDir, 'data', 'cli-raw-archive'),
    };
  }

  async _startRedis(userDataDir) {
    // Windows:   .cat-cafe/redis/windows/redis-server.exe
    // macOS:     .cat-cafe/redis/darwin-{arm64|x64}/redis-server
    // Platform+arch segment matches what build-mac.sh / Inno Setup place on disk.
    const platformSeg = IS_WIN ? 'windows' : `darwin-${ARCH_SEG}`;
    const redisDir = path.join(this.root, '.cat-cafe', 'redis', platformSeg);
    const portableRedis = path.join(redisDir, `redis-server${EXE_SUFFIX}`);

    // Already running — verify it is actually Redis
    if (await this._isPortOpen(6399)) {
      const isRedis = await this._verifyRedisPing(6399);
      if (isRedis) {
        this.onStatus('Redis already running on 6399');
        return;
      }
      log('Port 6399 occupied by non-Redis — using memory store');
      this.memoryMode = true;
      return;
    }

    const hasPortable = fs.existsSync(portableRedis);
    const hasSystem = await this._commandExists('redis-server');

    if (!hasPortable && !hasSystem) {
      log('Redis not found — using memory store');
      this.memoryMode = true;
      return;
    }

    // Persist data to writable user directory so sessions survive app restart.
    const redisDataDir = path.join(userDataDir, 'data', 'redis');
    let redisCmd = 'redis-server';
    // Cap maxclients to a conservative desktop value so Redis does not emit a
    // scary "Server can't set maximum open files" warning on low-ulimit systems
    // (e.g. packaged Windows installs where the default 10000 exceeds the
    // process file descriptor limit).  512 is far above local desktop needs.
    const redisArgs = [
      '--port',
      '6399',
      '--dir',
      redisDataDir,
      '--save',
      '60 1',
      '--appendonly',
      'yes',
      '--maxclients',
      '512',
    ];
    let redisCwd = this.root;

    if (hasPortable) {
      redisCmd = portableRedis;
      redisCwd = redisDir;
      const canRun = this._testRedisBinary(portableRedis, redisDir);
      if (!canRun) {
        log('Redis binary test failed — using memory store');
        this.memoryMode = true;
        return;
      }
    }

    this._startProcess('redis', redisCmd, redisArgs, { cwd: redisCwd });
    const redisReady = await this._waitForPortWithFallback(6399, 'Redis', 'redis');
    if (!redisReady) {
      log('Redis failed to start — using memory store');
      this.memoryMode = true;
      if (this.procs.redis && !this.procs.redis.killed) {
        try {
          this.procs.redis.kill();
        } catch {}
      }
      delete this.procs.redis;
    }
  }

  _testRedisBinary(exe, cwd) {
    try {
      // spawnSync handles quoting correctly on both platforms without shell
      const r = require('node:child_process').spawnSync(exe, ['--version'], {
        cwd,
        timeout: 3000,
        windowsHide: true,
        stdio: 'ignore',
      });
      return r.status === 0;
    } catch (err) {
      log(`Redis binary test error: ${err.message}`);
      return false;
    }
  }

  _commandExists(cmd) {
    return new Promise((resolve) => {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const p = spawn(which, [cmd], { stdio: 'ignore', windowsHide: true });
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
  }

  _startNextJs() {
    const webDir = path.join(this.root, 'packages', 'web');
    const nodeExe = resolveNode(this.root) || 'node';

    let nextJs = null;
    // Primary: deployed layout (pnpm deploy --node-linker=hoisted) places next
    // directly under packages/web/node_modules/next.
    const deployed = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (fs.existsSync(deployed)) nextJs = deployed;
    // Dev fallback: pnpm store layout in root.
    if (!nextJs) {
      const pnpmDir = path.join(this.root, 'node_modules', '.pnpm');
      if (fs.existsSync(pnpmDir)) {
        try {
          const dirs = fs.readdirSync(pnpmDir).filter((d) => d.startsWith('next@'));
          for (const d of dirs) {
            const candidate = path.join(pnpmDir, d, 'node_modules', 'next', 'dist', 'bin', 'next');
            if (fs.existsSync(candidate)) {
              nextJs = candidate;
              break;
            }
          }
        } catch {}
      }
    }
    if (!nextJs) {
      const hoisted = path.join(this.root, 'node_modules', 'next', 'dist', 'bin', 'next');
      if (fs.existsSync(hoisted)) nextJs = hoisted;
    }

    let cmd, args;
    if (nextJs) {
      cmd = nodeExe;
      args = [nextJs, 'start', '--port', String(this.frontendPort)];
    } else if (IS_WIN) {
      cmd = 'cmd.exe';
      const localNext = path.join(webDir, 'node_modules', '.bin', 'next.cmd');
      args = ['/c', fs.existsSync(localNext) ? localNext : 'next.cmd', 'start', '--port', String(this.frontendPort)];
    } else {
      // macOS/Linux fallback: spawn node against any next binary on PATH.
      // In practice 'deployed' above is always found after pnpm deploy, so
      // this branch only triggers during broken installs.
      cmd = nodeExe;
      args = ['-e', 'console.error("next entry not found — reinstall required"); process.exit(1)'];
    }

    log(`Starting Next.js: ${cmd} ${args.join(' ')}`);
    this._startProcess('web', cmd, args, { cwd: webDir });
  }

  _startProcess(name, cmd, args, opts = {}) {
    const env = {
      ...process.env,
      API_SERVER_PORT: String(this.apiPort),
      FRONTEND_PORT: String(this.frontendPort),
      NEXT_PUBLIC_API_URL: `http://localhost:${this.apiPort}`,
      PROMPT_DEBUG: '1',
    };

    // macOS Electron apps launched from Finder/Dock inherit a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin) that excludes common CLI install dirs.
    // Augment PATH so CLI detection (command -v claude/codex/...) works.
    if (IS_MAC) {
      const home = os.homedir();
      const extraDirs = [
        '/opt/homebrew/bin', // Homebrew (Apple Silicon)
        '/usr/local/bin', // Homebrew (Intel) / npm global
        path.join(home, '.local', 'bin'), // pipx, cargo, etc.
        '/opt/homebrew/sbin',
        '/usr/local/sbin',
      ];
      const currentPath = env.PATH || '';
      const missing = extraDirs.filter((d) => !currentPath.includes(d));
      if (missing.length > 0) {
        env.PATH = `${currentPath}:${missing.join(':')}`;
      }
    }

    // In packaged desktop mode, scripts/ has no node_modules. Workspace
    // packages like @cat-cafe/shared are only available in the pnpm-deployed
    // packages/api/node_modules. Set NODE_PATH so subprocess scripts
    // (e.g. compile-system-prompt-l0.mjs) can resolve workspace imports.
    const apiNodeModules = path.join(this.root, 'packages', 'api', 'node_modules');
    if (fs.existsSync(apiNodeModules)) {
      const existing = env.NODE_PATH || '';
      if (!existing.includes(apiNodeModules)) {
        env.NODE_PATH = existing ? `${existing}${path.delimiter}${apiNodeModules}` : apiNodeModules;
      }
    }

    if (this.memoryMode) {
      env.MEMORY_STORE = '1';
      delete env.REDIS_URL;
    } else {
      env.REDIS_URL = 'redis://localhost:6399';
    }

    // Apply API-specific env overrides (writable paths, telemetry salt, etc.)
    if (opts.envOverrides) {
      Object.assign(env, opts.envOverrides);
    }

    log(`[${name}] spawn: ${cmd} ${args.join(' ')}`);
    log(`[${name}] cwd: ${opts.cwd || this.root}`);
    log(`[${name}] env: MEMORY_STORE=${env.MEMORY_STORE || 'unset'}, REDIS_URL=${env.REDIS_URL || 'unset'}`);
    log(`[${name}] env: EVIDENCE_DB=${env.EVIDENCE_DB || 'unset'}, LOG_DIR=${env.LOG_DIR || 'unset'}`);

    const proc = spawn(cmd, args, {
      cwd: opts.cwd || this.root,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });

    proc.on('error', (err) => {
      log(`[${name}] spawn error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      log(`[${name}] exited: code=${code} signal=${signal}`);
    });

    proc.stdout?.on('data', (d) => log(`[${name}] ${d.toString().trim()}`));
    proc.stderr?.on('data', (d) => log(`[${name}] ERR: ${d.toString().trim()}`.slice(0, 500)));

    this.procs[name] = proc;
  }

  _isPortOpen(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(300);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
      sock.connect(port, '127.0.0.1');
    });
  }

  _verifyRedisPing(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      let buffer = '';
      sock.once('connect', () => {
        sock.write('PING\r\n');
      });
      sock.on('data', (data) => {
        buffer += data.toString();
        if (buffer.includes('+PONG')) {
          sock.destroy();
          resolve(true);
        }
      });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
      sock.connect(port, '127.0.0.1');
    });
  }

  async _waitForPort(port, label) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this._isPortOpen(port)) {
        this.onStatus(`${label} ready on port ${port}`);
        return;
      }
      // Check if the process died while we were waiting
      const procName = label.toLowerCase().includes('api') ? 'api' : label.toLowerCase().includes('web') ? 'web' : null;
      if (procName && this.procs[procName]) {
        const proc = this.procs[procName];
        if (proc.exitCode !== null && !proc.killed) {
          log(`[${label}] process exited unexpectedly (code=${proc.exitCode}) during wait`);
          throw new Error(
            `${label} process exited with code ${proc.exitCode} before port ${port} was ready. Check ${LOG_FILE} for details.`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`${label} did not start within ${MAX_WAIT_MS / 1000}s (port ${port})`);
  }

  async _waitForPortWithFallback(port, label, procName) {
    const deadline = Date.now() + MAX_WAIT_MS;
    const earlyCheckDeadline = Date.now() + REDIS_FALLBACK_PORT_CHECK_MS;
    while (Date.now() < deadline) {
      if (await this._isPortOpen(port)) {
        this.onStatus(`${label} ready on port ${port}`);
        return true;
      }
      if (Date.now() < earlyCheckDeadline) {
        const proc = this.procs[procName];
        if (proc && proc.exitCode !== null) {
          log(`[${label}] process exited early with code ${proc.exitCode}`);
          return false;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    log(`[${label}] timeout after ${MAX_WAIT_MS / 1000}s`);
    return false;
  }

  async stopAll() {
    const KILL_TIMEOUT_MS = 5000;
    const killPromises = [];

    for (const [name, proc] of Object.entries(this.procs)) {
      if (!proc || proc.killed) continue;
      // Skip children that already exited on their own — their PID may have
      // been reused by Windows, so taskkill could hit an unrelated process.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        log(`[desktop] ${name} already exited (code=${proc.exitCode}), skipping`);
        continue;
      }
      log(`[desktop] stopping ${name} (pid=${proc.pid})...`);

      killPromises.push(this._killProcessTree(name, proc, KILL_TIMEOUT_MS));
    }

    await Promise.allSettled(killPromises);
    this.procs = {};
  }

  async _killProcessTree(name, proc, timeoutMs) {
    if (!proc.pid) {
      log(`[${name}] no pid — skipping`);
      return;
    }

    if (IS_WIN) {
      // On Windows, proc.kill('SIGTERM') only kills the direct child process.
      // Child processes spawned by it (e.g., cmd.exe → node, or node → workers)
      // become orphans. Use taskkill /T (tree) /F (force) to kill the entire
      // process tree rooted at the PID.
      try {
        execSync(`taskkill /PID ${proc.pid} /T /F`, {
          timeout: timeoutMs,
          windowsHide: true,
          stdio: 'ignore',
        });
        log(`[${name}] process tree killed via taskkill`);
      } catch (err) {
        // taskkill exits non-zero if the process is already gone — that's fine
        log(`[${name}] taskkill: ${err.message}`);
      }
      return;
    }

    // macOS/Linux: SIGTERM first, then SIGKILL after timeout
    proc.kill('SIGTERM');

    const exited = await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    if (!exited) {
      log(`[${name}] did not exit after SIGTERM, sending SIGKILL`);
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
  }
}

module.exports = ServiceManager;
