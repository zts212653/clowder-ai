import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { liveInitialItems, liveRealtimePrompt } from '../live-conversation-context.js';

export function startLiveRealtime(input: {
  client: CodexLiveNativeClient;
  nativeThreadId: string;
  offer: string;
  conversation: string;
  catId: string;
  householdToolsEnabled?: boolean;
  compositionInstructions?: string;
}): Promise<unknown> {
  return input.client.request('thread/realtime/start', {
    threadId: input.nativeThreadId,
    version: 'v3',
    transport: { type: 'webrtc', sdp: input.offer },
    outputModality: 'audio',
    includeStartupContext: false,
    clientManagedHandoffs: false,
    codexResponseHandoffMode: 'commentary',
    prompt: liveRealtimePrompt({
      catId: input.catId,
      householdToolsEnabled: input.householdToolsEnabled,
      compositionInstructions: input.compositionInstructions,
    }),
    initialItems: liveInitialItems(input.conversation),
  });
}
