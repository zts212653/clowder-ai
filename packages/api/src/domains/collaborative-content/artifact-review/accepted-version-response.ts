import {
  type MessageMediaPublicationSource,
  messageMediaPublicationSourceSchema,
  type RespondWithMediaVersion,
  respondWithMediaVersionSchema,
} from '@cat-cafe/shared';

// Internal accepted intent: the server's source selector survives reservation and recovery.
// Callback inputs continue to use the strict public respondWithMediaVersionSchema.
export const acceptedVersionSchema = respondWithMediaVersionSchema.extend({
  publicationSource: messageMediaPublicationSourceSchema.optional(),
});
export type AcceptedVersion = RespondWithMediaVersion & { publicationSource?: MessageMediaPublicationSource };
