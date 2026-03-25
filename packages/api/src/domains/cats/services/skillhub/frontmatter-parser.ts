/**
 * SKILL.md Frontmatter 解析器
 *
 * 从 SKILL.md 文件的 YAML frontmatter 中提取 name、description、triggers。
 * 用于远程安装的 skill（不在 manifest.yaml 中），从其自身元数据补充信息。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillFrontmatterMeta {
  name?: string;
  description?: string;
  triggers?: string[];
}

/**
 * 解析指定目录中 SKILL.md 的 YAML frontmatter。
 * 文件不存在或 frontmatter 无效时返回空对象。
 */
export async function parseSkillFrontmatter(skillDir: string): Promise<SkillFrontmatterMeta> {
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    return parseFrontmatterString(content);
  } catch {
    return {};
  }
}

/**
 * 从 SKILL.md 内容字符串中解析 frontmatter。
 * 导出供测试和其他模块直接使用。
 * 无 frontmatter 时，尝试提取第一个 heading 作为 description 回退。
 */
export function parseFrontmatterString(content: string): SkillFrontmatterMeta {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) {
    // 无 frontmatter：提取第一个 heading 作为 description
    const headingMatch = content.match(/^#+\s+(.+)/m);
    if (headingMatch?.[1]) {
      return { description: headingMatch[1].trim() };
    }
    // 回退到前 80 个字符
    const firstLine = content.trim().split('\n')[0]?.trim();
    if (firstLine) {
      return { description: firstLine.slice(0, 80) };
    }
    return {};
  }

  try {
    const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};

    const meta: SkillFrontmatterMeta = {};

    if (typeof parsed['name'] === 'string') {
      meta.name = parsed['name'];
    }

    if (typeof parsed['description'] === 'string') {
      meta.description = parsed['description'].trim();
    }

    if (Array.isArray(parsed['triggers'])) {
      meta.triggers = parsed['triggers']
        .filter((v): v is string => typeof v === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return meta;
  } catch {
    return {};
  }
}
