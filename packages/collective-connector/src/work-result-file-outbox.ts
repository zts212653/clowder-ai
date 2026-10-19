import type { CollectiveWorkResultFile, CollectiveWorkResultTextSource } from '@cat-cafe/shared';
import { participationError } from './participation-custody.js';
import type { ConnectorConnectionState, ConnectorOutboxItem, WorkResultArtifactSnapshot } from './state.js';
import { prepareWorkResultFilePublication, WorkResultFilePublicationError } from './work-result-publication.js';

export function prepareOutboxWorkResultFile(input: {
  readonly item: ConnectorOutboxItem;
  readonly connection: ConnectorConnectionState;
  readonly body: string;
  readonly artifactSnapshot?: WorkResultArtifactSnapshot;
  readonly resultFileSource?: CollectiveWorkResultTextSource;
}) {
  try {
    return prepareWorkResultFilePublication({
      outboxId: input.item.outboxId,
      serviceUrl: input.connection.serviceUrl,
      body: input.body,
      ...(input.artifactSnapshot ? { artifactSnapshot: input.artifactSnapshot } : {}),
      ...(input.resultFileSource ? { source: input.resultFileSource } : {}),
    });
  } catch (error) {
    if (error instanceof WorkResultFilePublicationError) throw participationError('RETURN_UNAVAILABLE', error.message);
    throw error;
  }
}

export function assertWorkResultFileAuthority(
  item: ConnectorOutboxItem,
  artifactSnapshot: WorkResultArtifactSnapshot | undefined,
  resultFile: CollectiveWorkResultFile | undefined,
): void {
  if (artifactSnapshot && !item.workPurpose)
    throw participationError('RETURN_UNAVAILABLE', 'Prepared Artifact does not belong to an admitted Work result');
  if (
    artifactSnapshot &&
    item.workPurpose &&
    (artifactSnapshot.taskRef !== item.workPurpose.taskRef ||
      artifactSnapshot.taskRevision !== item.workPurpose.admittedRevision)
  )
    throw participationError('RETURN_UNAVAILABLE', 'Prepared Artifact does not match the current Task revision');
  if (resultFile && (!item.workPurpose || !artifactSnapshot?.textPublication))
    throw participationError('RETURN_UNAVAILABLE', 'Published result file has no current Work Artifact authority');
}
