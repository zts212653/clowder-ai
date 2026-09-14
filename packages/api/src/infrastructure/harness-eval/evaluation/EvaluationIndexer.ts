import type { TraceAnnotation } from '@cat-cafe/shared';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { type EvaluationCatalog, validateEvaluationCoordinate } from './evaluation-catalog.js';

/** Deterministic projection only; semantic classification belongs to producers. */
export class EvaluationIndexer {
  constructor(
    private readonly catalog: EvaluationCatalog,
    private readonly annotations: TraceAnnotationStore,
  ) {}

  async append(annotation: TraceAnnotation): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
    const error = validateEvaluationCoordinate(this.catalog, annotation);
    if (error) throw new Error(`invalid_evaluation_coordinate:${error}`);
    return this.annotations.append(annotation);
  }
}
