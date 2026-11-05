import { execFileSync } from 'node:child_process';
import { redactSecretContent, scanSecretContent } from './secret-content-scan.mjs';

export const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const ZERO_OID = /^0{40}(?:0{24})?$/;

export function secretGit(args, { cwd = process.cwd(), input } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Git errors can contain a credential in a path, message or authenticated URL.
    throw new Error('secret_scan_unavailable');
  }
}

export function scanGitObject(oid, cwd, location) {
  if (!GIT_OID.test(oid)) throw new Error('secret_scan_unavailable');
  const content = secretGit(['cat-file', '-p', oid], { cwd });
  // Scan all bytes, including binary blobs; overlap keeps long private keys and
  // credentials crossing chunk boundaries visible without unbounded regex input.
  for (let offset = 0; offset < content.length; offset += 1024 * 1024) {
    const start = Math.max(0, offset - 20 * 1024);
    const findings = scanSecretContent(content.subarray(start, offset + 1024 * 1024));
    if (findings.length) {
      const finding = findings[0];
      const absoluteOffset = start + finding.offset;
      const prefix = content.subarray(0, absoluteOffset).toString('latin1');
      return [
        {
          ruleId: finding.ruleId,
          line: prefix.split('\n').length,
          column: absoluteOffset - prefix.lastIndexOf('\n'),
          location,
        },
      ];
    }
  }
  return [];
}

export function safeGitLocation(value) {
  return [...redactSecretContent(value)]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '?' : char))
    .join('');
}

export function locallyPresentObjects(oids, cwd) {
  if (!oids.length) return [];
  const result = secretGit(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd,
    input: `${oids.join('\n')}\n`,
  });
  return result
    .toString()
    .trim()
    .split('\n')
    .filter((line) => !line.endsWith(' missing'))
    .map((line) => line.split(' ')[0]);
}
