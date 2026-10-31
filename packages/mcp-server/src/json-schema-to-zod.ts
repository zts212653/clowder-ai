/**
 * JSON Schema → Zod v3 Converter
 *
 * MCP SDK 1.26.0 expects inputSchema to be a Zod schema instance (v3 or v4).
 * Plain JSON Schema objects crash at TWO points:
 *   1. Tool listing:  normalizeObjectSchema() → can't find .shape → empty schema
 *   2. Tool call:     safeParseAsync(plainObj, args) → "v3Schema.safeParseAsync is not a function"
 *
 * This converter turns our plain JSON Schema definitions into Zod v3 schemas
 * at registration time, giving the SDK what it needs at both listing and call time.
 */

import { z } from 'zod';

function jsonPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const propType = prop.type as string | undefined;
  let schema: z.ZodTypeAny;

  switch (propType) {
    case 'string':
      if (Array.isArray(prop.enum) && prop.enum.length > 0) {
        schema = z.enum(prop.enum as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    case 'number':
    case 'integer':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'array':
      schema = z.array(
        prop.items && typeof prop.items === 'object'
          ? jsonPropertyToZod(prop.items as Record<string, unknown>)
          : z.unknown(),
      );
      break;
    case 'object':
      schema = z.record(z.string(), z.unknown());
      break;
    default:
      schema = z.unknown();
  }

  if (typeof prop.description === 'string') {
    schema = schema.describe(prop.description);
  }

  return schema;
}

/**
 * Convert a plain JSON Schema object to a Zod v3 object schema.
 *
 * Handles the subset of JSON Schema used by our tool definitions:
 *   { type: 'object', properties: {...}, required?: [...] }
 */
export function jsonSchemaToZod(jsonSchema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    return z.object({});
  }

  const requiredSet = new Set(Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : []);

  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    const zodProp = jsonPropertyToZod(prop);
    shape[key] = requiredSet.has(key) ? zodProp : zodProp.optional();
  }

  return z.object(shape);
}
