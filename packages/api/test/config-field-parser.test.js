import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getValueFields, parseConfigField, parseConfigFields } from '../dist/infrastructure/config-field-parser.js';

describe('config-field-parser', () => {
  // ── input fallback (no type) ───────────────────────────────────────

  it('no type field → fallback to input', () => {
    const field = parseConfigField({ envName: 'FOO', label: 'Foo', sensitive: false, required: true });
    assert.equal(field.type, 'input');
    assert.equal(field.envName, 'FOO');
  });

  it('explicit type: input', () => {
    const field = parseConfigField({
      type: 'input',
      envName: 'BAR',
      label: 'Bar',
      sensitive: true,
      required: false,
      hidden: true,
      default: 'val',
    });
    assert.equal(field.type, 'input');
    assert.equal(field.envName, 'BAR');
    assert.equal(field.sensitive, true);
    assert.equal(field.hidden, true);
    assert.equal(field.default, 'val');
  });

  // ── envName validation ─────────────────────────────────────────────

  it('rejects envName starting with _', () => {
    assert.throws(
      () => parseConfigField({ envName: '_RESERVED', label: 'X', required: true }),
      /Invalid envName.*cannot start with '_'/,
    );
  });

  it('rejects empty envName', () => {
    assert.throws(() => parseConfigField({ envName: '', label: 'X', required: true }), /envName is required/);
  });

  it('rejects envName with invalid chars', () => {
    assert.throws(
      () => parseConfigField({ envName: '123ABC', label: 'X', required: true }),
      /Invalid envName.*must be a valid shell variable name/,
    );
  });

  // ── toggle ─────────────────────────────────────────────────────────

  it('parses toggle field', () => {
    const field = parseConfigField({
      type: 'toggle',
      envName: 'ENABLE_WHITELIST',
      label: 'Whitelist',
      required: false,
      default: true,
      group: 'permissions',
    });
    assert.equal(field.type, 'toggle');
    assert.equal(field.envName, 'ENABLE_WHITELIST');
    assert.equal(field.default, true);
    assert.equal(field.group, 'permissions');
  });

  // ── select ─────────────────────────────────────────────────────────

  it('parses select field with options', () => {
    const field = parseConfigField({
      type: 'select',
      envName: 'MODE',
      label: 'Mode',
      required: true,
      options: [
        { value: 'webhook', label: 'Webhook' },
        { value: 'ws', label: 'WebSocket' },
      ],
      default: 'webhook',
    });
    assert.equal(field.type, 'select');
    assert.equal(field.options.length, 2);
    assert.equal(field.default, 'webhook');
  });

  it('rejects select without options', () => {
    assert.throws(
      () => parseConfigField({ type: 'select', envName: 'S', label: 'S', required: true }),
      /must have non-empty options/,
    );
  });

  it('ignores select default not in options', () => {
    const field = parseConfigField({
      type: 'select',
      envName: 'S',
      label: 'S',
      required: true,
      options: [{ value: 'a', label: 'A' }],
      default: 'invalid',
    });
    assert.equal(field.default, undefined);
  });

  // ── list ───────────────────────────────────────────────────────────

  it('parses list field', () => {
    const field = parseConfigField({
      type: 'list',
      envName: 'ADMIN_IDS',
      label: 'Admins',
      required: false,
      itemLabel: 'Open ID',
      default: ['id1', 'id2'],
      group: 'permissions',
    });
    assert.equal(field.type, 'list');
    assert.equal(field.itemLabel, 'Open ID');
    assert.deepEqual(field.default, ['id1', 'id2']);
    assert.equal(field.group, 'permissions');
  });

  // ── operation ──────────────────────────────────────────────────────

  it('parses operation field with actions', () => {
    const field = parseConfigField({
      type: 'operation',
      name: 'weixin_qr_login',
      label: 'QR Login',
      required: false,
      target: ['WEIXIN_BOT_TOKEN'],
      actions: [
        { id: 'qr-generate', label: 'Generate', render: 'button', resultRender: 'img', next: 'qr-status' },
        { id: 'qr-status', label: 'Wait', render: 'polling', timeout: 60, rollback: 'qr-generate', next: 'done' },
      ],
    });
    assert.equal(field.type, 'operation');
    assert.equal(field.name, 'weixin_qr_login');
    assert.deepEqual(field.target, ['WEIXIN_BOT_TOKEN']);
    assert.equal(field.actions.length, 2);
    assert.equal(field.actions[0].resultRender, 'img');
    assert.equal(field.actions[1].timeout, 60);
    assert.equal(field.actions[1].rollback, 'qr-generate');
  });

  it('rejects operation without name', () => {
    assert.throws(
      () => parseConfigField({ type: 'operation', label: 'Op', required: false, actions: [{ id: 'a' }] }),
      /missing name/,
    );
  });

  it('rejects operation without actions', () => {
    assert.throws(
      () => parseConfigField({ type: 'operation', name: 'op', label: 'Op', required: false }),
      /must have non-empty actions/,
    );
  });

  // ── unknown type ───────────────────────────────────────────────────

  it('rejects unknown field type', () => {
    assert.throws(
      () => parseConfigField({ type: 'custom', envName: 'X', label: 'X', required: true }),
      /unknown config field type 'custom'/,
    );
  });

  // ── batch parse ────────────────────────────────────────────────────

  it('parseConfigFields handles mixed array', () => {
    const fields = parseConfigFields([
      { envName: 'A', label: 'A', required: true },
      { type: 'toggle', envName: 'B', label: 'B', required: false },
      { type: 'operation', name: 'op', label: 'Op', required: false, actions: [{ id: 'a', render: 'button' }] },
    ]);
    assert.equal(fields.length, 3);
    assert.equal(fields[0].type, 'input');
    assert.equal(fields[1].type, 'toggle');
    assert.equal(fields[2].type, 'operation');
  });

  // ── getValueFields ─────────────────────────────────────────────────

  it('getValueFields filters out operations', () => {
    const fields = parseConfigFields([
      { envName: 'A', label: 'A', required: true },
      { type: 'operation', name: 'op', label: 'Op', required: false, actions: [{ id: 'a', render: 'button' }] },
      { type: 'toggle', envName: 'B', label: 'B', required: false },
    ]);
    const values = getValueFields(fields);
    assert.equal(values.length, 2);
    assert.equal(values[0].envName, 'A');
    assert.equal(values[1].envName, 'B');
  });

  // ── requiredWhen ───────────────────────────────────────────────────

  it('parses requiredWhen on input', () => {
    const field = parseConfigField({
      type: 'input',
      envName: 'TOKEN',
      label: 'Token',
      sensitive: true,
      required: false,
      requiredWhen: { envName: 'MODE', value: 'webhook' },
    });
    assert.equal(field.type, 'input');
    assert.deepEqual(field.requiredWhen, { envName: 'MODE', value: 'webhook' });
  });
});
