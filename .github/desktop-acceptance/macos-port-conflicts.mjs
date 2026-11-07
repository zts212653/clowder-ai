import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { collectChecks } from './checks.mjs';

const [executable, evidence, debug] = process.argv.slice(2);
const api = process.env.API_SERVER_PORT;
const web = process.env.FRONTEND_PORT;
const ports = [api, web, process.env.REDIS_PORT, debug];
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
    const servers = [];
    let app;
    try {
      for (const [, port] of claims) {
        const server = net.createServer((socket) => socket.destroy());
        servers.push(server);
        server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true });
        await once(server, 'listening');
      }
      const log = fs.openSync(path.join(evidence, `mac-port-${scenario}.log`), 'w');
      try {
        app = spawn(executable, [`--remote-debugging-port=${debug}`, '--remote-debugging-address=127.0.0.1'], {
          env,
          stdio: ['ignore', log, log],
        });
      } finally {
        fs.closeSync(log);
      }
      await once(app, 'spawn');
      const startup = await waitFor(() => {
        const file = path.join(state, 'data/logs/startup-state.json');
        if (!fs.existsSync(file)) return;
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (['failed', 'ready'].includes(entry.phase)) return entry;
      }, 45_000);
      const owners = Object.fromEntries(claims.map(([service, port]) => [service, listener(port)]));
      const pages =
        listener(debug) === String(app.pid)
          ? (await (await fetch(`http://127.0.0.1:${debug}/json/list`, { signal: AbortSignal.timeout(5000) })).json())
              .filter(({ type }) => type === 'page')
              .map(({ url }) => url)
          : [];
      fs.writeFileSync(
        path.join(evidence, `mac-port-${scenario}.json`),
        JSON.stringify({ startup, claims, owners, fixturePid: process.pid, candidatePid: app.pid, pages }, null, 2),
      );
      assert.equal(startup?.pid, app.pid, 'No terminal startup state from the candidate');
      assert.equal(startup.phase, 'failed', 'Candidate did not reject the conflict');
      assert.ok(claims.every(([service, port]) => startup.message.includes(`${service} ${port}`)));
      assert.ok(
        Object.values(owners).every((pid) => pid === String(process.pid)),
        'Original listener changed',
      );
      assert.ok(pages.length && pages.every((url) => !/^https?:\/\//.test(url)), 'Unexpected Electron renderer');
    } finally {
      if (app?.pid) {
        const exited = () => app.exitCode !== null || app.signalCode !== null;
        if (!exited()) {
          await quit(executable, ['--quit-owned-installation'], { env, timeout: 15_000 }).catch(() => {});
          if (!(await waitFor(exited, 15_000))) app.kill('SIGTERM');
        }
        clean = (await waitFor(exited, 5000)) === true;
        if (!clean) app.unref();
      }
      await Promise.all(
        servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
      );
      clean &&= !ports.some(listener);
    }
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
