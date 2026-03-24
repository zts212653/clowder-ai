/**
 * F088 Phase J2: Pandoc-based document generation service.
 *
 * Converts Markdown content to PDF/DOCX via the `pandoc` CLI.
 * Graceful degradation: if pandoc is not installed, falls back to saving raw .md files.
 *
 * Tech decision: Pandoc CLI over JS libraries (puppeteer/pdf-lib/docx).
 * Rationale: cats output Markdown natively, Pandoc's md→pdf/docx is first-class.
 * Confirmed by CVO 2026-03-23.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';

const execFileAsync = promisify(execFile);

export type DocumentFormat = 'pdf' | 'docx' | 'md';

export interface GeneratedDocument {
  /** Absolute path to the generated file */
  absPath: string;
  /** Display name for the file (e.g. "调研报告.pdf") */
  fileName: string;
  /** MIME type */
  mimeType: string;
  /** Actual format generated (may differ from requested if pandoc unavailable) */
  format: DocumentFormat;
}

const MIME_TYPES: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
};

/** Timeout for pandoc conversion (30 seconds) */
const PANDOC_TIMEOUT_MS = 30_000;

export class PandocService {
  private pandocAvailable: boolean | null = null;
  private readonly log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  /**
   * Check if pandoc is available on the system.
   * Result is cached after first check.
   */
  async isPandocAvailable(): Promise<boolean> {
    if (this.pandocAvailable !== null) return this.pandocAvailable;
    try {
      const { stdout } = await execFileAsync('pandoc', ['--version'], { timeout: 5_000 });
      const version = stdout.split('\n')[0] ?? 'unknown';
      this.log.info({ version }, '[PandocService] pandoc detected');
      this.pandocAvailable = true;
    } catch {
      this.log.warn('[PandocService] pandoc not found — document generation will fall back to .md');
      this.pandocAvailable = false;
    }
    return this.pandocAvailable;
  }

  /**
   * Generate a document from Markdown content.
   *
   * @param markdown - The Markdown content to convert
   * @param baseName - Base name for the output file (without extension)
   * @param format - Desired output format (pdf, docx, md)
   * @returns Generated document info, or null on failure
   *
   * If pandoc is unavailable and format is pdf/docx, automatically degrades to .md.
   */
  async generate(markdown: string, baseName: string, format: DocumentFormat): Promise<GeneratedDocument | null> {
    const safeBaseName = baseName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
    // P1-2: use randomBytes instead of Date.now() to prevent concurrent collision
    const nonce = randomBytes(6).toString('hex');

    // MD is always available — no pandoc needed
    if (format === 'md') {
      return this.saveMd(markdown, safeBaseName, nonce);
    }

    const hasPandoc = await this.isPandocAvailable();
    if (!hasPandoc) {
      this.log.warn({ requestedFormat: format }, '[PandocService] pandoc unavailable, degrading to .md');
      return this.saveMd(markdown, safeBaseName, nonce);
    }

    return this.convertWithPandoc(markdown, safeBaseName, nonce, format);
  }

  private async saveMd(markdown: string, baseName: string, nonce: string): Promise<GeneratedDocument> {
    const fileName = `${baseName}.md`;
    const absPath = join(tmpdir(), `cat-cafe-doc-${baseName}-${nonce}.md`);
    await writeFile(absPath, markdown, 'utf-8');
    this.log.info({ absPath, fileName }, '[PandocService] saved .md file');
    return { absPath, fileName, mimeType: MIME_TYPES.md, format: 'md' };
  }

  private async convertWithPandoc(
    markdown: string,
    baseName: string,
    nonce: string,
    format: 'pdf' | 'docx',
  ): Promise<GeneratedDocument | null> {
    const inputPath = join(tmpdir(), `cat-cafe-doc-${baseName}-${nonce}.md`);
    const outputPath = join(tmpdir(), `cat-cafe-doc-${baseName}-${nonce}.${format}`);
    const fileName = `${baseName}.${format}`;

    try {
      // Write markdown to temp file (pandoc reads from file, not stdin, for reliability)
      await writeFile(inputPath, markdown, 'utf-8');

      const args = [inputPath, '-o', outputPath, '--standalone'];
      // PDF needs a LaTeX engine; prefer tectonic (lighter) or fall through to default
      if (format === 'pdf') {
        args.push('--pdf-engine=tectonic');
      }

      await execFileAsync('pandoc', args, { timeout: PANDOC_TIMEOUT_MS });

      this.log.info({ inputPath, outputPath, format, fileName }, '[PandocService] conversion success');
      return { absPath: outputPath, fileName, mimeType: MIME_TYPES[format], format };
    } catch (err) {
      this.log.warn({ err, format, baseName }, '[PandocService] pandoc conversion failed');

      // If PDF fails (e.g. no LaTeX engine), try degrading to docx, then md
      if (format === 'pdf') {
        this.log.info('[PandocService] PDF failed, attempting DOCX fallback');
        const docxResult = await this.convertWithPandoc(markdown, baseName, nonce, 'docx');
        if (docxResult) return docxResult;
      }

      // Final fallback: save as .md
      this.log.warn('[PandocService] all conversions failed, saving as .md');
      return this.saveMd(markdown, baseName, nonce);
    } finally {
      // Clean up input temp file
      await unlink(inputPath).catch(() => {});
    }
  }

  /** Reset cached pandoc availability (for testing) */
  _resetCache(): void {
    this.pandocAvailable = null;
  }

  /** Override pandoc availability (for testing) */
  _setAvailable(available: boolean): void {
    this.pandocAvailable = available;
  }
}
