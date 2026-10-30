import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  READ_ONLY_CENSUS_SCRIPT,
  projectExecFileCallback,
  projectPowerShellDiagnostic,
  runReadOnlyBaseline,
} = require('./collective-windows-private-observer-baseline.cjs');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PRIVATE_ROOT = 'D:\\private-canary\\service';
const HASH = 'a'.repeat(64);

function targetEnvironment() {
  return {
    SystemRoot: 'C:\\Windows',
    CLOWDER_COLLECTIVE_PRIVATE_ROOT: PRIVATE_ROOT,
    SECRET_ENV_CANARY: 'never-record-this-environment',
  };
}

test('execFile callback projection keeps only bounded fields and safe PowerShell identifiers', () => {
  const error = Object.assign(new Error('raw error message PRIVATE_ERROR_CANARY'), {
    code: 1,
    killed: false,
    signal: null,
    cmd: `powershell -EncodedCommand ENCODED_COMMAND_CANARY ${PRIVATE_ROOT}`,
  });
  const stderr = Buffer.from(`
#< CLIXML
<S S="Error">Get-Acl : access failed for ${PRIVATE_ROOT}\\secret-name.json_x000D__x000A_</S>
<S S="Error">    + CategoryInfo          : PermissionDenied: (${PRIVATE_ROOT}\\secret-name.json:String) [Get-Acl], UnauthorizedAccessException_x000D__x000A_</S>
<S S="Error">    + FullyQualifiedErrorId : UnauthorizedAccess,Microsoft.PowerShell.Commands.GetAclCommand_x000D__x000A_</S>
PRIVATE_STDERR_CANARY
`);
  const record = projectExecFileCallback({
    error,
    stdout: 'PRIVATE_STDOUT_CANARY',
    stderr,
    elapsedMs: 30_004,
    observerSha256: HASH,
  });
  assert.deepEqual(record, {
    v: 1,
    kind: 'collective_windows_private_execfile',
    observerSha256: HASH,
    outcome: 'error',
    elapsedMs: 30_004,
    code: 1,
    killed: false,
    signal: null,
    stdoutBytes: 21,
    stderrBytes: stderr.byteLength,
    categoryInfo: { reason: 'PermissionDenied', exceptionType: 'UnauthorizedAccessException' },
    fullyQualifiedErrorId: 'UnauthorizedAccess',
  });
  const serialized = JSON.stringify(record);
  for (const forbidden of [
    'PRIVATE_ERROR_CANARY',
    'PRIVATE_STDOUT_CANARY',
    'PRIVATE_STDERR_CANARY',
    'private-canary',
    'secret-name',
    'ENCODED_COMMAND_CANARY',
    'SECRET_ENV_CANARY',
    'GetAclCommand',
  ])
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
});

test('PowerShell diagnostic projection publishes only finite allowlisted identifiers', () => {
  assert.deepEqual(
    projectPowerShellDiagnostic(`
      CategoryInfo : ObjectNotFound: (${PRIVATE_ROOT}:String) [], ParentContainsErrorRecordException
      FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
    `),
    {
      categoryInfo: { reason: 'ObjectNotFound', exceptionType: 'ParentContainsErrorRecordException' },
      fullyQualifiedErrorId: 'CouldNotAutoloadMatchingModule',
    },
  );
  assert.deepEqual(
    projectPowerShellDiagnostic('CategoryInfo : D:\\secret\\file\nFullyQualifiedErrorId : D:\\secret\\file'),
    { categoryInfo: null, fullyQualifiedErrorId: null },
  );
  for (const privateId of ['owner-bootstrap.secret', 'PRIVATE_CONTENT_CANARY', 'PrivateAccountName']) {
    const diagnostic = projectPowerShellDiagnostic(`
      CategoryInfo : PRIVATE_CATEGORY_CANARY: (private:String) [], PRIVATE_EXCEPTION_CANARY
      FullyQualifiedErrorId : ${privateId}
    `);
    assert.deepEqual(diagnostic, { categoryInfo: null, fullyQualifiedErrorId: null });
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|owner-bootstrap|PrivateAccountName/iu);
  }
  const clixml = projectPowerShellDiagnostic(`
    #< CLIXML
    <S S="Error">CategoryInfo : PRIVATE_CATEGORY_CANARY: (private:String) [], PRIVATE_EXCEPTION_CANARY_x000D__x000A_</S>
    <S S="Error">FullyQualifiedErrorId : owner-bootstrap.secret_x000D__x000A_</S>
  `);
  assert.deepEqual(clixml, { categoryInfo: null, fullyQualifiedErrorId: null });
});

test('baseline uses a fixed read-only script and projects only aggregate census fields', async () => {
  const records = [];
  const census = {
    itemCount: 7,
    maxDepth: 3,
    reparseCount: 1,
    aclInspectedCount: 6,
    ownerCounts: { current: 4, admin: 1, system: 1, other: 0 },
    maxRuleCount: 2,
    secret: 'CENSUS_OUTPUT_CANARY',
  };
  const record = await runReadOnlyBaseline({
    execFile: (file, args, options, callback) => {
      assert.equal(file, POWERSHELL);
      assert.equal(options.env.CLOWDER_WINDOWS_PRIVATE_OBSERVER_ROOT, PRIVATE_ROOT);
      assert.equal(args.includes(PRIVATE_ROOT), false, 'private root must not enter argv');
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.equal(script, READ_ONLY_CENSUS_SCRIPT);
      queueMicrotask(() => callback(null, JSON.stringify(census), ''));
      return { fixture: 'baseline-child' };
    },
    executable: POWERSHELL,
    privateRoot: PRIVATE_ROOT,
    inheritedEnvironment: targetEnvironment(),
    appendRecord: (value) => records.push(value),
    observerSha256: HASH,
    nowNs: (() => {
      const values = [1_000_000n, 501_000_000n];
      return () => values.shift();
    })(),
  });
  assert.equal(record.elapsedMs, 500);
  assert.equal(record.outcome, 'success');
  assert.deepEqual(record.census, {
    itemCount: 7,
    maxDepth: 3,
    reparseCount: 1,
    aclInspectedCount: 6,
    ownerCounts: { current: 4, admin: 1, system: 1, other: 0 },
    maxRuleCount: 2,
  });
  assert.deepEqual(records, [record]);
  assert.doesNotMatch(JSON.stringify(record), /CENSUS_OUTPUT_CANARY|private-canary/i);
});

test('baseline failure retains only callback metadata and safe PowerShell classification', async () => {
  const failure = Object.assign(new Error('BASELINE_ERROR_CANARY'), { code: 1, killed: false, signal: null });
  const record = await runReadOnlyBaseline({
    execFile: (_file, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          failure,
          'BASELINE_STDOUT_CANARY',
          `CategoryInfo : SecurityError: (${PRIVATE_ROOT}:String) [], UnauthorizedAccessException\nFullyQualifiedErrorId : ACL_READ_FAILED`,
        ),
      );
      return { fixture: 'baseline-child' };
    },
    executable: POWERSHELL,
    privateRoot: PRIVATE_ROOT,
    inheritedEnvironment: targetEnvironment(),
    appendRecord: () => {},
    observerSha256: HASH,
  });
  assert.equal(record.outcome, 'error');
  assert.equal(record.code, 1);
  assert.deepEqual(record.categoryInfo, { reason: 'SecurityError', exceptionType: 'UnauthorizedAccessException' });
  assert.equal(record.fullyQualifiedErrorId, 'ACL_READ_FAILED');
  assert.equal(record.census, null);
  assert.doesNotMatch(JSON.stringify(record), /BASELINE_|private-canary/i);
});

test('the census script has no ACL mutation or file-content command', () => {
  assert.match(READ_ONLY_CENSUS_SCRIPT, /Get-Acl/);
  assert.match(READ_ONLY_CENSUS_SCRIPT, /EnumerateFileSystemInfos/);
  assert.doesNotMatch(
    READ_ONLY_CENSUS_SCRIPT,
    /Set-Acl|SetOwner|SetAccessRule|RemoveAccessRule|AddAccessRule|icacls|takeown|ReadAllText|Get-Content/i,
  );
});
