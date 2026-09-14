/**
 * Hook-backed segment source for the prompt injection Console (F237 Phase 2,
 * F257 reload-aware).
 *
 * Single truth: the prompt pipeline's shared HookRegistry. There is no private
 * scan cache here — a governance `add` writes a hook directory and the executor
 * calls `resetPipelineSingleton()`, and every Console route that reads through
 * this module observes the new segment at once. (A private registry in this
 * file once made a freshly listed segment open as 404 until restart.)
 *
 * Segments in TEMPLATE_FILES keep their base/local-overlay semantics; hook-only
 * segments (governance-added) read the registry's template file.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { HookManifest, HookVariableDef } from '@cat-cafe/shared';
import { getTemplateFileInfo, getTemplateRawContent } from '../domains/cats/services/context/prompt-template-loader.js';
import { getOrCreateRegistry } from '../domains/prompt-hooks/PipelinePromptBuilder.js';

/** Canonical hook manifest for a hook-registered segment, or null. */
export function getHookManifest(id: string): HookManifest | null {
  return getOrCreateRegistry().getHook(id)?.manifest ?? null;
}

/** Canonical variable definitions for a hook-registered segment, or null. */
export function getHookVariableDefs(id: string): HookVariableDef[] | null {
  const hook = getOrCreateRegistry().getHook(id);
  return hook ? (hook.manifest.variables ?? []) : null;
}

/** Source text of a hook-registered segment's template file, or null. */
export function readHookTemplateContent(id: string): string | null {
  const hook = getOrCreateRegistry().getHook(id);
  if (!hook || !existsSync(hook.templatePath)) return null;
  return readFileSync(hook.templatePath, 'utf-8');
}

/**
 * Source text for any Console segment. `useOverride` selects the local overlay
 * and only applies to TEMPLATE_FILES entries; hook-only segments have no overlay
 * and always return their registry template.
 */
export function readSegmentSource(id: string, useOverride: boolean): string | null {
  return getTemplateFileInfo(id) ? getTemplateRawContent(id, useOverride) : readHookTemplateContent(id);
}
