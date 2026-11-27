import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PROFILE_CAPSULE_RELATIVE_PATH, renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';

export function profileOwnerFixture(db, store) {
  return {
    list: async (owner) => store.list(owner),
    get: async (owner, memoryId) => store.get(owner, memoryId),
    provenance: async (owner, memoryId) => {
      const entry = store.get(owner, memoryId);
      return entry
        ? { outcome: 'found', coordinates: readStoredProfileProvenance(entry) }
        : { outcome: 'not_available' };
    },
    usage: async (owner, memoryId) => {
      const entry = store.get(owner, memoryId);
      const { readProfileUsage } = await import('../../dist/domains/memory/profile/ProfileUsageReader.js');
      return entry ? { outcome: 'found', usage: readProfileUsage(db, owner, entry) } : { outcome: 'not_available' };
    },
  };
}

export function profileOwnerActionFixture(store) {
  return {
    lockKey: (owner, memoryId) => store.lockKey(owner, memoryId),
    mutate: async (ownerUserId, memoryId, command) => {
      if (memoryId === 'capsule' && command.action === 'replace_content') {
        try {
          if (!renderUserCapsuleSection(command.content)) return { outcome: 'invalid_content' };
        } catch {
          return { outcome: 'invalid_content' };
        }
      }
      return command.action === 'replace_content'
        ? store.replaceContent({ ownerUserId, memoryId, command })
        : store.hardForget({ ownerUserId, memoryId, command });
    },
    recover: async (owner, memoryId, command) => {
      const evidence = store.getOwnerActionEvidence(owner, memoryId, command.requestId);
      if (
        !evidence?.applied ||
        evidence.action !== command.action ||
        evidence.commandDigest !== store.commandDigest(command)
      ) {
        return null;
      }
      if (command.action === 'hard_forget') {
        store.finishHardForgetCleanup(owner, memoryId, command.requestId);
        return { action: command.action };
      }
      return evidence.revision ? { action: command.action, revision: evidence.revision } : null;
    },
  };
}

function readStoredProfileProvenance(entry) {
  const opening = entry.layer === 'primer' ? readProfileOpeningReference(entry.content) : null;
  return [
    ...(opening?.excerpts.map((item, index) => ({
      ...item.source,
      label: `开场参考 ${index + 1} · ${item.kind === 'relationship' ? '陪伴与关系' : '历史能力判断'}`,
      occurredAt: null,
    })) ?? []),
    ...listTargetProvenance(entry),
  ];
}

function listTargetProvenance(entry) {
  const provenanceDir = join(entry.profileDir, 'provenance');
  if (!existsSync(provenanceDir)) return [];
  const result = [];
  for (const file of readdirSync(provenanceDir, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(provenanceDir, file.name);
    let content;
    let modifiedAt;
    try {
      content = readFileSync(path, 'utf8');
      modifiedAt = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const fields = parseMetadata(content);
    if (
      fields.target !== entry.targetPath &&
      !(entry.layer === 'capsule' && fields.target === LEGACY_PROFILE_CAPSULE_RELATIVE_PATH)
    )
      continue;
    const threadId = fields.signalSourceThread ?? fields.thread;
    const messageId = fields.signalSourceMessage;
    result.push({
      ...(threadId ? { threadId } : {}),
      ...(messageId ? { messageId } : {}),
      occurredAt: Number.isFinite(modifiedAt) ? modifiedAt : null,
    });
  }
  return result;
}

function parseMetadata(content) {
  const fields = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) break;
    const match = /^- ([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}
