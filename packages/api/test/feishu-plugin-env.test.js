/**
 * #1035: parseGroupBotMentionsEnv unit tests
 *
 * Exercises the env-to-map parser for `FEISHU_GROUP_BOT_MENTIONS_JSON`.
 * Goal: misconfig must NOT crash bootstrap — bad input → log warn + return undefined.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGroupBotMentionsEnv } from '../dist/infrastructure/connectors/im-connectors/feishu/index.js';

function captureLog() {
  const warnings = [];
  return {
    log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    warnings,
  };
}

describe('parseGroupBotMentionsEnv (#1035)', () => {
  it('returns undefined when env var is unset', () => {
    const { log, warnings } = captureLog();
    assert.equal(parseGroupBotMentionsEnv(undefined, log), undefined);
    assert.equal(warnings.length, 0, 'no warn when feature simply disabled');
  });

  it('returns undefined when env var is empty string', () => {
    const { log, warnings } = captureLog();
    assert.equal(parseGroupBotMentionsEnv('', log), undefined);
    assert.equal(parseGroupBotMentionsEnv('   ', log), undefined);
    assert.equal(warnings.length, 0, 'whitespace-only treated same as unset');
  });

  it('returns undefined and logs warn on invalid JSON', () => {
    const { log, warnings } = captureLog();
    assert.equal(parseGroupBotMentionsEnv('{not valid json', log), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].msg, /parse failed/);
  });

  it('returns undefined and logs warn when top-level is a JSON array', () => {
    const { log, warnings } = captureLog();
    assert.equal(parseGroupBotMentionsEnv('["nope"]', log), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].msg, /must be a JSON object/);
  });

  it('parses a single-entry map with displayName', () => {
    const { log, warnings } = captureLog();
    const result = parseGroupBotMentionsEnv(
      JSON.stringify({ 胖胖虾: { openId: 'ou_pang', displayName: '胖胖虾' } }),
      log,
    );
    assert.deepEqual(result, { 胖胖虾: { openId: 'ou_pang', displayName: '胖胖虾' } });
    assert.equal(warnings.length, 0);
  });

  it('parses multiple entries and tolerates missing displayName', () => {
    const { log, warnings } = captureLog();
    const result = parseGroupBotMentionsEnv(
      JSON.stringify({
        胖胖虾: { openId: 'ou_pang', displayName: '胖胖虾' },
        毅马仕: { openId: 'ou_yi' },
      }),
      log,
    );
    assert.deepEqual(result, {
      胖胖虾: { openId: 'ou_pang', displayName: '胖胖虾' },
      毅马仕: { openId: 'ou_yi' },
    });
    assert.equal(warnings.length, 0);
  });

  it('skips entries missing openId and warns once per bad entry', () => {
    const { log, warnings } = captureLog();
    const result = parseGroupBotMentionsEnv(
      JSON.stringify({
        good: { openId: 'ou_good' },
        bad1: { displayName: 'no openId' },
        bad2: { openId: 42 },
        bad3: 'not even an object',
      }),
      log,
    );
    assert.deepEqual(result, { good: { openId: 'ou_good' } });
    assert.equal(warnings.length, 3, 'one warn per skipped entry');
  });

  it('returns undefined when all entries are invalid (no usable map)', () => {
    const { log } = captureLog();
    const result = parseGroupBotMentionsEnv(JSON.stringify({ bad: { displayName: 'no openId' } }), log);
    assert.equal(result, undefined);
  });

  // Reviewer P2 (cat-cafe#2611): non-empty whitespace must NOT slip through truthy checks.
  it('skips entry whose openId is whitespace-only (fail-soft contract, not truthy bypass)', () => {
    const { log, warnings } = captureLog();
    const result = parseGroupBotMentionsEnv(
      JSON.stringify({
        good: { openId: 'ou_good' },
        whitespace: { openId: '   ' },
        tabs: { openId: '\t\n' },
      }),
      log,
    );
    assert.deepEqual(result, { good: { openId: 'ou_good' } });
    assert.equal(warnings.length, 2, 'one warn per whitespace-only openId');
    for (const w of warnings) {
      assert.match(w.msg, /openId/);
    }
  });

  it('skips entries whose alias key is whitespace-only (audit: same family as openId trim)', () => {
    const { log } = captureLog();
    // Whitespace key in JSON: `"   "` — `JSON.parse` accepts it as a property name.
    const result = parseGroupBotMentionsEnv('{"   ":{"openId":"ou_ws"},"good":{"openId":"ou_good"}}', log);
    assert.deepEqual(result, { good: { openId: 'ou_good' } }, 'whitespace alias should not produce a usable entry');
  });

  // Reviewer P2 R2 (cat-cafe#2611): validate+store, not just validate.
  // Earlier fix added `trim()` to truthy checks but stored raw values, so
  // `{"  good  ":{"openId":"  ou_xxx  "}}` slipped through and produced both a
  // map key the resolver regex (which captures bare `@good`) can never hit AND
  // a malformed outbound `<at user_id="  ou_xxx  ">` token.
  it('normalizes (trims) alias key, openId, and displayName when storing entries', () => {
    const { log } = captureLog();
    const result = parseGroupBotMentionsEnv(
      JSON.stringify({
        '  good  ': { openId: '  ou_xxx  ', displayName: '  Name  ' },
        bare: { openId: 'ou_bare' },
      }),
      log,
    );
    assert.deepEqual(result, {
      good: { openId: 'ou_xxx', displayName: 'Name' },
      bare: { openId: 'ou_bare' },
    });
  });

  it('warns and last-wins when two raw aliases collide after trim', () => {
    const { log, warnings } = captureLog();
    const result = parseGroupBotMentionsEnv('{"good":{"openId":"ou_first"},"  good  ":{"openId":"ou_second"}}', log);
    // Last entry wins (JS Object.entries preserves insertion order).
    assert.deepEqual(result, { good: { openId: 'ou_second' } });
    const collisionWarn = warnings.find((w) => /duplicate alias/i.test(w.msg));
    assert.ok(collisionWarn, `expected a duplicate-alias warn; got: ${warnings.map((w) => w.msg).join(' | ')}`);
  });
});
