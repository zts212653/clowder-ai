import { type BackgroundOpacityJob, readableOpacityFor } from './background-opacity-job';

self.onmessage = (event: MessageEvent<BackgroundOpacityJob>) => {
  self.postMessage(readableOpacityFor(event.data));
};
