#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanSecretContent } from './lib/secret-content-scan.mjs';
import {
  GIT_OID,
  locallyPresentObjects,
  safeGitLocation,
  scanGitObject,
  secretGit,
  ZERO_OID,
} from './lib/secret-git-objects.mjs';

export function scanSecretIndex(cwd = process.cwd()) {
  const entries = secretGit(['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--diff-filter=ACMT', '-z'], {
    cwd,
  })
    .toString('utf8')
    .split('\0');
  const findings = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const oid = entries[i].split(' ')[3];
    const path = entries[i + 1];
    if (!path || !GIT_OID.test(oid) || ZERO_OID.test(oid)) throw new Error('secret_scan_unavailable');
    const location = safeGitLocation(path);
    findings.push(...scanSecretContent(path).map(({ ruleId }) => ({ ruleId, location: 'staged-path' })));
    findings.push(...scanGitObject(oid, cwd, location));
    if (findings.length) return findings;
  }
  return findings;
}

export function scanSecretPush(input, destination, cwd = process.cwd()) {
  if (!destination || input.length > 1024 * 1024) throw new Error('secret_scan_unavailable');
  const { tips, requiredOld } = pushTips(input);
  if (!tips.size) return [];
  const refFindings = scanSecretContent(input);
  if (refFindings.length) return refFindings.map(({ ruleId }) => ({ ruleId, location: 'push-ref' }));
  const old = [...requiredOld];
  if (locallyPresentObjects(old, cwd).length !== old.length) throw new Error('secret_scan_unavailable');
  // A cached origin/main does not prove what the destination currently owns.
  const advertised = secretGit(['ls-remote', '--refs', '--', destination], { cwd }).toString().trim();
  const remoteIds = advertised ? advertised.split('\n').map((line) => line.split(/\s+/)[0]) : [];
  if (remoteIds.some((oid) => !GIT_OID.test(oid))) throw new Error('secret_scan_unavailable');
  const have = [...new Set([...old, ...locallyPresentObjects(remoteIds, cwd)])];
  const revisions = [...tips, ...have.map((oid) => `^${oid}`)].join('\n');
  const outgoing = secretGit(['rev-list', '--objects', '--no-object-names', '--stdin'], {
    cwd,
    input: `${revisions}\n`,
  })
    .toString()
    .trim();
  // Include the outer annotated tag itself; peeling only its commit loses its message.
  const oids = new Set([...tips, ...(outgoing ? outgoing.split('\n') : [])]);
  let ordinal = 0;
  for (const oid of oids) {
    const findings = scanGitObject(oid, cwd, `outgoing-object-${++ordinal}`);
    if (findings.length) return findings;
  }
  return [];
}

function pushTips(input) {
  const tips = new Set();
  const requiredOld = new Set();
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || !GIT_OID.test(fields[1]) || !GIT_OID.test(fields[3]))
      throw new Error('secret_scan_unavailable');
    if (ZERO_OID.test(fields[1])) continue;
    tips.add(fields[1]);
    if (!ZERO_OID.test(fields[3])) requiredOld.add(fields[3]);
  }
  return { tips, requiredOld };
}

async function main() {
  try {
    const [mode, target] = process.argv.slice(2);
    let findings;
    if (mode === 'index') findings = scanSecretIndex();
    else if (mode === 'message') findings = scanSecretContent(readFileSync(target));
    else if (mode === 'push') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 1024 * 1024) throw new Error('secret_scan_unavailable');
      }
      findings = scanSecretPush(input, target);
    } else throw new Error('secret_scan_unavailable');
    if (findings.length) {
      process.stderr.write(`${JSON.stringify({ code: 'secret_content_detected', findings })}\n`);
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('secret_scan_unavailable: content was not verified; operation blocked.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
