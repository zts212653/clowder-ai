import { createHash, randomBytes } from 'node:crypto';
import { type MessageSearchResponse, messageSearchResponseSchema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

export const answerDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface AnswerProducer {
  kind: 'invocation' | 'agent_key';
  id: string;
  catId: string;
}
export const answerProducerKey = (producer: AnswerProducer): string =>
  answerDigest([producer.kind, producer.id, producer.catId]);
export interface MessageSearchAnswerPublication {
  schema_version: 1;
  publication_ref: string;
  operation_key: string;
  owner_user_id: string;
  producer_key: string;
  producer_cat_id: string;
  invocation_id: string | null;
  target_thread_id: string;
  request_digest: string;
  created_at: number;
  state: 'searching' | 'prepared' | 'failed';
  response_json: string | null;
  response_digest: string | null;
  bound_message_id: string | null;
  block_id: string | null;
  /** Scan metadata only: a nonnegative round, or null once the actual binding was observed. */
  recovery_order: number | null;
  failure_code: string | null;
}

/** Uses the existing memory single-writer queue and SQLite recovery boundary. */
export class MessageSearchAnswerPublicationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly exclusive: <T>(work: () => T) => Promise<T> = async (work) => work(),
  ) {}

  get(ref: string): MessageSearchAnswerPublication | null {
    return (
      (this.db.prepare('SELECT * FROM message_search_answer_publications WHERE publication_ref=?').get(ref) as
        | MessageSearchAnswerPublication
        | undefined) ?? null
    );
  }
  forInvocation(ownerUserId: string, catId: string, invocationId: string): MessageSearchAnswerPublication | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM message_search_answer_publications WHERE owner_user_id=? AND producer_cat_id=? AND invocation_id=?',
        )
        .get(ownerUserId, catId, invocationId) as MessageSearchAnswerPublication | undefined) ?? null
    );
  }
  recoveryPass(): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(recovery_order),0)+1 AS pass FROM message_search_answer_publications WHERE invocation_id IS NOT NULL AND state='prepared' AND recovery_order IS NOT NULL",
        )
        .get() as { pass: number }
    ).pass;
  }
  pendingResponses(pass: number): MessageSearchAnswerPublication[] {
    return this.db
      .prepare(
        "SELECT * FROM message_search_answer_publications WHERE invocation_id IS NOT NULL AND state='prepared' AND recovery_order<? ORDER BY recovery_order,publication_ref LIMIT 100",
      )
      .all(pass) as MessageSearchAnswerPublication[];
  }
  async deferRecovery(ref: string, pass: number): Promise<void> {
    await this.exclusive(() =>
      this.db
        .prepare(
          'UPDATE message_search_answer_publications SET recovery_order=? WHERE publication_ref=? AND recovery_order<?',
        )
        .run(pass, ref, pass),
    );
  }
  /** Called only after the original message actually carries its exact Host binding. Not publication proof. */
  async completeRecovery(record: MessageSearchAnswerPublication): Promise<void> {
    await this.exclusive(() =>
      this.db
        .prepare(
          "UPDATE message_search_answer_publications SET recovery_order=NULL WHERE publication_ref=? AND state='prepared' AND bound_message_id=? AND block_id=? AND response_digest=?",
        )
        .run(record.publication_ref, record.bound_message_id, record.block_id, record.response_digest),
    );
  }
  response(record: MessageSearchAnswerPublication): MessageSearchResponse | null {
    try {
      if (!record.response_json || record.response_json.length > 24000) return null;
      const value: unknown = JSON.parse(record.response_json);
      const parsed = messageSearchResponseSchema.safeParse(value);
      return parsed.success && answerDigest(value) === record.response_digest ? parsed.data : null;
    } catch {
      return null;
    }
  }
  async claim(input: {
    ownerUserId: string;
    producer: AnswerProducer;
    operationId: string;
    targetThreadId: string;
    requestDigest: string;
  }) {
    const operationKey = answerDigest([input.ownerUserId, answerProducerKey(input.producer), input.operationId]);
    return this.exclusive(() =>
      this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT * FROM message_search_answer_publications WHERE operation_key=?')
          .get(operationKey) as MessageSearchAnswerPublication | undefined;
        if (existing) return { created: false, record: existing };
        if (
          input.producer.kind === 'invocation' &&
          this.forInvocation(input.ownerUserId, input.producer.catId, input.producer.id)
        )
          throw new Error('ANSWER_INVOCATION_ALREADY_PREPARED');
        const ref = `message-search-answer:${randomBytes(32).toString('hex')}`;
        this.db
          .prepare(`INSERT INTO message_search_answer_publications(publication_ref,operation_key,owner_user_id,producer_key,producer_cat_id,invocation_id,target_thread_id,request_digest,created_at,recovery_order,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,'searching')`)
          .run(
            ref,
            operationKey,
            input.ownerUserId,
            answerProducerKey(input.producer),
            input.producer.catId,
            input.producer.kind === 'invocation' ? input.producer.id : null,
            input.targetThreadId,
            input.requestDigest,
            Date.now(),
            // Join the existing round; later arrivals must not reset ahead of older deferred R records.
            this.recoveryPass() - 1,
          );
        return { created: true, record: this.get(ref)! };
      })(),
    );
  }
  async complete(ref: string, response: MessageSearchResponse): Promise<void> {
    const validated = messageSearchResponseSchema.parse(response);
    const json = JSON.stringify(validated);
    if (json.length > 24000) throw new Error('ANSWER_RESPONSE_OVERSIZED');
    await this.exclusive(() => {
      if (
        this.db
          .prepare(
            "UPDATE message_search_answer_publications SET state='prepared',response_json=?,response_digest=? WHERE publication_ref=? AND state='searching'",
          )
          .run(json, answerDigest(validated), ref).changes !== 1
      )
        throw new Error('ANSWER_PREPARATION_CONFLICT');
    });
  }
  async fail(ref: string): Promise<void> {
    await this.exclusive(() =>
      this.db
        .prepare(
          "UPDATE message_search_answer_publications SET state='failed',failure_code='search_unavailable' WHERE publication_ref=? AND state='searching'",
        )
        .run(ref),
    );
  }
  async claimBinding(ref: string, messageId: string, blockId: string): Promise<boolean> {
    return this.exclusive(
      () =>
        this.db
          .prepare(`UPDATE message_search_answer_publications SET bound_message_id=?,block_id=?
      WHERE publication_ref=? AND state='prepared' AND (bound_message_id IS NULL OR (bound_message_id=? AND block_id=?))`)
          .run(messageId, blockId, ref, messageId, blockId).changes === 1,
    );
  }
}
