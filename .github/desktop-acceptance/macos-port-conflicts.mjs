import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { collectChecks } from './checks.mjs';

const [executable, evidence] = process.argv.slice(2);
const api = process.env.API_SERVER_PORT;
const web = process.env.FRONTEND_PORT;
const ports = [api, web, process.env.REDIS_PORT];
assert.equal(process.platform, 'darwin');
assert.ok(ports.every((port) => /^\d{5}$/.test(port)) && new Set(ports).size === ports.length);
const scenarios = { api: { API: api }, web: { Web: web }, both: { API: api, Web: web } };
const quit = promisify(execFile);

function listener(port) {
  return spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
}

async function waitFor(read, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const value = read();
    if (value) return value;
    await delay(250);
  } while (Date.now() < deadline);
}

let clean = true;
const result = await collectChecks(
  Object.keys(scenarios),
  async (scenario) => {
    if (ports.some(listener)) return { status: 'not_run', reason: 'test-port-unavailable' };
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'port-preflight-'));
    const state = path.join(root, 'state');
    const env = { ...process.env, CAT_CAFE_DESKTOP_INSTANCE_ROOT: state, HOME: path.join(root, 'home'), TMPDIR: root };
    fs.mkdirSync(env.HOME);
    const claims = Object.entries(scenarios[scenario]);
    const requests = Object.fromEntries(claims.map(([service]) => [service, 0]));
    const servers = [];
    let app;
    let startup;
    let owners;
    let webListener;
    try {
      for (const [service, port] of claims) {
        const server = net.createServer((socket) => {
          socket.once('data', () => {
            requests[service] += 1;
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          });
          socket.setTimeout(1000, () => socket.destroy());
        });
        servers.push(server);
        server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true });
        await once(server, 'listening');
      }
      const log = fs.openSync(path.join(evidence, `mac-port-${scenario}.log`), 'w');
      try {
        app = spawn(executable, [], {
          env,
          stdio: ['ignore', log, log],
        });
      } finally {
        fs.closeSync(log);
      }
      await once(app, 'spawn');
      startup = await waitFor(() => {
        const file = path.join(state, 'data/logs/startup-state.json');
        if (!fs.existsSync(file)) return;
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (['failed', 'ready'].includes(entry.phase)) return entry;
      }, 45_000);
      owners = Object.fromEntries(claims.map(([service, port]) => [service, listener(port)]));
      webListener = listener(web);
    } finally {
      if (app?.pid) {
        const exited = () => app.exitCode !== null || app.signalCode !== null;
        if (!exited()) {
          const acknowledged = await quit(executable, ['--quit-owned-installation'], { env, timeout: 15_000 }).then(
            () => true,
            () => false,
          );
          if (!acknowledged || !(await waitFor(exited, 15_000))) app.kill('SIGTERM');
        }
        clean = (await waitFor(exited, 5000)) === true;
        if (!clean) app.unref();
      }
      await Promise.all(
        servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
      );
      clean &&= !ports.some(listener);
    }
    const logPath = path.join(state, 'data/logs/main.log');
    const lifecycle = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const splashCreated = lifecycle.includes('[lifecycle] splash-created');
    const mainWindowStarted =
      lifecycle.includes('creating main window') || lifecycle.includes('"phase":"services-ready"');
    fs.writeFileSync(path.join(evidence, `mac-port-${scenario}-main.log`), lifecycle);
    fs.writeFileSync(
      path.join(evidence, `mac-port-${scenario}.json`),
      JSON.stringify(
        {
          startup,
          claims,
          owners,
          fixturePid: process.pid,
          candidatePid: app.pid,
          requests,
          webListener,
          splashCreated,
          mainWindowStarted,
          exitCode: app.exitCode,
          signal: app.signalCode,
        },
        null,
        2,
      ),
    );
    assert.equal(startup?.pid, app.pid, 'No terminal startup state from the candidate');
    assert.equal(startup.phase, 'failed', 'Candidate did not reject the conflict');
    assert.ok(claims.every(([service, port]) => startup.message.includes(`${service} ${port}`)));
    assert.ok(
      Object.values(owners).every((pid) => pid === String(process.pid)),
      'Original listener changed',
    );
    assert.ok(splashCreated && !mainWindowStarted, 'Unexpected window lifecycle');
    assert.ok(requests.Web === undefined ? !webListener : requests.Web === 0, 'Unexpected Web activity');
  },
  { canContinue: () => clean },
);
const status = result.status === 'passed' ? 'passed' : result.errors.length ? 'failed' : 'blocked';
fs.writeFileSync(
  path.join(evidence, 'mac-port-conflicts.json'),
  JSON.stringify(
    {
      status,
      code:
        status === 'failed'
          ? 'macos-port-conflict-assertion'
          : status === 'blocked'
            ? 'test-port-unavailable'
            : undefined,
      cleanupConfirmed: clean,
      checks: result.checks,
      errors: result.errors.map(({ message }) => message),
    },
    null,
    2,
  ),
);
