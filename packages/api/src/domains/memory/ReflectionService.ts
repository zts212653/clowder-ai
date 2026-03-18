// F102: IReflectionService — LLM reflection, independent of storage

import type { IReflectionService, ReflectionContext } from './interfaces.js';

export type ReflectBackend = (query: string, context?: ReflectionContext) => Promise<string>;

export class ReflectionService implements IReflectionService {
  constructor(private readonly backend: ReflectBackend) {}

  async reflect(query: string, context?: ReflectionContext): Promise<string> {
    try {
      return await this.backend(query, context);
    } catch {
      // Degrade gracefully — reflection is non-critical
      return '';
    }
  }
}
