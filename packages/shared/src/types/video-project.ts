import { videoProjectDocumentBaseSchema } from './video-project-document.js';
import { refineVideoProjectReferences } from './video-project-references.js';

export const videoProjectDocumentSchema = videoProjectDocumentBaseSchema.superRefine(refineVideoProjectReferences);
export * from './video-project-check-definition.js';
export type { VideoProjectDocumentV1 } from './video-project-document.js';
export * from './video-project-editing.js';
export * from './video-project-primitives.js';
export * from './video-project-screening.js';
export * from './video-project-screening-frame.js';
export * from './video-project-screening-time.js';
export * from './video-project-self-review.js';
export * from './video-project-settings.js';
export * from './video-project-timeline.js';
