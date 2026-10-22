import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { fingerprint } from './intranet-deployment-env.mjs';

export function assertPlainPath(path) {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw Error(`Reparse/symlink target is not permitted: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}
export function fileSnapshot(path) {
  assertPlainPath(path);
  if (!existsSync(path)) return { text: '', hash: fingerprint(''), identity: null, mode: 0o600 };
  const descriptor = openSync(path, 'r');
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw Error(`Expected a deployment file: ${path}`);
    const text = readFileSync(descriptor, 'utf8');
    const after = lstatSync(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      stat.ino !== after.ino ||
      stat.dev !== after.dev ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.size !== after.size
    )
      throw Error(`Deployment file changed while reading: ${path}`);
    return { text, hash: fingerprint(text), identity: `${stat.dev}:${stat.ino}`, mode: Number(stat.mode & 0o777n) };
  } finally {
    closeSync(descriptor);
  }
}
export function sameSnapshot(left, right) {
  return left.hash === right.hash && left.identity === right.identity;
}

function preservePermissions(target, source) {
  if (process.platform !== 'win32') return;
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Console]::In.ReadToEnd() | ConvertFrom-Json
if ($p.source) { $acl=[IO.File]::GetAccessControl($p.source) }
else {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
}
[IO.File]::SetAccessControl($p.target,$acl)
`;
  execFileSync(
    resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      input: JSON.stringify({ target, source }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')),
    },
  );
}
/** The final comparison and rename are synchronous; do not add awaits between them. */
export function replaceDeploymentFile(path, text, expected, { beforeCommit } = {}) {
  const temporary = `${path}.prepare-${process.pid}-${randomUUID()}`;
  try {
    assertPlainPath(path);
    writeFileSync(temporary, text, { flag: 'wx', mode: expected.mode });
    preservePermissions(temporary, expected.identity === null ? undefined : path);
    beforeCommit?.();
    if (!sameSnapshot(fileSnapshot(path), expected)) throw Error(`Deployment file changed before commit: ${path}`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
