import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readSyncScript } from './context.mjs';

export function registerSyncTransformPart6() {
  it('sync-to-opensource.sh blocks incomplete absorbed records whose files still differ from source', () => {
    const content = readSyncScript();
    const guardStart = content.indexOf('validate_incomplete_absorbed_overlaps() {');
    const guardEnd = content.indexOf('\nfind_available_port() {', guardStart);
    assert.notEqual(guardStart, -1, 'expected to find validate_incomplete_absorbed_overlaps');
    assert.notEqual(guardEnd, -1, 'expected to find the end of validate_incomplete_absorbed_overlaps');
    const guard = content.slice(guardStart, guardEnd);
    const ledgerGateIndex = content.indexOf('validate_incomplete_absorbed_overlaps "$INTAKE_LEDGER"');
    const headMatchedIndex = content.indexOf('Intake ledger up to date (target HEAD = ledger HEAD)');

    assert.notEqual(ledgerGateIndex, -1, 'pre-sync gate should call the incomplete absorbed overlap guard');
    assert.notEqual(headMatchedIndex, -1, 'expected to find the existing target HEAD ledger fast path');
    assert.ok(
      ledgerGateIndex < headMatchedIndex,
      'incomplete absorbed overlaps must be checked even when the ledger watermark equals target HEAD',
    );
    assert.match(
      guard,
      /decision === 'absorbed'[\s\S]*!entry\.intake_intent_issue[\s\S]*!entry\.review_proof/,
      'guard should only scrutinize absorbed entries missing complete intake proof',
    );
    assert.match(
      guard,
      /lastOutboundSyncIndex/,
      'guard should scope incomplete absorbed checks to commits after the latest outbound sync',
    );
    assert.match(
      guard,
      /index <= lastOutboundSyncIndex/,
      'guard should not rescan pre-sync historical ledger entries on every full sync',
    );
    assert.match(
      guard,
      /historical backfill|outbound-filed hotfix|skip-absorbed-guard/,
      'guard should skip controlled ledger exceptions that intentionally omit absorb PR proof',
    );
    assert.match(
      guard,
      /git -C "\$target_dir" show --name-only --format= "\$commit"/,
      'guard should inspect the files touched by each incomplete absorbed target commit',
    );
    assert.match(
      guard,
      /cmp -s "\$source_file" "\$target_file"/,
      'guard should block only when the current source payload would overwrite a different target file',
    );
    assert.match(
      guard,
      /recorded != absorbed-complete/,
      'guard output should explain the recorded vs complete distinction',
    );
  });
}
