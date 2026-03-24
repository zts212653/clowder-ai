// ServiceManager — spawns and monitors Redis, API, and Web processes.
// Used by the Electron main process to manage backend services.

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 60_000;

class ServiceManager {
  constructor(projectRoot, { frontendPort, apiPort, onStatus }) {
    this.root = projectRoot;
    this.frontendPort = frontendPort;
    this.apiPort = apiPort;
    this.onStatus = onStatus || (() => {});
    this.procs = {};
  }

  async startAll() {
    this.onStatus('Starting Redis...');
    await this._startRedis();

    this.onStatus('Starting API server...');
    this._startProcess('api', 'node', [
      path.join(this.root, 'packages', 'api', 'dist', 'index.js'),
    ]);
    await this._waitForPort(this.apiPort, 'API');

    this.onStatus('Starting Web frontend...');
    this._startNextJs();
    await this._waitForPort(this.frontendPort, 'Web');

    this.onStatus('Ready!');
  }

  async _startRedis() {
    const portableRedis = path.join(
      this.root, '.cat-cafe', 'redis', 'windows', 'redis-server.exe',
    );
    const redisConf = path.join(
      this.root, '.cat-cafe', 'redis', 'windows', 'redis.conf',
    );
    const fs = require('fs');

    let redisCmd = 'redis-server';
    let redisArgs = ['--port', '6399', '--save', '', '--appendonly', 'no'];

    if (fs.existsSync(portableRedis)) {
      redisCmd = portableRedis;
      if (fs.existsSync(redisConf)) {
        redisArgs = [redisConf, '--port', '6399'];
      }
    }

    if (await this._isPortOpen(6399)) {
      this.onStatus('Redis already running on 6399');
      return;
    }

    this._startProcess('redis', redisCmd, redisArgs);
    await this._waitForPort(6399, 'Redis');
  }

  _startNextJs() {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    this._startProcess('web', npxCmd, [
      'next', 'start', '--port', String(this.frontendPort),
    ], { cwd: path.join(this.root, 'packages', 'web') });
  }

  _startProcess(name, cmd, args, opts = {}) {
    const env = {
      ...process.env,
      REDIS_URL: 'redis://localhost:6399',
      API_SERVER_PORT: String(this.apiPort),
      FRONTEND_PORT: String(this.frontendPort),
      NEXT_PUBLIC_API_URL: `http://localhost:${this.apiPort}`,
    };

    const proc = spawn(cmd, args, {
      cwd: opts.cwd || this.root,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });

    proc.on('error', (err) => {
      console.error(`[${name}] spawn error:`, err.message);
    });

    proc.stdout?.on('data', (d) => console.log(`[${name}] ${d}`));
    proc.stderr?.on('data', (d) => console.error(`[${name}] ${d}`));

    this.procs[name] = proc;
  }

  _isPortOpen(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(300);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
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
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`${label} did not start within ${MAX_WAIT_MS / 1000}s (port ${port})`);
  }

  async stopAll() {
    for (const [name, proc] of Object.entries(this.procs)) {
      if (proc && !proc.killed) {
        console.log(`[desktop] stopping ${name}...`);
        proc.kill('SIGTERM');
      }
    }
    this.procs = {};
  }
}

module.exports = ServiceManager;
