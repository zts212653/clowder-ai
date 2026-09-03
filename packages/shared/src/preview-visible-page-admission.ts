import { z } from 'zod';
import { canonicalizePreviewTargetPath } from './preview-gateway.js';

const fullGitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const boundedTextSchema = z.string().min(1).max(200);
const targetPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.startsWith('/'), {
    message: 'Target path must be absolute within the preview origin',
  });
const domAttributeNameSchema = z
  .string()
  .regex(/^(?:data|aria)-[a-z0-9][a-z0-9._:-]*$/)
  .max(100);

const domAttributesSchema = z.record(domAttributeNameSchema, z.string().max(200)).superRefine((attributes, context) => {
  if (Object.keys(attributes).length > 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At most 8 DOM attributes may be asserted' });
  }
});

export const previewVisiblePageDomAssertionSchema = z
  .object({
    selector: z.string().min(1).max(256),
    attributes: domAttributesSchema.optional(),
    textIncludes: z.array(boundedTextSchema).max(8).optional(),
  })
  .strict();

export const previewVisiblePageAdmissionSchema = z
  .object({
    expectedClientRevision: fullGitRevisionSchema,
    requiredDom: z.array(previewVisiblePageDomAssertionSchema).min(1).max(8),
    forbiddenText: z.array(boundedTextSchema).max(8).optional(),
  })
  .strict();

export const previewVisiblePageAttestationSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    targetPort: z.number().int().min(1).max(65535),
    targetOrigin: z.string().url().max(500),
    targetPath: targetPathSchema,
    clientRevision: fullGitRevisionSchema.nullable(),
    dom: z
      .array(
        z
          .object({
            selector: z.string().min(1).max(256),
            found: z.boolean(),
            attributes: z.record(domAttributeNameSchema, z.string().max(200).nullable()),
            textMatches: z.array(z.boolean()).max(8),
          })
          .strict(),
      )
      .max(8),
    forbiddenTextMatches: z.array(z.boolean()).max(8),
  })
  .strict();

export type PreviewVisiblePageDomAssertion = z.infer<typeof previewVisiblePageDomAssertionSchema>;
export type PreviewVisiblePageAdmission = z.infer<typeof previewVisiblePageAdmissionSchema>;
export type PreviewVisiblePageAttestation = z.infer<typeof previewVisiblePageAttestationSchema>;

export interface PreviewVisiblePageAdmissionVerdict {
  verified: boolean;
  mismatches: string[];
}

export function verifyPreviewVisiblePageAttestation(
  admission: PreviewVisiblePageAdmission,
  input: {
    eventId: string;
    targetPort: number;
    targetOrigin: string;
    targetPath: string;
    attestation: unknown;
  },
): PreviewVisiblePageAdmissionVerdict {
  const parsed = previewVisiblePageAttestationSchema.safeParse(input.attestation);
  if (!parsed.success) return { verified: false, mismatches: ['attestation_invalid'] };

  const attestation = parsed.data;
  const mismatches: string[] = [];
  if (attestation.eventId !== input.eventId) mismatches.push('event_id_mismatch');
  if (attestation.targetPort !== input.targetPort) mismatches.push('target_port_mismatch');
  if (attestation.targetOrigin !== input.targetOrigin) mismatches.push('target_origin_mismatch');
  if (attestation.targetPath !== canonicalizePreviewTargetPath(input.targetPath)) {
    mismatches.push('target_path_mismatch');
  }
  if (attestation.clientRevision !== admission.expectedClientRevision) {
    mismatches.push('client_revision_mismatch');
  }

  admission.requiredDom.forEach((expected, assertionIndex) => {
    const observed = attestation.dom[assertionIndex];
    if (!observed || observed.selector !== expected.selector) {
      mismatches.push(`dom_assertion_missing:${assertionIndex}`);
      return;
    }
    if (!observed.found) mismatches.push(`dom_selector_missing:${assertionIndex}`);
    for (const [attributeName, expectedValue] of Object.entries(expected.attributes ?? {})) {
      if (observed.attributes[attributeName] !== expectedValue) {
        mismatches.push(`dom_attribute_mismatch:${assertionIndex}:${attributeName}`);
      }
    }
    (expected.textIncludes ?? []).forEach((_text, textIndex) => {
      if (observed.textMatches[textIndex] !== true) {
        mismatches.push(`required_text_missing:${assertionIndex}:${textIndex}`);
      }
    });
  });

  (admission.forbiddenText ?? []).forEach((_text, textIndex) => {
    if (attestation.forbiddenTextMatches[textIndex] !== false) {
      mismatches.push(`forbidden_text_present:${textIndex}`);
    }
  });

  return { verified: mismatches.length === 0, mismatches };
}
