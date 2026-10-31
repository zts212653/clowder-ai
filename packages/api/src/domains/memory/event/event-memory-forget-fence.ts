import type Database from 'better-sqlite3';

/**
 * Reconcile rollback-era rows and fence even pre-lifecycle SQL writers.
 * This runs on every Event store open because a rolled-back binary keeps the
 * newer schema version and therefore cannot be repaired by a one-shot migration.
 */
export function installEventMemoryForgetFence(db: Database.Database): void {
  // Keep reconciliation and trigger replacement indivisible to older writers.
  db.transaction(() => {
    db.exec(`
    DELETE FROM event_memory
    WHERE EXISTS (
      SELECT 1 FROM event_memory_forget_tombstone AS forgotten
      WHERE forgotten.ownerUserId = event_memory.ownerUserId
        AND forgotten.threadId = event_memory.threadId
        AND forgotten.messageId = event_memory.messageId
        AND forgotten.type = event_memory.type
    );
    DROP TRIGGER IF EXISTS event_memory_forget_no_insert;
    CREATE TRIGGER event_memory_forget_no_insert
    BEFORE INSERT ON event_memory
    WHEN EXISTS (
      SELECT 1 FROM event_memory_forget_tombstone AS forgotten
      WHERE forgotten.ownerUserId = NEW.ownerUserId
        AND forgotten.threadId = NEW.threadId
        AND forgotten.messageId = NEW.messageId
        AND forgotten.type = NEW.type
    )
    BEGIN
      SELECT RAISE(ABORT, 'owner-forgotten Event coordinate cannot be reinserted');
    END;
    DROP TRIGGER IF EXISTS event_memory_forget_no_coordinate_update;
    CREATE TRIGGER event_memory_forget_no_coordinate_update
    BEFORE UPDATE OF ownerUserId, threadId, messageId, type ON event_memory
    WHEN EXISTS (
      SELECT 1 FROM event_memory_forget_tombstone AS forgotten
      WHERE forgotten.ownerUserId = NEW.ownerUserId
        AND forgotten.threadId = NEW.threadId
        AND forgotten.messageId = NEW.messageId
        AND forgotten.type = NEW.type
    )
    BEGIN
      SELECT RAISE(ABORT, 'owner-forgotten Event coordinate cannot be restored');
    END;
    `);
  })();
}
