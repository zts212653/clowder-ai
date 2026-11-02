import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set([
  'items',
  'additionalItems',
  'contains',
  'additionalProperties',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
]);

function portablePatterns(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([keyword, value]) => {
      if (keyword === 'pattern' && typeof value === 'string') {
        // Consume escape pairs so an escaped backslash stays literal. Hex escapes
        // preserve these identity escapes both inside and outside character classes.
        return [
          keyword,
          value.replace(/\\([\s\S])/g, (escapedPair: string, char: string) =>
            char === '-' ? '\\x2d' : char === ':' ? '\\x3a' : escapedPair,
          ),
        ];
      }
      if (schemaMaps.has(keyword) && value && typeof value === 'object' && !Array.isArray(value)) {
        return [
          keyword,
          Object.fromEntries(Object.entries(value).map(([name, child]) => [name, portablePatterns(child)])),
        ];
      }
      if ((schemaArrays.has(keyword) || keyword === 'items') && Array.isArray(value)) {
        return [keyword, value.map(portablePatterns)];
      }
      return [keyword, schemaChildren.has(keyword) ? portablePatterns(value) : value];
    }),
  );
}

/** Equivalent regex syntax for every shared HTTP consumer; tool payloads stay opaque. */
export function portableToolList(message: JSONRPCMessage): JSONRPCMessage {
  if (!('result' in message) || !Array.isArray(message.result.tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
        return Object.fromEntries(
          Object.entries(tool).map(([key, value]) => [
            key,
            key === 'inputSchema' || key === 'outputSchema' ? portablePatterns(value) : value,
          ]),
        );
      }),
    },
  };
}
