/**
 * F208 Phase C: Dossier API Routes
 *
 * GET /api/dossier — Returns capability profiles grouped by model (KD-15).
 *
 * KD-15: 画像描述的是 model 认知能力，catId 是索引便利。
 * API 在这一层做 join（dossier × cat-config model），前端不需要关心映射逻辑。
 */

import { catRegistry } from '@cat-cafe/shared';
import type { DossierProfile } from '@cat-cafe/shared/dossier';
import { loadDossierProfiles } from '@cat-cafe/shared/dossier';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface DossierRoutesOptions {
  projectRoot?: string;
}

interface ModelGroup {
  model: string;
  cats: Array<{
    catId: string;
    displayName: string;
    nickname?: string;
    family?: string;
    runtime?: string;
    dossier: DossierProfile | null;
  }>;
}

interface DossierResponse {
  modelGroups: ModelGroup[];
  meta: {
    totalCats: number;
    totalModels: number;
    dossierCoverage: number;
  };
}

export const dossierRoutes: FastifyPluginAsync<DossierRoutesOptions> = async (app: FastifyInstance, opts) => {
  app.get('/api/dossier', async (_request, _reply): Promise<DossierResponse> => {
    const projectRoot = opts.projectRoot ?? process.cwd();
    const dossierProfiles = loadDossierProfiles(projectRoot);
    const allConfigs = catRegistry.getAllConfigs();
    const catIds = Object.keys(allConfigs);

    // Build catId → model mapping from persisted config (not runtime env overrides — P1 fix)
    const catModelMap = new Map<string, string>();
    for (const catId of catIds) {
      const cfg = allConfigs[catId];
      catModelMap.set(catId, cfg.defaultModel || 'unknown');
    }

    // Group by model (KD-15)
    const modelToCats = new Map<string, ModelGroup['cats']>();
    for (const catId of catIds) {
      const model = catModelMap.get(catId) ?? 'unknown';
      const config = allConfigs[catId];
      const dossier = dossierProfiles.get(catId) ?? null;

      if (!modelToCats.has(model)) {
        modelToCats.set(model, []);
      }
      modelToCats.get(model)!.push({
        catId,
        displayName: config.displayName ?? config.name,
        nickname: config.nickname,
        family: config.breedId,
        runtime: config.clientId,
        dossier,
      });
    }

    // Sort model groups: models with more cats first, then alphabetical
    const modelGroups: ModelGroup[] = Array.from(modelToCats.entries())
      .sort(([a, catsA], [b, catsB]) => {
        if (catsB.length !== catsA.length) return catsB.length - catsA.length;
        return a.localeCompare(b);
      })
      .map(([model, cats]) => ({ model, cats }));

    // Compute coverage
    const catsWithDossier = catIds.filter((id) => dossierProfiles.has(id)).length;

    return {
      modelGroups,
      meta: {
        totalCats: catIds.length,
        totalModels: modelToCats.size,
        dossierCoverage: catIds.length > 0 ? catsWithDossier / catIds.length : 0,
      },
    };
  });
};
