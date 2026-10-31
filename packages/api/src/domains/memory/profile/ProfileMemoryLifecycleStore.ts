import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProfileMemoryOwnerAction, ProfileMemoryOwnerEntry } from '@cat-cafe/shared';
import {
  CURRENT_RELATIONSHIP_PROFILE_URI,
  LEGACY_PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CORPUS_RELATIVE_PATH,
  relationshipPrimerRelativePath,
} from '@cat-cafe/shared/profile-contract';
import { profileRevisionOf } from '@cat-cafe/shared/profile-revision';
import type Database from 'better-sqlite3';
import type { FileProfileRepository } from '../../cats/services/profile/ProfileRepository.js';
import { atomicWriteUtf8 } from '../../cats/services/profile/writeProfileUpdate.js';
import { sharedProfileMemoryEntry } from './profile-memory-entry.js';
import {
  profileMemoryTombstoneContent,
  purgeTargetProvenance,
  removeMatchingProfileTombstone,
} from './profile-memory-files.js';

export interface StoredProfileMemoryEntry extends Omit<ProfileMemoryOwnerEntry, 'proposals'> {
  path: string;
  profileDir: string;
  targetPath: string;
}

export type ProfileMemoryMutationResult =
  | { outcome: 'applied'; entry: StoredProfileMemoryEntry }
  | { outcome: 'forgotten' }
  | { outcome: 'not_available' | 'stale_revision' | 'idempotency_conflict' };

export interface ProfileMemoryOwnerActionEvidence {
  action: ProfileMemoryOwnerAction['action'];
  commandDigest: string;
  applied: boolean;
  revision?: string;
}

interface EvidenceRow {
  action: ProfileMemoryOwnerAction['action'];
  command_digest: string;
  result_revision: string | null;
  applied_at: string | null;
}

export class ProfileMemoryLifecycleStore {
  constructor(
    private readonly deps: {
      db: Database.Database;
      repository: FileProfileRepository;
      now?: () => number;
    },
  ) {}

  list(ownerUserId: string): StoredProfileMemoryEntry[] {
    const entries: StoredProfileMemoryEntry[] = [];
    const capsule = this.get(ownerUserId, 'capsule');
    if (capsule) entries.push(capsule);
    const corpus = this.deps.repository.readCorpus(ownerUserId);
    if (corpus) entries.push(sharedProfileMemoryEntry(this.deps.repository, ownerUserId, 'corpus', corpus));
    for (const primer of this.deps.repository.listPrimers(ownerUserId)) {
      entries.push({
        id: `primer:${primer.relationshipKey}`,
        type: 'profile',
        layer: 'primer',
        relationshipKey: primer.relationshipKey,
        uri: CURRENT_RELATIONSHIP_PROFILE_URI,
        title: `与 ${primer.relationshipKey} 的关系画像`,
        status: 'active',
        revision: primer.revision,
        content: primer.content,
        path: primer.path,
        profileDir: this.deps.repository.profileDir(ownerUserId),
        targetPath: primer.targetPath,
      });
    }
    return entries;
  }

  get(ownerUserId: string, memoryId: string): StoredProfileMemoryEntry | null {
    if (memoryId === 'capsule') {
      const capsule = this.deps.repository.readCapsule(ownerUserId);
      return capsule ? sharedProfileMemoryEntry(this.deps.repository, ownerUserId, 'capsule', capsule) : null;
    }
    if (memoryId === 'corpus') {
      const corpus = this.deps.repository.readCorpus(ownerUserId);
      return corpus ? sharedProfileMemoryEntry(this.deps.repository, ownerUserId, 'corpus', corpus) : null;
    }
    if (!memoryId.startsWith('primer:')) return null;
    const relationshipKey = memoryId.slice('primer:'.length);
    if (!relationshipKey) return null;
    let targetPath: string;
    let path: string;
    try {
      targetPath = relationshipPrimerRelativePath(relationshipKey);
      path = this.deps.repository.primerPathForRelationship(ownerUserId, relationshipKey);
    } catch {
      return null;
    }
    const primer = this.deps.repository
      .listPrimers(ownerUserId)
      .find((item) => item.relationshipKey === relationshipKey);
    if (!primer || primer.path !== path) return null;
    return {
      id: memoryId,
      type: 'profile',
      layer: 'primer',
      relationshipKey,
      uri: CURRENT_RELATIONSHIP_PROFILE_URI,
      title: `与 ${relationshipKey} 的关系画像`,
      status: 'active',
      revision: primer.revision,
      content: primer.content,
      path,
      profileDir: this.deps.repository.profileDir(ownerUserId),
      targetPath,
    };
  }

  lockKey(ownerUserId: string, memoryId: string): string | null {
    return this.resolveTarget(ownerUserId, memoryId)?.path ?? null;
  }

  commandDigest(command: ProfileMemoryOwnerAction): string {
    const contentRevision = command.action === 'replace_content' ? profileRevisionOf(command.content) : null;
    return `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          action: command.action,
          requestId: command.requestId,
          expectedRevision: command.expectedRevision,
          contentRevision,
          confirmed: command.action === 'hard_forget' ? command.confirmed : null,
        }),
      )
      .digest('hex')}`;
  }

  replaceContent(input: {
    ownerUserId: string;
    memoryId: string;
    command: Extract<ProfileMemoryOwnerAction, { action: 'replace_content' }>;
  }): ProfileMemoryMutationResult {
    const commandDigest = this.commandDigest(input.command);
    const existingEvidence = this.getOwnerActionEvidence(input.ownerUserId, input.memoryId, input.command.requestId);
    if (existingEvidence && existingEvidence.commandDigest !== commandDigest) {
      return { outcome: 'idempotency_conflict' };
    }
    if (existingEvidence?.applied && existingEvidence.revision) {
      const entry = this.get(input.ownerUserId, input.memoryId);
      return entry?.revision === existingEvidence.revision
        ? { outcome: 'applied', entry }
        : { outcome: 'stale_revision' };
    }

    const current = this.get(input.ownerUserId, input.memoryId);
    if (!current && input.memoryId !== 'capsule') return { outcome: 'not_available' };
    const currentRevision = current?.revision ?? profileRevisionOf('');
    const targetRevision = profileRevisionOf(input.command.content);
    const resumingPreparedWrite = Boolean(existingEvidence && currentRevision === targetRevision);
    if (currentRevision !== input.command.expectedRevision && !resumingPreparedWrite) {
      return { outcome: 'stale_revision' };
    }
    if (!existingEvidence) {
      this.prepareEvidence({
        ...input,
        action: input.command.action,
        commandDigest,
        expectedRevision: input.command.expectedRevision,
        targetRevision,
      });
    }
    const target = this.resolveTarget(input.ownerUserId, input.memoryId);
    if (!target) return { outcome: 'not_available' };
    if (currentRevision !== targetRevision) {
      mkdirSync(dirname(target.path), { recursive: true });
      atomicWriteUtf8(target.path, input.command.content);
    }
    this.markEvidenceApplied(input.ownerUserId, input.memoryId, input.command.requestId, commandDigest, targetRevision);
    const entry = this.get(input.ownerUserId, input.memoryId);
    if (!entry || entry.revision !== targetRevision)
      throw new Error('Profile replacement did not persist expected revision');
    return { outcome: 'applied', entry };
  }

  hardForget(input: {
    ownerUserId: string;
    memoryId: string;
    command: Extract<ProfileMemoryOwnerAction, { action: 'hard_forget' }>;
  }): ProfileMemoryMutationResult {
    const commandDigest = this.commandDigest(input.command);
    const evidence = this.getOwnerActionEvidence(input.ownerUserId, input.memoryId, input.command.requestId);
    if (evidence && evidence.commandDigest !== commandDigest) return { outcome: 'idempotency_conflict' };
    if (evidence?.applied) {
      this.finishHardForgetCleanup(input.ownerUserId, input.memoryId, input.command.requestId);
      return { outcome: 'forgotten' };
    }

    const target = this.resolveTarget(input.ownerUserId, input.memoryId);
    if (!target) return { outcome: 'not_available' };
    const marker = profileMemoryTombstoneContent(input.ownerUserId, input.memoryId, input.command);
    const raw = existsSync(target.path) ? readFileSync(target.path, 'utf8') : null;
    const markerAlreadyWritten = raw === marker;
    const current = markerAlreadyWritten ? null : this.get(input.ownerUserId, input.memoryId);
    if (!markerAlreadyWritten) {
      if (!current) return { outcome: 'not_available' };
      if (current.revision !== input.command.expectedRevision) return { outcome: 'stale_revision' };
    } else if (!evidence) {
      return { outcome: 'not_available' };
    }

    if (!evidence) {
      this.prepareEvidence({
        ...input,
        action: input.command.action,
        commandDigest,
        expectedRevision: input.command.expectedRevision,
        targetRevision: null,
      });
    }
    if (!markerAlreadyWritten) {
      mkdirSync(dirname(target.path), { recursive: true });
      atomicWriteUtf8(target.path, marker);
    }
    purgeTargetProvenance(target.profileDir, target.targetPath);
    if (input.memoryId === 'capsule') purgeTargetProvenance(target.profileDir, LEGACY_PROFILE_CAPSULE_RELATIVE_PATH);
    this.markEvidenceApplied(input.ownerUserId, input.memoryId, input.command.requestId, commandDigest, null);
    this.finishHardForgetCleanup(input.ownerUserId, input.memoryId, input.command.requestId);
    return { outcome: 'forgotten' };
  }

  getOwnerActionEvidence(
    ownerUserId: string,
    memoryId: string,
    requestId: string,
  ): ProfileMemoryOwnerActionEvidence | null {
    const row = this.deps.db
      .prepare(
        `SELECT action, command_digest, result_revision, applied_at
         FROM profile_memory_owner_action_evidence
         WHERE owner_user_id = ? AND memory_id = ? AND request_id = ? LIMIT 1`,
      )
      .get(ownerUserId, memoryId, requestId) as EvidenceRow | undefined;
    if (!row) return null;
    return {
      action: row.action,
      commandDigest: row.command_digest,
      applied: row.applied_at !== null,
      ...(row.result_revision ? { revision: row.result_revision } : {}),
    };
  }

  finishHardForgetCleanup(ownerUserId: string, memoryId: string, requestId: string): void {
    const target = this.resolveTarget(ownerUserId, memoryId);
    if (target) {
      const aliases = memoryId === 'capsule' ? [this.deps.repository.legacyCapsulePath(ownerUserId)] : [];
      removeMatchingProfileTombstone(target.path, requestId, aliases);
    }
  }

  private resolveTarget(ownerUserId: string, memoryId: string) {
    if (memoryId === 'capsule') {
      return {
        path: this.deps.repository.capsulePath(ownerUserId),
        profileDir: this.deps.repository.profileDir(ownerUserId),
        targetPath: PROFILE_CAPSULE_RELATIVE_PATH,
      };
    }
    if (memoryId === 'corpus') {
      return {
        path: this.deps.repository.corpusPath(ownerUserId),
        profileDir: this.deps.repository.profileDir(ownerUserId),
        targetPath: PROFILE_CORPUS_RELATIVE_PATH,
      };
    }
    if (!memoryId.startsWith('primer:')) return null;
    const relationshipKey = memoryId.slice('primer:'.length);
    try {
      return {
        path: this.deps.repository.primerPathForRelationship(ownerUserId, relationshipKey),
        profileDir: this.deps.repository.profileDir(ownerUserId),
        targetPath: relationshipPrimerRelativePath(relationshipKey),
      };
    } catch {
      return null;
    }
  }

  private prepareEvidence(input: {
    ownerUserId: string;
    memoryId: string;
    command: ProfileMemoryOwnerAction;
    action: ProfileMemoryOwnerAction['action'];
    commandDigest: string;
    expectedRevision: string;
    targetRevision: string | null;
  }): void {
    this.deps.db
      .prepare(
        `INSERT INTO profile_memory_owner_action_evidence
           (owner_user_id, memory_id, request_id, action, command_digest, expected_revision,
            target_revision, result_revision, prepared_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        input.ownerUserId,
        input.memoryId,
        input.command.requestId,
        input.action,
        input.commandDigest,
        input.expectedRevision,
        input.targetRevision,
        new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      );
  }

  private markEvidenceApplied(
    ownerUserId: string,
    memoryId: string,
    requestId: string,
    commandDigest: string,
    resultRevision: string | null,
  ): void {
    const result = this.deps.db
      .prepare(
        `UPDATE profile_memory_owner_action_evidence
         SET result_revision = ?, applied_at = ?
         WHERE owner_user_id = ? AND memory_id = ? AND request_id = ? AND command_digest = ?`,
      )
      .run(
        resultRevision,
        new Date(this.deps.now?.() ?? Date.now()).toISOString(),
        ownerUserId,
        memoryId,
        requestId,
        commandDigest,
      );
    if (result.changes !== 1) throw new Error('Profile action evidence lost its request fence');
  }
}
