import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareIntranetDeployment } from './lib/intranet-deployment.mjs';
import { parseDeploymentEnv, validateDeploymentTemplate } from './lib/intranet-deployment-env.mjs';

function fixture(text = '') {
  const root = mkdtempSync(join(tmpdir(), 'intranet-prepare-'));
  for (const dir of ['scripts', 'packages/api', 'home']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'scripts/start-entry.mjs'), '// layout fixture');
  writeFileSync(join(root, 'packages/api/package.json'), '{}');
  if (text) writeFileSync(join(root, '.env'), text);
  const events = new Set();
  let appends = 0;
  const options = {
    hostRoot: root,
    homeDir: join(root, 'home'),
    env: {},
    probeAudit: async ({ preparationId }) => {
      if (!events.has(preparationId)) {
        events.add(preparationId);
        appends++;
      }
    },
  };
  return {
    root,
    options,
    env: () => readFileSync(join(root, '.env'), 'utf8'),
    record: () => JSON.parse(readFileSync(join(root, '.cat-cafe/deployment-preparation.json'), 'utf8')),
    appends: () => appends,
  };
}

test('new explicit source preparation persists modes once, preserves unrelated configuration and is idempotent', async () => {
  const f = fixture('# keep\r\nAPI_SERVER_PORT=4512\r\nTOKEN=fixture-secret\r\n');
  const prepared = await prepareIntranetDeployment(f.options);
  assert.equal(prepared.status, 'ready');
  assert.ok(f.env().startsWith('# keep\r\nAPI_SERVER_PORT=4512\r\nTOKEN=fixture-secret\r\n'));
  const env = parseDeploymentEnv(f.env());
  assert.equal(env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE, 'trusted-host');
  assert.equal(env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE, 'warn-bootstrap-root');
  const before = f.env();
  assert.equal((await prepareIntranetDeployment(f.options)).idempotent, true);
  assert.equal(f.env(), before);
  assert.equal(f.appends(), 1);
  assert.doesNotMatch(JSON.stringify(f.record()), /fixture-secret/);
});

test('existing explicit strict/required and audit location win; legacy exact-1 is migrated independently', async () => {
  for (const text of [
    'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=strict\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=required\n',
    'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY=1\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=required\n',
  ]) {
    const f = fixture(text);
    const audit = join(f.root, 'original-audit');
    writeFileSync(join(f.root, '.env'), `${text}AUDIT_LOG_DIR="${audit.replaceAll('\\', '/')}"\n`);
    const result = await prepareIntranetDeployment(f.options);
    assert.equal(result.auditDir, audit);
    assert.equal(result.audit, 'required');
    assert.equal(result.bootstrap, text.includes('MODE=strict') ? 'strict' : 'trusted-host');
    assert.equal(parseDeploymentEnv(f.env()).AUDIT_LOG_DIR, audit.replaceAll('\\', '/'));
  }
});

test('failure and concurrent edits preserve the current .env, retry keeps its preparation ID', async () => {
  const f = fixture('API_SERVER_PORT=4512\n');
  const original = f.env();
  await assert.rejects(
    prepareIntranetDeployment({
      ...f.options,
      probeAudit: async () => {
        throw Error('EPERM');
      },
    }),
    /EPERM/,
  );
  assert.equal(f.env(), original);
  const id = f.record().preparationId;
  await prepareIntranetDeployment(f.options);
  assert.equal(f.record().preparationId, id);
  const concurrent = fixture('API_SERVER_PORT=4512\n');
  await assert.rejects(
    prepareIntranetDeployment({
      ...concurrent.options,
      probeAudit: async () => writeFileSync(join(concurrent.root, '.env'), 'API_SERVER_PORT=4513\n'),
    }),
    /changed during preparation/,
  );
  assert.equal(concurrent.env(), 'API_SERVER_PORT=4513\n');
});

test('uncertain outcome after env commit is confirmed without adding a second readiness event', async () => {
  const f = fixture();
  await assert.rejects(
    prepareIntranetDeployment({
      ...f.options,
      afterEnvCommit: () => {
        throw Error('simulated interrupted acknowledgment');
      },
    }),
  );
  assert.equal(f.record().stage, 'audited');
  assert.equal((await prepareIntranetDeployment(f.options)).idempotent, true);
  assert.equal(f.record().stage, 'committed');
  assert.equal(f.appends(), 1);
});

test('invalid existing values and symlink targets refuse preparation without overwriting', async (t) => {
  const f = fixture('CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=\n');
  await assert.rejects(prepareIntranetDeployment(f.options), /must be strict or trusted-host/);
  assert.equal(f.env(), 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=\n');
  const linked = fixture();
  const outside = join(linked.root, 'retained-original');
  writeFileSync(outside, 'protected');
  try {
    symlinkSync(outside, join(linked.root, '.env'));
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symlink creation unavailable');
    throw error;
  }
  await assert.rejects(prepareIntranetDeployment(linked.options), /Reparse\/symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'protected');
});

test('explicit audit retarget changes one managed key and retains other duplicate source keys', async () => {
  const f = fixture('UNRELATED=first\nUNRELATED=second\nAUDIT_LOG_DIR=original-audit\n');
  const auditDir = join(f.root, 'explicit-new-audit');
  await prepareIntranetDeployment({ ...f.options, auditDir });
  assert.equal((f.env().match(/^AUDIT_LOG_DIR=/gm) ?? []).length, 1);
  assert.equal(parseDeploymentEnv(f.env()).AUDIT_LOG_DIR, auditDir.replaceAll('\\', '/'));
  assert.ok(f.env().startsWith('UNRELATED=first\nUNRELATED=second\n'));
});

test('intranet template is an exact two-key data contract, never an arbitrary shell file', () => {
  const valid =
    'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host\nCAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=warn-bootstrap-root\n';
  assert.equal(Object.keys(validateDeploymentTemplate(valid)).length, 2);
  for (const extra of ['TOKEN=bad\n', 'export TOKEN=bad\n', '$(unexpected-command)\n'])
    assert.throws(() => validateDeploymentTemplate(valid + extra));
});

test('the real EventAuditLog readiness event is appended once and read back on retry', async () => {
  const f = fixture();
  const options = { ...f.options, probeAudit: undefined };
  const result = await prepareIntranetDeployment(options);
  assert.equal((await prepareIntranetDeployment(options)).preparationId, result.preparationId);
  const { EventAuditLog } = await import('../packages/api/dist/domains/cats/services/orchestration/EventAuditLog.js');
  const events = await new EventAuditLog({ auditDir: result.auditDir }).readByDate(new Date());
  assert.deepEqual(
    events.map((event) => event.type),
    ['host.deployment.audit-readiness'],
  );
  assert.equal(events[0].data.preparationId, result.preparationId);
});

test('readiness recovery searches actual local-date shards even after several days', async (t) => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 22, 17) });
  try {
    const f = fixture();
    const options = { ...f.options, probeAudit: undefined };
    await assert.rejects(
      prepareIntranetDeployment({
        ...options,
        beforeCommit: () => {
          throw Error('interrupted');
        },
      }),
      /interrupted/,
    );
    const id = f.record().preparationId;
    t.mock.timers.setTime(Date.UTC(2026, 9, 27, 17));
    const result = await prepareIntranetDeployment(options);
    assert.equal(result.preparationId, id);
    const { EventAuditLog } = await import('../packages/api/dist/domains/cats/services/orchestration/EventAuditLog.js');
    const log = new EventAuditLog({ auditDir: result.auditDir });
    const all = (await Promise.all((await log.listFiles()).map((file) => log.readByDate(file.slice(6, -7))))).flat();
    assert.equal(all.filter((event) => event.data.preparationId === id).length, 1);
  } finally {
    t.mock.timers.reset();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test('export assignments for managed settings are refused without weakening existing policy', async () => {
  for (const key of [
    'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
    'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
    'AUDIT_LOG_DIR',
  ]) {
    const text = `export ${key}=${key === 'AUDIT_LOG_DIR' ? './original-audit' : key.endsWith('AUDIT_MODE') ? 'required' : 'strict'}\n`;
    const f = fixture(text);
    await assert.rejects(prepareIntranetDeployment(f.options), /Unsupported deployment assignment/);
    assert.equal(f.env(), text);
  }
});

test('a short audit append before preparationId is unconfirmed and cannot be concatenated on retry', async () => {
  const f = fixture();
  const options = { ...f.options, probeAudit: undefined };
  const { EventAuditLog } = await import('../packages/api/dist/domains/cats/services/orchestration/EventAuditLog.js');
  let path;
  let partial;
  await assert.rejects(
    prepareIntranetDeployment({
      ...options,
      beforeCommit: () => {
        path = new EventAuditLog({ auditDir: f.record().auditDir }).getLogPath();
        const text = readFileSync(path, 'utf8');
        partial = text.slice(0, text.indexOf('"preparationId"'));
        writeFileSync(path, partial);
        throw Error('interrupted short append');
      },
    }),
    /interrupted short append/,
  );
  await assert.rejects(prepareIntranetDeployment(options), /unterminated trailing record/);
  assert.equal(readFileSync(path, 'utf8'), partial);
  assert.equal(existsSync(join(f.root, '.env')), false);
});
