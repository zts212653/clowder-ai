import { z } from 'zod';

const publicObjectId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

export const collectiveWorkIdSchema = publicObjectId('work_');
export const collectiveRoadmapIdSchema = publicObjectId('roadmap_');
export const collectiveWorkAccountabilityRequestIdSchema = publicObjectId('accountability_');
