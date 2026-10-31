import { createContext, type ReactNode, useContext, useState } from 'react';
import type { CollectiveRecipient } from './client-types.js';
import type {
  SharedArtifactDraftReply,
  SharedArtifactDraftRework,
  SharedArtifactDraftSelection,
} from './shared-artifact-draft.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactRead } from './use-shared-artifact-read.js';

function useReading() {
  const shared = useSharedArtifacts();
  const artifact = shared?.catalogue.find((item) => item.artifactId === shared.selected?.artifactId);
  const reading = useSharedArtifactRead(
    shared?.api,
    artifact,
    shared?.selected?.ownerRevision,
    shared?.status,
    shared?.refresh,
  );
  const [quote, setQuote] = useState<SharedArtifactDraftSelection>();
  const [reply, setReply] = useState<SharedArtifactDraftReply>();
  const [rework, setRework] = useState<
    SharedArtifactDraftRework & { recipient?: CollectiveRecipient; label?: string }
  >();
  return { ...reading, artifact, quote, setQuote, rework, setRework, reply, setReply };
}
const ReadingContext = createContext<ReturnType<typeof useReading> | undefined>(undefined);
export const useSharedArtifactReading = () => useContext(ReadingContext);
export function SharedArtifactReading({ children }: { readonly children: ReactNode }) {
  return <ReadingContext.Provider value={useReading()}>{children}</ReadingContext.Provider>;
}
