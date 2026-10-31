import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProtocolTemplate } from './types.js';
import { ProtocolTemplateSchema } from './types.js';

const templateCache = new Map<string, ProtocolTemplate>();

export function loadProtocolTemplate(yamlPath: string): ProtocolTemplate {
  const cached = templateCache.get(yamlPath);
  if (cached) return cached;

  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const template = ProtocolTemplateSchema.parse(parsed);
  templateCache.set(yamlPath, template);
  return template;
}

export function loadProtocolsFromDir(dir: string): Map<string, ProtocolTemplate> {
  const result = new Map<string, ProtocolTemplate>();
  if (!existsSync(dir)) return result;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const template = loadProtocolTemplate(join(dir, file));
    result.set(template.name, template);
  }
  return result;
}

export function clearTemplateCache(): void {
  templateCache.clear();
}
