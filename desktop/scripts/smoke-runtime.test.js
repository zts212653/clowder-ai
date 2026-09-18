/**
 * Unit tests for the pure helpers in desktop/scripts/smoke-runtime.js.
 *
 * The script itself starts the installed runtime; that part is exercised by the
 * install-smoke workflow. These cases cover the decisions it makes: which URLs
 * to probe, how an outcome becomes a verdict, and where the installed
 * ServiceManager lives.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const { buildProbeUrls, judgeProbes, resolveManagerPath } = require('./smoke-runtime');

describe('smoke-runtime: probe set', () => {
  it('probes the API first so a dead API fails fast', () => {
    const probes = buildProbeUrls({ frontendPort: 3003, apiPort: 3004 });

    assert.deepEqual(
      probes.map((probe) => probe.id),
      ['api-direct', 'api-through-web', 'web-ui'],
    );
  });

  it('targets the resolved ports', () => {
    const probes = buildProbeUrls({ frontendPort: 4104, apiPort: 4105 });
    const byId = Object.fromEntries(probes.map((probe) => [probe.id, probe.url]));

    assert.equal(byId['api-direct'], 'http://127.0.0.1:4105/api/health');
    assert.equal(byId['api-through-web'], 'http://127.0.0.1:4104/api/health');
    assert.equal(byId['web-ui'], 'http://127.0.0.1:4104/');
  });

  it('keeps the rewrite probe, which is what proves the manifest retarget', () => {
    const throughWeb = buildProbeUrls({ frontendPort: 3003, apiPort: 3004 }).find(
      (probe) => probe.id === 'api-through-web',
    );

    assert.ok(throughWeb, 'the /api-through-web probe must exist');
    assert.match(throughWeb.why, /manifest retarget/);
  });

  it('gives every probe a reason', () => {
    for (const probe of buildProbeUrls({ frontendPort: 1, apiPort: 2 })) {
      assert.ok(probe.why.length > 10, `${probe.id} needs a reason`);
    }
  });
});

describe('smoke-runtime: verdict', () => {
  it('passes when every probe answered', () => {
    const verdict = judgeProbes([
      { id: 'api-direct', ok: true },
      { id: 'api-through-web', ok: true },
      { id: 'web-ui', ok: true },
    ]);

    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.failures, []);
  });

  it('names the probes that failed, with their detail', () => {
    const verdict = judgeProbes([
      { id: 'api-direct', ok: true },
      { id: 'api-through-web', ok: false, detail: 'HTTP 404' },
      { id: 'web-ui', ok: false, detail: 'fetch failed' },
    ]);

    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.failures, [
      { id: 'api-through-web', detail: 'HTTP 404' },
      { id: 'web-ui', detail: 'fetch failed' },
    ]);
  });

  it('treats an empty probe set as passing', () => {
    assert.equal(judgeProbes([]).ok, true);
  });
});

describe('smoke-runtime: locating the installed shell', () => {
  it('looks under desktop-dist/resources/app by default', () => {
    const resolved = resolveManagerPath('/opt/Clowder AI');

    assert.equal(resolved, path.join('/opt/Clowder AI', 'desktop-dist', 'resources', 'app', 'service-manager.js'));
  });

  it('honours an explicit manager path', () => {
    assert.equal(resolveManagerPath('/ignored', '/tmp/custom/service-manager.js'), '/tmp/custom/service-manager.js');
  });
});
