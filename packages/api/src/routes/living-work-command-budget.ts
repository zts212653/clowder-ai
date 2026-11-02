import { MAX_WORK_COMMAND_BYTES } from '@cat-cafe/shared';

type InputError = 'work_command_too_large' | 'invalid_request';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function workCommandInputError(body: unknown, wireBytes: number): InputError | undefined {
  // Classification must not construct Zod issues (even an invalid enum value
  // can be a huge string). Read only the discriminator and HTML value's type.
  const input = record(body);
  const command = record(input?.command);
  const source = record(command?.source);
  if (
    !input ||
    !command ||
    !source ||
    (command.action !== 'create' && command.action !== 'submit') ||
    source.kind !== 'html' ||
    typeof source.html !== 'string'
  ) {
    return wireBytes > MAX_WORK_COMMAND_BYTES ? 'work_command_too_large' : undefined;
  }
  // HTML cannot carry video review responses. Reject before Zod expands them.
  if (Object.hasOwn(command, 'reviewResponse')) return 'invalid_request';

  let remaining = MAX_WORK_COMMAND_BYTES;
  function spend(value: string | number | boolean | null): boolean {
    // Avoid serializing a huge scalar/key just to discover it exceeds the cap.
    if (typeof value === 'string' && value.length > remaining) return false;
    remaining -= Buffer.byteLength(JSON.stringify(value));
    return remaining >= 0;
  }
  function inspectValue(key: string, value: unknown, depth: number): InputError | undefined {
    if (key === ['command', 'source'][depth]) return inspect(value as Record<string, unknown>, depth + 1);
    // Only this value receives the large allowance; count its empty slot.
    if (depth === 2 && key === 'html') return spend('') ? undefined : 'work_command_too_large';
    // All HTML metadata is scalar. No legal HTML input needs another
    // container, so reject it without enumerating its children. Recursion
    // is limited to the envelope, command and source objects.
    if (value !== null && typeof value === 'object') return 'invalid_request';
    return spend(value as string | number | boolean | null) ? undefined : 'work_command_too_large';
  }
  function inspect(object: Record<string, unknown>, depth: number): InputError | undefined {
    remaining -= 2; // braces
    let punctuation = 1; // first colon; subsequent fields also need a comma
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      remaining -= punctuation;
      punctuation = 2;
      if (!spend(key)) return 'work_command_too_large';
      const error = inspectValue(key, object[key], depth);
      if (error) return error;
    }
    return remaining < 0 ? 'work_command_too_large' : undefined;
  }
  return inspect(input, 0);
}
