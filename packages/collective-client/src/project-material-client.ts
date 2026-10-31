import type {
  CollectiveMaterialItem,
  collectiveMaterialListSchema,
  SortCollectiveMaterialRequest,
} from '@cat-cafe/shared';
import type { z } from 'zod';
import type { CollectiveRoadmapRecord } from './client-types.js';

type WithoutCoordinates<T> = T extends unknown
  ? Omit<T, 'serviceInstanceId' | 'collectiveId' | 'requestId' | 'materialId' | 'expectedRevision'>
  : never;
export type MaterialSortChange = WithoutCoordinates<SortCollectiveMaterialRequest>;
export type MaterialFeed = z.infer<typeof collectiveMaterialListSchema>;
export interface ProjectMaterialClient {
  readonly namespace: string;
  list(roadmapId: string): Promise<MaterialFeed>;
  connections(roadmapId: string): Promise<{ connectionId: string; label: string }[]>;
  publish(
    project: CollectiveRoadmapRecord,
    connectionId: string,
    provider: 'github' | 'feishu',
    sourceId: string,
  ): Promise<void>;
  sort(material: Pick<CollectiveMaterialItem, 'materialId' | 'revision'>, change: MaterialSortChange): Promise<void>;
}
