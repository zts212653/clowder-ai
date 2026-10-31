// F152 Phase C: Deidentification service for global lesson distillation (AC-C4)
// Removes project-specific identifiers before knowledge reflows to global layer.

import type { EvidenceItem } from './interfaces.js';

export interface DeidentifiedEvidence {
  original: EvidenceItem;
  sanitizedTitle: string;
  sanitizedSummary: string;
  sanitizedKeywords: string[];
  removedPatterns: string[];
}

export interface DeidentificationOptions {
  personNames?: string[];
}

export class DeidentificationService {
  private readonly projectPath: string;
  private readonly projectName: string;
  private readonly personNames: string[];

  constructor(projectPath: string, options?: DeidentificationOptions) {
    this.projectPath = projectPath;
    this.projectName = projectPath.split('/').filter(Boolean).pop() ?? '';
    this.personNames = options?.personNames ?? [];
  }

  sanitize(item: EvidenceItem): DeidentifiedEvidence {
    const removedPatterns: string[] = [];

    const sanitizeText = (text: string): string => {
      let result = text;

      // Replace full project path
      if (this.projectPath && result.includes(this.projectPath)) {
        removedPatterns.push(this.projectPath);
        result = result.replaceAll(this.projectPath, '[PROJECT]');
      }

      // Replace project directory name (case-sensitive, word boundary)
      if (this.projectName) {
        const nameRegex = new RegExp(`\\b${escapeRegex(this.projectName)}\\b`, 'g');
        if (nameRegex.test(result)) {
          removedPatterns.push(this.projectName);
          result = result.replace(nameRegex, '[PROJECT]');
        }
      }

      // Replace URLs
      const urlRegex = /https?:\/\/[^\s),]+/g;
      const urls = result.match(urlRegex);
      if (urls) {
        for (const url of urls) {
          removedPatterns.push(url);
        }
        result = result.replace(urlRegex, '[URL]');
      }

      // Replace person names from blocklist (word-boundary, case-insensitive)
      for (const name of this.personNames) {
        const personRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
        if (personRegex.test(result)) {
          removedPatterns.push(name);
          result = result.replace(personRegex, '[PERSON]');
        }
      }

      // Replace email-like patterns
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      const emails = result.match(emailRegex);
      if (emails) {
        for (const email of emails) {
          removedPatterns.push(email);
        }
        result = result.replace(emailRegex, '[EMAIL]');
      }

      // Replace @handle patterns (e.g. @username)
      const handleRegex = /@[A-Za-z0-9_-]{2,}/g;
      const handles = result.match(handleRegex);
      if (handles) {
        for (const handle of handles) {
          removedPatterns.push(handle);
        }
        result = result.replace(handleRegex, '[HANDLE]');
      }

      return result;
    };

    const sanitizedTitle = sanitizeText(item.title);
    const sanitizedSummary = item.summary ? sanitizeText(item.summary) : '';

    const sanitizedKeywords = (item.keywords ?? [])
      .map((kw) => {
        const sanitized = sanitizeText(kw);
        return sanitized === '[PROJECT]' || sanitized === '[URL]' ? null : sanitized;
      })
      .filter((kw): kw is string => kw != null);

    return {
      original: item,
      sanitizedTitle,
      sanitizedSummary,
      sanitizedKeywords,
      removedPatterns: [...new Set(removedPatterns)],
    };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
