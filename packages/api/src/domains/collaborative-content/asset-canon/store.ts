import {
  type AssetCanonMutation,
  type AssetCanonRecord,
  type AssetUpdateDecision,
  assetCanonCommandSchema,
  assetCanonRecordSchema,
  type CharacterAssetBinding,
  characterAssetBindingSchema,
  type VideoProjectAssetVersion,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkPrincipal } from '../works/types.js';
import { canonDigest, canonJson } from './identity.js';
import { applyCanonMutation } from './mutations.js';

export class AssetCanonConflictError extends Error {}
export interface CanonReceipt {
  operationId: string;
  requestDigest: string;
  actor: WorkPrincipal['actor'];
  recordedAt: string;
  assets: AssetCanonRecord[];
  bindings: CharacterAssetBinding[];
  decision?: AssetUpdateDecision;
}
export interface CanonHistory {
  kind: string;
  revision: number;
  record?: AssetCanonRecord;
  binding?: CharacterAssetBinding;
  operationId?: string;
  actor?: WorkPrincipal['actor'];
  reason?: string;
  recordedAt?: string;
}

/** Current projections and append-only receipts live in the original permanent F309 database. */
export class AssetCanonStore {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS asset_canon_records (
      owner_user_id TEXT NOT NULL, version_ref TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner_user_id, version_ref));
      CREATE TABLE IF NOT EXISTS asset_canon_history (
        owner_user_id TEXT NOT NULL, subject_ref TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_user_id, subject_ref, revision));
      CREATE TABLE IF NOT EXISTS asset_canon_bindings (
        owner_user_id TEXT NOT NULL, binding_ref TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_user_id, binding_ref));
      CREATE TABLE IF NOT EXISTS asset_canon_operations (
        owner_user_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_user_id, operation_id));
      CREATE TABLE IF NOT EXISTS asset_update_decisions (
        owner_user_id TEXT NOT NULL, decision_key TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_user_id, decision_key, revision));`);
  }
  private rows(sql: string, ...args: (string | number)[]): { body: string }[] {
    return this.db.prepare(sql).all(...args) as { body: string }[];
  }
  get(owner: string, ref: string): AssetCanonRecord | null {
    const row = this.rows(
      'SELECT body FROM asset_canon_records WHERE owner_user_id=? AND version_ref=?',
      owner,
      ref,
    )[0];
    return row ? assetCanonRecordSchema.parse(JSON.parse(row.body)) : null;
  }
  index(record: AssetCanonRecord): AssetCanonRecord {
    const parsed = assetCanonRecordSchema.parse(record);
    this.db
      .prepare('INSERT OR IGNORE INTO asset_canon_records VALUES(?,?,?)')
      .run(parsed.ownerUserId, parsed.indexedVersionRef, JSON.stringify(parsed));
    return this.get(parsed.ownerUserId, parsed.indexedVersionRef)!;
  }
  page(
    owner: string,
    offset: number,
    limit: number,
    filter: { status?: string; kind?: string; superseded?: boolean; memberAvatarCatId?: string } = {},
  ) {
    return this.rows(
      `SELECT body FROM asset_canon_records WHERE owner_user_id=?
      AND (?='' OR json_extract(body,'$.status')=?)
      AND (?='' OR json_extract(body,'$.kind')=?)
      AND (? OR json_extract(body,'$.supersededBy') IS NULL)
      AND (?='' OR EXISTS (SELECT 1 FROM json_each(json_extract(body,'$.applicability')) u
        WHERE json_extract(u.value,'$.role')='avatar' AND json_extract(u.value,'$.subjectRef.kind')='member'
        AND json_extract(u.value,'$.subjectRef.catId')=?))
      ORDER BY version_ref LIMIT ? OFFSET ?`,
      owner,
      filter.status ?? '',
      filter.status ?? '',
      filter.kind ?? '',
      filter.kind ?? '',
      filter.superseded ? 1 : 0,
      filter.memberAvatarCatId ?? '',
      filter.memberAvatarCatId ?? '',
      limit,
      offset,
    ).map((row) => assetCanonRecordSchema.parse(JSON.parse(row.body)));
  }
  allPage(owner: string, offset: number, limit: number) {
    return this.rows(
      'SELECT body FROM asset_canon_records WHERE owner_user_id=? ORDER BY version_ref LIMIT ? OFFSET ?',
      owner,
      limit,
      offset,
    ).map((row) => assetCanonRecordSchema.parse(JSON.parse(row.body)));
  }
  bindings(owner: string): CharacterAssetBinding[] {
    return this.rows('SELECT body FROM asset_canon_bindings WHERE owner_user_id=? ORDER BY binding_ref', owner).map(
      (row) => characterAssetBindingSchema.parse(JSON.parse(row.body)),
    );
  }
  binding(owner: string, ref: string, revision?: number): CharacterAssetBinding | null {
    if (revision !== undefined) {
      const row = this.rows(
        'SELECT body FROM asset_canon_history WHERE owner_user_id=? AND subject_ref=? AND revision=?',
        owner,
        ref,
        revision,
      )[0];
      return row ? ((JSON.parse(row.body) as CanonHistory).binding ?? null) : null;
    }
    const row = this.rows(
      'SELECT body FROM asset_canon_bindings WHERE owner_user_id=? AND binding_ref=?',
      owner,
      ref,
    )[0];
    return row ? characterAssetBindingSchema.parse(JSON.parse(row.body)) : null;
  }
  latestHistory(owner: string, ref: string, operationId = ''): CanonHistory | null {
    const row = this.rows(
      `SELECT body FROM asset_canon_history WHERE owner_user_id=? AND subject_ref=?
       AND (?='' OR json_extract(body,'$.operationId')=?) ORDER BY revision DESC LIMIT 1`,
      owner,
      ref,
      operationId,
      operationId,
    )[0];
    return row ? (JSON.parse(row.body) as CanonHistory) : null;
  }
  history(owner: string, ref: string, after = 0, limit = 50): CanonHistory[] {
    return this.rows(
      'SELECT body FROM asset_canon_history WHERE owner_user_id=? AND subject_ref=? ORDER BY revision LIMIT ? OFFSET ?',
      owner,
      ref,
      limit,
      after,
    ).map((row) => JSON.parse(row.body));
  }
  put(
    record: AssetCanonRecord,
    kind: string,
    audit?: { operationId: string; actor: WorkPrincipal['actor']; reason: string; recordedAt: string },
  ) {
    const parsed = assetCanonRecordSchema.parse(record);
    this.db
      .prepare('UPDATE asset_canon_records SET body=? WHERE owner_user_id=? AND version_ref=?')
      .run(JSON.stringify(parsed), parsed.ownerUserId, parsed.indexedVersionRef);
    this.append(parsed.ownerUserId, parsed.indexedVersionRef, {
      kind,
      revision: parsed.revision,
      record: parsed,
      ...audit,
    });
  }
  putBinding(record: CharacterAssetBinding, kind: string) {
    const parsed = characterAssetBindingSchema.parse(record);
    this.db
      .prepare(
        'INSERT INTO asset_canon_bindings VALUES(?,?,?) ON CONFLICT(owner_user_id,binding_ref) DO UPDATE SET body=excluded.body',
      )
      .run(parsed.ownerUserId, parsed.bindingRef, JSON.stringify(parsed));
    this.append(parsed.ownerUserId, parsed.bindingRef, { kind, revision: parsed.bindingRevision, binding: parsed });
  }
  private append(owner: string, ref: string, event: CanonHistory) {
    this.db
      .prepare('INSERT INTO asset_canon_history VALUES(?,?,?,?)')
      .run(owner, ref, event.revision, JSON.stringify(event));
  }
  snapshot(owner: string): string {
    const operations = this.db
      .prepare('SELECT count(*) AS count, max(rowid) AS last FROM asset_canon_operations WHERE owner_user_id=?')
      .get(owner);
    const history = this.db
      .prepare('SELECT count(*) AS count, max(rowid) AS last FROM asset_canon_history WHERE owner_user_id=?')
      .get(owner);
    return canonDigest([operations, history]);
  }
  replay(command: AssetCanonMutation, principal: WorkPrincipal): CanonReceipt | null {
    const row = this.rows(
      'SELECT body FROM asset_canon_operations WHERE owner_user_id=? AND operation_id=?',
      principal.userId,
      command.operationId,
    )[0];
    if (!row) return null;
    const receipt = JSON.parse(row.body) as CanonReceipt;
    if (receipt.requestDigest !== canonDigest(command) || canonJson(receipt.actor) !== canonJson(principal.actor))
      throw new AssetCanonConflictError('Asset idempotency conflict');
    return receipt;
  }
  transact(
    command: AssetCanonMutation,
    principal: WorkPrincipal,
    effect: (receipt: CanonReceipt) => void,
  ): CanonReceipt {
    return this.db
      .transaction(() => {
        const replay = this.replay(command, principal);
        if (replay) return replay;
        const receipt: CanonReceipt = {
          operationId: command.operationId,
          requestDigest: canonDigest(command),
          actor: principal.actor,
          recordedAt: new Date().toISOString(),
          assets: [],
          bindings: [],
        };
        effect(receipt);
        this.db
          .prepare('INSERT INTO asset_canon_operations VALUES(?,?,?)')
          .run(principal.userId, command.operationId, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  mutate(
    raw: AssetCanonMutation,
    principal: WorkPrincipal,
    normalizedVersion?: VideoProjectAssetVersion,
  ): CanonReceipt {
    const command = assetCanonCommandSchema.parse(raw);
    if (!('operationId' in command) || command.action === 'decide-asset-update')
      throw new Error('Unsupported canon mutation');
    return this.transact(command, principal, (receipt) =>
      applyCanonMutation(this, command, principal, receipt, normalizedVersion),
    );
  }
  decisions(
    owner: string,
    reference: { contentRef: string; ownerRevision: number },
    ref?: string,
  ): AssetUpdateDecision[] {
    return this.rows(
      `SELECT body FROM asset_update_decisions WHERE owner_user_id=?
      AND json_extract(body,'$.reference.contentRef')=? AND json_extract(body,'$.reference.ownerRevision')=?
      ORDER BY revision`,
      owner,
      reference.contentRef,
      reference.ownerRevision,
    )
      .map((row) => JSON.parse(row.body) as AssetUpdateDecision)
      .filter((d) => !ref || d.indexedVersionRef === ref);
  }
  saveDecision(owner: string, decision: AssetUpdateDecision) {
    const key = canonDigest([decision.reference, decision.indexedVersionRef, decision.noticeScope]);
    this.db
      .prepare('INSERT INTO asset_update_decisions VALUES(?,?,?,?)')
      .run(owner, key, decision.revision, JSON.stringify(decision));
  }
}
