import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AUDIT_KEY,
  appendDeploymentKeys,
  BOOTSTRAP_KEY,
  fingerprint,
  missingDeploymentModes,
  parseDeploymentEnv,
  validateDeploymentTemplate,
} from './intranet-deployment-env.mjs';
import { assertPlainPath, fileSnapshot, replaceDeploymentFile, sameSnapshot } from './intranet-deployment-files.mjs';
import {
  readProcessResourceLeaseMetadata,
  recoverStaleLease,
  removeOwnedLease,
  tryAcquireLeaseFile,
} from './process-resource-lease-lock.mjs';

async function auditProbe({ auditDir, preparationId }) {
  const { EventAuditLog } = await import(
    '../../packages/api/dist/domains/cats/services/orchestration/EventAuditLog.js'
  );
  const log = new EventAuditLog({ auditDir });
  const previous = [];
  // The writer uses local dates; uncertain retries can occur days later or in a
  // different timezone. Search actual shards rather than predicting their names.
  for (const file of await log.listFiles()) {
    const path = join(auditDir, file);
    assertPlainPath(path);
    const content = readFileSync(path, 'utf8');
    // A short write may stop before its ID. Never append onto an uncertain tail.
    if (content && !content.endsWith('\n'))
      throw Error('Audit log has an unterminated trailing record; readiness is unconfirmed, existing bytes retained');
    for (const line of content.split('\n').filter((line) => line.includes(preparationId))) {
      try {
        previous.push(JSON.parse(line));
      } catch {
        throw Error('A partial readiness record exists; audit outcome is unconfirmed, no duplicate was appended');
      }
    }
  }
  const matching = previous.filter(
    (event) => event.type === 'host.deployment.audit-readiness' && event.data.preparationId === preparationId,
  );
  if (matching.length > 1) throw Error('Readiness outcome is ambiguous; existing audit records were retained');
  if (!matching.length)
    await log.append({
      type: 'host.deployment.audit-readiness',
      data: { schemaVersion: 1, preparationId, action: 'prepare-intranet-host' },
    });
}
function absoluteAuditDir(value, apiCwd) {
  if (!value?.trim() || /[\u0000\r\n"'`$]/.test(value))
    throw Error('AUDIT_LOG_DIR must be a nonempty literal path without shell expansion');
  return isAbsolute(value) ? resolve(value) : resolve(apiCwd, value);
}
async function selectAuditDir(hostRoot, existing, options) {
  const apiCwd = join(hostRoot, 'packages/api');
  if (options.auditDir) return absoluteAuditDir(options.auditDir, apiCwd);
  if (Object.hasOwn(existing, 'AUDIT_LOG_DIR')) return absoluteAuditDir(existing.AUDIT_LOG_DIR, apiCwd);
  const implicit = join(apiCwd, 'data/audit-logs');
  try {
    lstatSync(implicit);
    return implicit;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { resolveCatCafeDataRoot } = await import('../../packages/api/dist/utils/cli-process-ownership.js');
  const raw = existing.CAT_CAFE_DATA_DIR;
  const dataDir = raw && !isAbsolute(raw) && !raw.startsWith('~') ? resolve(apiCwd, raw) : raw;
  return join(resolveCatCafeDataRoot(dataDir, options.homeDir ?? homedir()), 'audit-logs');
}

/** Explicit preparation only. Normal launchers never invoke this writer. */
export async function prepareIntranetDeployment(options) {
  if (!options.hostRoot || !isAbsolute(options.hostRoot))
    throw Error('--host-root must be an absolute source Host directory');
  const hostRoot = resolve(options.hostRoot);
  assertPlainPath(hostRoot);
  for (const entry of ['scripts/start-entry.mjs', 'packages/api/package.json'])
    if (!existsSync(join(hostRoot, entry))) throw Error(`Source Host layout is missing: ${entry}`);
  const template = validateDeploymentTemplate(
    readFileSync(new URL('../../.env.intranet.example', import.meta.url), 'utf8'),
  );
  const envPath = join(hostRoot, '.env');
  const recordPath = join(hostRoot, '.cat-cafe/deployment-preparation.json');
  assertPlainPath(envPath);
  assertPlainPath(recordPath);
  mkdirSync(join(hostRoot, '.cat-cafe'), { recursive: true });
  const lockPath = join(hostRoot, '.cat-cafe/.deployment-preparation.lock');
  assertPlainPath(lockPath);
  const lease = { holderPid: process.pid, leaseId: randomUUID(), cwd: hostRoot, startedAt: new Date().toISOString() };
  if (!(await tryAcquireLeaseFile(lockPath, lease))) {
    if (!(await readProcessResourceLeaseMetadata(lockPath)))
      throw Error('Deployment preparation lock is unconfirmed; retained without deletion');
    await recoverStaleLease(lockPath);
    if (!(await tryAcquireLeaseFile(lockPath, lease))) {
      const holder = await readProcessResourceLeaseMetadata(lockPath);
      throw Error(
        `Deployment preparation is busy (holder PID ${holder?.holderPid ?? 'unknown'}); retry after it finishes`,
      );
    }
  }
  let stage = 'read';
  let auditDir;
  let preparationId;
  let envCommitted = false;
  try {
    const before = fileSnapshot(envPath);
    const fileEnv = parseDeploymentEnv(before.text);
    const ambient = options.env ?? process.env;
    const relevant = [
      BOOTSTRAP_KEY,
      AUDIT_KEY,
      'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
      'AUDIT_LOG_DIR',
      'CAT_CAFE_DATA_DIR',
    ];
    const existing = {
      ...Object.fromEntries(relevant.filter((key) => ambient[key] !== undefined).map((key) => [key, ambient[key]])),
      ...fileEnv,
    };
    const modes = missingDeploymentModes(existing, template);
    // Persist an explicitly inherited mode too, without changing its effective value.
    for (const key of [BOOTSTRAP_KEY, AUDIT_KEY])
      if (!Object.hasOwn(fileEnv, key)) modes[key] = existing[key] ?? modes[key];
    auditDir = await selectAuditDir(hostRoot, existing, options);
    assertPlainPath(auditDir);
    const effective = { ...existing, ...modes };
    const managedFingerprint = fingerprint(
      JSON.stringify({ bootstrap: effective[BOOTSTRAP_KEY], audit: effective[AUDIT_KEY], auditDir }),
    );
    const stored = fileSnapshot(recordPath);
    let record = stored.identity ? JSON.parse(stored.text) : undefined;
    if (
      record &&
      (record.schemaVersion !== 1 ||
        !/^[a-f0-9-]{36}$/.test(record.preparationId) ||
        !['planned', 'audited', 'committed'].includes(record.stage))
    )
      throw Error('Invalid preparation record; no deployment configuration was changed');
    if (
      record?.managedFingerprint === managedFingerprint &&
      before.text.includes(`# Clowder intranet preparation: ${record.preparationId}`)
    ) {
      if (record.stage !== 'committed' && before.hash !== record.afterHash)
        throw Error('Unconfirmed preparation outcome; deployment file differs from the prepared bytes');
      if (record.stage !== 'committed')
        replaceDeploymentFile(recordPath, `${JSON.stringify({ ...record, stage: 'committed' }, null, 2)}\n`, stored);
      return {
        status: 'ready',
        idempotent: true,
        preparationId: record.preparationId,
        auditDir,
        bootstrap: effective[BOOTSTRAP_KEY],
        audit: effective[AUDIT_KEY],
        restartRequired: true,
      };
    }
    if (record && (record.managedFingerprint !== managedFingerprint || record.beforeHash !== before.hash)) {
      if (record.stage !== 'committed' && !options.auditDir)
        throw Error(
          'Deployment inputs changed during an unfinished preparation; preserve the record and explicitly select --audit-dir to prepare a new target',
        );
      const history = join(hostRoot, `.cat-cafe/deployment-preparation-${record.preparationId}.json`);
      if (existsSync(history)) throw Error('Preparation history target already exists');
      renameSync(recordPath, history);
      record = undefined;
    }
    preparationId = record?.preparationId ?? randomUUID();
    const additions = { ...modes };
    let sourceText = before.text;
    if (!Object.hasOwn(fileEnv, 'AUDIT_LOG_DIR')) additions.AUDIT_LOG_DIR = auditDir.replaceAll('\\', '/');
    else if (options.auditDir)
      sourceText = sourceText.replace(/^(\s*AUDIT_LOG_DIR\s*=)[^\r\n]*/m, `$1"${auditDir.replaceAll('\\', '/')}"`);
    const next = appendDeploymentKeys(sourceText, additions, preparationId);
    record ??= {
      schemaVersion: 1,
      preparationId,
      createdAt: new Date().toISOString(),
      stage: 'planned',
      managedFingerprint,
      beforeHash: before.hash,
      afterHash: fingerprint(next),
      auditDir,
    };
    const writeRecord = () =>
      replaceDeploymentFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, fileSnapshot(recordPath));
    writeRecord();
    stage = 'audit-readiness';
    await (options.probeAudit ?? auditProbe)({ auditDir, preparationId, createdAt: record.createdAt });
    record.stage = 'audited';
    writeRecord();
    stage = 'commit';
    if (!sameSnapshot(fileSnapshot(envPath), before))
      throw Error('Host .env changed during preparation; original deployment file was retained');
    options.beforeCommit?.();
    replaceDeploymentFile(envPath, next, before);
    envCommitted = true;
    options.afterEnvCommit?.();
    record.stage = 'committed';
    writeRecord();
    return {
      status: 'ready',
      idempotent: false,
      preparationId,
      auditDir,
      bootstrap: effective[BOOTSTRAP_KEY],
      audit: effective[AUDIT_KEY],
      restartRequired: true,
    };
  } catch (error) {
    error.preparation = { stage, preparationId, auditDir, envCommitted, directoriesMayRemain: true };
    throw error;
  } finally {
    await removeOwnedLease(lockPath, lease.leaseId, lease.holderPid);
  }
}
