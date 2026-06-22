/**
 * F168 Phase D D0.5 — Re-export from @cat-cafe/shared
 *
 * The canonical parseRouteRecommendation validator now lives in
 * @cat-cafe/shared so both API and web use the same seam.
 * This file re-exports for backward compatibility with existing API imports.
 */

export type { ParseRouteRecommendationResult } from '@cat-cafe/shared';
export { parseRouteRecommendation } from '@cat-cafe/shared';
