import { after, before } from 'node:test';
import { registerOrdinaryEntryJourneys } from './f309-ordinary-workspace-journey-entries.mjs';
import { registerOrdinaryImageJourney } from './f309-ordinary-workspace-journey-image.mjs';
import { registerOrdinaryModificationJourney } from './f309-ordinary-workspace-journey-modification.mjs';
import { registerOrdinaryOwnerJourney } from './f309-ordinary-workspace-journey-owner.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';
import { registerOrdinaryTextQuoteJourney } from './f309-ordinary-workspace-journey-text-quote.mjs';
import { registerOrdinaryVideoJourney } from './f309-ordinary-workspace-journey-video.mjs';
import { registerOrdinaryVideoModificationJourney } from './f309-ordinary-workspace-journey-video-modification.mjs';

let suite;

before(async () => {
  suite = await startF309OrdinaryWorkspaceJourney();
});

after(async () => {
  await stopF309OrdinaryWorkspaceJourney(suite);
});

registerOrdinaryImageJourney(() => suite);
registerOrdinaryModificationJourney(() => suite);
registerOrdinaryVideoJourney(() => suite);
registerOrdinaryVideoModificationJourney(() => suite);
registerOrdinaryOwnerJourney(() => suite);
registerOrdinaryEntryJourneys(() => suite);
registerOrdinaryTextQuoteJourney(() => suite);
