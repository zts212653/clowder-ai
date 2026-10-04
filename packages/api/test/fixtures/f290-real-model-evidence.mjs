import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Hash executable code only; account/catalog/auth files are never read here. */
export async function executableFingerprint(repo) {
  const directories = [
    'packages/shared/dist',
    'packages/collective-client/dist',
    'packages/collective-connector/dist',
    'packages/collective-service/dist',
    'packages/mcp-server/dist',
    'packages/api/src/domains/cats/services',
    'packages/api/src/domains/plugin/builtin-runtime',
    'packages/api/src/routes',
    'packages/api/src/infrastructure/document',
    'packages/api/src/domains/growing',
  ];
  const trees = [];
  for (const directory of directories) {
    const files = (await readdir(join(repo, directory), { recursive: true }))
      .filter((file) => /\.(?:js|ts)$/.test(file) && !file.endsWith('.d.ts'))
      .sort();
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update(await readFile(join(repo, directory, file)));
    }
    trees.push({ directory, files: files.length, sha256: hash.digest('hex') });
  }
  const collabEntrypoint = join(repo, 'packages/mcp-server/dist/collab.js');
  const fixtureDirectory = 'packages/api/test/fixtures';
  const driverFiles = (await readdir(join(repo, fixtureDirectory)))
    .filter((file) => /^f290-real-model-.*\.mjs$/.test(file))
    .map((file) => `${fixtureDirectory}/${file}`)
    .concat('scripts/f290-communication-real-model-smoke.sh')
    .sort();
  const driverHash = createHash('sha256');
  for (const file of driverFiles) {
    driverHash.update(file);
    driverHash.update(await readFile(join(repo, file)));
  }
  return {
    driverFiles,
    driverSha256: driverHash.digest('hex'),
    collabEntrypoint,
    collabEntrypointSha256: createHash('sha256')
      .update(await readFile(collabEntrypoint))
      .digest('hex'),
    trees,
  };
}

export function captureModelObservations(evidence, expectedModel) {
  try {
    evidence.modelInvocations = verifiedModelInvocations(evidence, expectedModel);
  } catch (error) {
    evidence.modelObservationIncomplete = { name: error.name, message: error.message };
  }
}

export function visibleMessageEvidence(message) {
  const fields = [
    'id',
    'userId',
    'threadId',
    'catId',
    'origin',
    'timestamp',
    'deliveryStatus',
    'replyTo',
    'invocationId',
    'content',
    'metadata',
    'toolEvents',
    'source',
    'delivery',
    'extra',
    'queueCustody',
    'recall',
    '_tombstone',
  ];
  return Object.fromEntries(fields.filter((key) => message[key] !== undefined).map((key) => [key, message[key]]));
}

export function verifiedModelInvocations(evidence, expectedModel) {
  const ids = [...new Set(evidence.frames.map((frame) => frame.turnInvocationId).filter(Boolean))];
  return ids.map((invocationId) => {
    const frame = evidence.frames.find((row) => row.turnInvocationId === invocationId && row.metadata?.modelVerified);
    assert.ok(frame, `Actual served model must be verified for ${invocationId}`);
    const metadata = frame.metadata;
    assert.equal(metadata.servedModel, expectedModel);
    return {
      cafe: frame.cafe,
      invocationId,
      provider: metadata.provider,
      requestedModel: metadata.model,
      servedModel: metadata.servedModel,
      modelVerified: metadata.modelVerified,
      servedModelSource: metadata.servedModelSource,
      servedResponseId: metadata.servedResponseId,
      sessionId: metadata.sessionId,
    };
  });
}

/** Serialized tool details can contain assignments inside strings, not just sensitive object keys. */
export function safeEvidence(evidence) {
  let redactedAssignments = 0;
  const assignment =
    /(\b(?:CAT_CAFE_CALLBACK_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|callbackToken|access_token|refresh_token|api_key)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[A-Za-z0-9+/_=.-]{12,}/gi;
  const bearer = /(\bBearer\s+)[A-Za-z0-9+/_=.-]{16,}/gi;
  const apiKey = /\bsk-(?:proj-|org-)?[A-Za-z0-9_-]{16,}/g;
  const sanitized = JSON.parse(
    JSON.stringify(evidence, (key, value) => {
      if (/(?:token|secret|credential|password|api.?key|authorization|cookie)/i.test(key)) return undefined;
      if (typeof value !== 'string') return value;
      return value
        .replace(assignment, (_match, prefix) => {
          redactedAssignments += 1;
          return `${prefix}[redacted]`;
        })
        .replace(bearer, (_match, prefix) => {
          redactedAssignments += 1;
          return `${prefix}[redacted]`;
        })
        .replace(apiKey, () => {
          redactedAssignments += 1;
          return '[redacted]';
        });
    }),
  );
  return { ...sanitized, secretRedaction: { nestedStringAssignmentsRemoved: redactedAssignments } };
}
