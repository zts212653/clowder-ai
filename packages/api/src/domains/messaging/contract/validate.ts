/**
 * Plugin Messaging input admission.
 *
 * Public row structure, Unicode-scalar admission, numeric bounds, and payload
 * budgets come from the published contract validator. This Host adapter keeps
 * only the two semantics that depend on Host authority or persisted-message
 * ordering and therefore cannot live in the transport schema.
 */

import type { AppendElementsRequest, MessageDraft, MessagingRowValidationError } from '@clowder-ai/plugin-contract';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import { MessagingError } from './host-types.js';

function fail(message: string): never {
  throw new MessagingError('VALIDATION', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeContractErrors(errors: readonly MessagingRowValidationError[]): string {
  return errors
    .map((error) => {
      const path = error.instancePath || 'input';
      if (error.keyword === 'additionalProperties') return `${path} contains unknown properties`;
      if (error.keyword === 'uniqueItems') return `${path} contains duplicate values`;
      return `${path} ${error.message}`;
    })
    .join('; ');
}

function rejectHostAuthorityInDraft(input: unknown): void {
  if (!isRecord(input)) return;
  if (isRecord(input.draftAudience) && input.draftAudience.kind === 'system') {
    fail('draftAudience kind "system" is host-only (INV-2)');
  }
  const payload = input.payload;
  if (!isRecord(payload) || !isRecord(payload.provenance)) return;
  if (isRecord(payload.provenance.origin) && payload.provenance.origin.kind === 'host') {
    fail('provenance.origin kind "host" cannot be declared by a draft (D-4)');
  }
}

function rejectDuplicateElementIds(elements: readonly { readonly elementId: string }[]): void {
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.elementId)) fail(`duplicate elementId "${element.elementId}"`);
    seen.add(element.elementId);
  }
}

/** Validate an untrusted draft against the contract plus Host-only semantics. */
export function validateDraft(input: unknown): MessageDraft {
  rejectHostAuthorityInDraft(input);
  const result = validateMessagingRowInput('messaging.send', input);
  if (!result.valid) fail(`messaging.send input failed contract validation: ${describeContractErrors(result.errors)}`);

  rejectDuplicateElementIds(result.value.payload.elements);
  const persistedElementIds = new Set<string>();
  for (const element of result.value.payload.elements) {
    if (element.derivedFromElementId !== undefined && !persistedElementIds.has(element.derivedFromElementId)) {
      fail(`derivedFromElementId "${element.derivedFromElementId}" must reference an earlier element in the draft`);
    }
    persistedElementIds.add(element.elementId);
  }
  return result.value;
}

/** Validate an untrusted appendElements input against the published contract. */
export function validateAppendInput(input: unknown): AppendElementsRequest {
  const result = validateMessagingRowInput('messaging.appendElements', input);
  if (!result.valid) {
    fail(`messaging.appendElements input failed contract validation: ${describeContractErrors(result.errors)}`);
  }
  rejectDuplicateElementIds(result.value.elements);
  return result.value;
}
