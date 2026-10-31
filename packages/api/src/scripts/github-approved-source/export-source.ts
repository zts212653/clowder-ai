import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { APPROVAL, approvedScope, type SourceScope } from './approved-scope.js';
import { approvedArchiveModules, type SourceModules } from './archive.js';
import { openApprovedProductionRead } from './read-port.js';

const writerEvidence = z
  .object({
    v: z.literal(1),
    observedAt: z.number().int(),
    bootId: z.string().uuid(),
    runningRevision: z.string().regex(/^[a-f0-9]{40}$/),
    legacySchedulesRegistered: z.literal(0),
    githubInstalledInstances: z.union([z.literal(0), z.literal(1)]),
    installedRecoveryInstance: z
      .object({
        pluginId: z.literal('official.github-operations'),
        instanceId: z.string().regex(/^pi_[a-f0-9-]{36}$/),
        packageDigest: z.literal(APPROVAL.archiveDigest),
        intent: z.literal('disabled'),
        live: z.literal('stopped'),
        recoveryMode: z.literal('import-only'),
      })
      .strict()
      .optional(),
    evidenceRefs: z.array(z.string().min(1).max(500)).min(2).max(10),
  })
  .strict()
  .refine((p) => (p.githubInstalledInstances === 1) === (p.installedRecoveryInstance !== undefined));

export async function readWriterEvidence(path: string, now = Date.now()) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 16000)
      throw new Error('Writer evidence must be private, owned and bounded');
    const buffer = Buffer.alloc(16001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16000) throw new Error('Writer evidence grew');
    const bytes = buffer.subarray(0, bytesRead);
    const evidence = writerEvidence.parse(JSON.parse(bytes.toString('utf8')));
    if (now - evidence.observedAt > 300000 || evidence.observedAt > now + 1000)
      throw new Error('Refresh independent writer absence evidence before connecting');
    return { evidence, ref: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  } finally {
    await file.close();
  }
}

type OpenPort = () => ReturnType<typeof openApprovedProductionRead>;
export async function freezeToNewFile(
  output: string,
  scope: SourceScope,
  modules: SourceModules,
  openPort: OpenPort,
  signal: AbortSignal,
) {
  // A pre-existing file is never truncated. A failed attempt keeps an incomplete
  // private artifact; it cannot be mistaken for a complete source or overwritten.
  const file = await open(output, 'wx', 0o600);
  try {
    signal.throwIfAborted();
    const port = await openPort();
    const frozen = await modules.freezeGitHubSource(
      { read: (s) => modules.collectLegacyGitHubSource(port.reader, scope, s) },
      signal,
    );
    signal.throwIfAborted();
    const proof = port.proof();
    await file.writeFile(
      modules.canonicalBytes({
        ...frozen,
        approvalSourceRef: APPROVAL.sourceRef,
        archiveApprovalSourceRef: APPROVAL.archiveApprovalSourceRef,
        archiveSha256: APPROVAL.archiveSha256,
        readOnlyProof: proof,
      }),
    );
    await file.sync();
    return { digest: frozen.digest, counts: frozen.counts, readOnlyProof: proof, rawContentPrinted: false };
  } finally {
    await file.close();
  }
}

export async function executeApprovedSource(approvalSource: string, writerEvidencePath: string) {
  // These facts require external verification. This function does not claim a
  // local string is authenticated operator authority or an independently proven lease.
  const proof = await readWriterEvidence(writerEvidencePath);
  const scope = approvedScope(approvalSource, proof.ref);
  const archive = join(APPROVAL.directory, 'clowder-ai-github-operations-0.1.0-alpha.19-darwin-arm64-6a9ce578e0d5.tgz');
  const loaded = await approvedArchiveModules(archive);
  const signal = AbortSignal.timeout(300000);
  try {
    return await freezeToNewFile(
      join(APPROVAL.directory, 'production-github-source-final6a9c.json'),
      scope,
      loaded.modules,
      () => openApprovedProductionRead(scope, loaded.modules.policy, signal),
      signal,
    );
  } finally {
    await loaded.release();
  }
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { 'approval-source': { type: 'string' }, 'writer-evidence': { type: 'string' } },
      allowPositionals: false,
    });
    if (!values['approval-source'] || !values['writer-evidence'])
      throw new Error('Exact approval and fresh writer evidence required');
    process.stdout.write(
      `${JSON.stringify(await executeApprovedSource(values['approval-source'], values['writer-evidence']))}\n`,
    );
  } catch {
    process.stderr.write(
      'Approved GitHub source read refused or incomplete. Inspect private preconditions; no server contents printed.\n',
    );
    process.exitCode = 1;
  }
}
