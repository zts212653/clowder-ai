import assert from 'node:assert/strict';
import test from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { portableToolList } from '../src/portable-tool-schema.js';

test('portable tools/list preserves schema constraints, data and regex meaning', () => {
  const pattern = String.raw`^collective\-attachment\:[a\-z]+\\-\:$`;
  const original = {
    jsonrpc: '2.0',
    id: 3,
    result: {
      nextCursor: 'next',
      _meta: { revision: 2 },
      tools: [
        {
          name: 'arbitrary_plugin',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            required: ['pattern'],
            additionalProperties: false,
            properties: { pattern: { type: 'string', pattern, minLength: 3 } },
            $defs: { item: { anyOf: [{ type: 'string', pattern }, { type: 'null' }] } },
            items: [{ type: 'string', pattern }],
            default: { pattern },
            examples: [{ pattern }],
            enum: [{ pattern }],
          },
          outputSchema: { type: 'object', properties: { result: { type: 'string', pattern } } },
        },
      ],
    },
  } satisfies JSONRPCMessage;
  const before = structuredClone(original);
  const expected = structuredClone(original);
  const portable = String.raw`^collective\x2dattachment\x3a[a\x2dz]+\\-\x3a$`;
  expected.result.tools[0].inputSchema.properties.pattern.pattern = portable;
  expected.result.tools[0].inputSchema.$defs.item.anyOf[0].pattern = portable;
  expected.result.tools[0].inputSchema.items[0].pattern = portable;
  expected.result.tools[0].outputSchema.properties.result.pattern = portable;
  assert.deepEqual(portableToolList(original), expected);
  assert.deepEqual(original, before);
  for (const value of ['collective-attachment:a-za\\-:', 'collective-attachment:b\\-:', 'other:a\\-:']) {
    assert.equal(new RegExp(pattern).test(value), new RegExp(portable, 'u').test(value), value);
  }
});

test('non-list results and errors stay unchanged', () => {
  for (const message of [
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: String.raw`\-\:` }] } },
    { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'original failure' } },
  ] satisfies JSONRPCMessage[])
    assert.equal(portableToolList(message), message);
});
