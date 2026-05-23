/**
 * File Tools
 * MCP 文件操作工具
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ensureDir, isPathAllowed } from '../utils/path-validator.js';

/**
 * MCP 工具返回结果类型
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * 创建错误结果
 */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * 创建成功结果
 */
export function successResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

// ============ Tool Input Schemas ============

export const readFileInputSchema = {
  path: z.string().describe('The path to the file to read'),
};

export const readFileSliceInputSchema = {
  path: z.string().describe('The path to the file to read'),
  startLine: z.number().int().min(1).describe('1-based first line to include'),
  endLine: z.number().int().min(1).optional().describe('1-based final line to include; defaults to a bounded window'),
};

export const writeFileInputSchema = {
  path: z.string().describe('The path to the file to write'),
  content: z.string().describe('The content to write to the file'),
};

export const listFilesInputSchema = {
  path: z.string().describe('The directory path to list'),
  recursive: z.boolean().optional().default(false).describe('Whether to list files recursively'),
};

// ============ Tool Handlers ============

/**
 * read_file handler
 * 读取文件内容，带路径验证
 */
export async function handleReadFile(input: { path: string }): Promise<ToolResult> {
  const filePath = path.resolve(input.path);

  // 路径验证
  if (!isPathAllowed(filePath)) {
    return errorResult(`Access denied: ${filePath} is not within allowed directories`);
  }

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return errorResult(`File not found: ${filePath}`);
  }

  // 检查是否为文件
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return errorResult(`Not a file: ${filePath}`);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return successResult(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to read file: ${message}`);
  }
}

const DEFAULT_FILE_SLICE_LINES = 120;
const MAX_FILE_SLICE_LINES = 400;
const COLLECTION_URI_PREFIX = 'cat-cafe://collection/';

type CollectionManifestRef = {
  id: string;
  root: string;
};

function loadCollectionManifestRefs(): CollectionManifestRef[] {
  const dataDir = process.env.CAT_CAFE_DATA_DIR ?? path.join(homedir(), '.cat-cafe');
  const manifestPath = path.join(dataDir, 'library', 'collections.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CollectionManifestRef => typeof item?.id === 'string' && typeof item?.root === 'string')
      .map((item) => ({ id: item.id, root: item.root }));
  } catch {
    return [];
  }
}

function resolveFileSlicePath(inputPath: string): { filePath: string; displayPath: string } | { error: string } {
  if (!inputPath.startsWith(COLLECTION_URI_PREFIX)) {
    const filePath = path.resolve(inputPath);
    return { filePath, displayPath: filePath };
  }

  const rest = inputPath.slice(COLLECTION_URI_PREFIX.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0 || firstSlash === rest.length - 1) {
    return { error: `Invalid collection file path: ${inputPath}` };
  }

  let collectionId: string;
  let relativeParts: string[];
  try {
    collectionId = decodeURIComponent(rest.slice(0, firstSlash));
    relativeParts = rest
      .slice(firstSlash + 1)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return { error: `Invalid collection file path encoding: ${inputPath}` };
  }

  const manifest = loadCollectionManifestRefs().find((candidate) => candidate.id === collectionId);
  if (!manifest) {
    return { error: `Collection not found for file path: ${collectionId}` };
  }

  const root = path.resolve(manifest.root);
  const filePath = path.resolve(root, ...relativeParts);
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { error: `Collection file path escapes collection root: ${inputPath}` };
  }

  return { filePath, displayPath: inputPath };
}

/**
 * cat_cafe_read_file_slice handler
 * Read a bounded, line-numbered file range for evidence drill-down.
 */
export async function handleReadFileSlice(input: {
  path: string;
  startLine: number;
  endLine?: number;
}): Promise<ToolResult> {
  const resolvedPath = resolveFileSlicePath(input.path);
  if ('error' in resolvedPath) {
    return errorResult(resolvedPath.error);
  }
  const { filePath, displayPath } = resolvedPath;
  const endLine = input.endLine ?? input.startLine + DEFAULT_FILE_SLICE_LINES - 1;

  if (endLine < input.startLine) {
    return errorResult('Invalid line range: endLine must be greater than or equal to startLine');
  }
  const requestedLines = endLine - input.startLine + 1;
  if (requestedLines > MAX_FILE_SLICE_LINES) {
    return errorResult(`Invalid line range: requested ${requestedLines} lines, max is ${MAX_FILE_SLICE_LINES}`);
  }

  if (!isPathAllowed(filePath)) {
    return errorResult(`Access denied: ${filePath} is not within allowed directories`);
  }
  if (!fs.existsSync(filePath)) {
    return errorResult(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return errorResult(`Not a file: ${filePath}`);
  }

  const lines: string[] = [];
  let currentLine = 0;
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      currentLine++;
      if (currentLine < input.startLine) continue;
      if (currentLine > endLine) {
        reader.close();
        stream.destroy();
        break;
      }
      lines.push(`${currentLine}: ${line}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to read file slice: ${message}`);
  }

  if (lines.length === 0) {
    return errorResult(`Line range starts beyond EOF: ${filePath} has ${currentLine} line(s)`);
  }

  const actualEndLine = input.startLine + lines.length - 1;
  return successResult(`File slice: ${displayPath}:${input.startLine}-${actualEndLine}\n${lines.join('\n')}`);
}

/**
 * write_file handler
 * 写入文件内容，带路径验证和自动创建父目录
 */
export async function handleWriteFile(input: { path: string; content: string }): Promise<ToolResult> {
  const filePath = path.resolve(input.path);

  // 路径验证
  if (!isPathAllowed(filePath)) {
    return errorResult(`Access denied: ${filePath} is not within allowed directories`);
  }

  try {
    // 确保父目录存在
    const parentDir = path.dirname(filePath);
    ensureDir(parentDir);

    // 写入文件
    fs.writeFileSync(filePath, input.content, 'utf-8');
    return successResult(`Successfully wrote to ${filePath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to write file: ${message}`);
  }
}

/**
 * 递归列出目录中的文件
 */
function listFilesRecursive(dirPath: string, basePath: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      results.push(`${relativePath}/`);
      results.push(...listFilesRecursive(fullPath, basePath));
    } else {
      results.push(relativePath);
    }
  }

  return results;
}

/**
 * list_files handler
 * 列出目录中的文件，支持递归选项
 */
export async function handleListFiles(input: { path: string; recursive?: boolean }): Promise<ToolResult> {
  const dirPath = path.resolve(input.path);
  const recursive = input.recursive ?? false;

  // 路径验证
  if (!isPathAllowed(dirPath)) {
    return errorResult(`Access denied: ${dirPath} is not within allowed directories`);
  }

  // 检查目录是否存在
  if (!fs.existsSync(dirPath)) {
    return errorResult(`Directory not found: ${dirPath}`);
  }

  // 检查是否为目录
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return errorResult(`Not a directory: ${dirPath}`);
  }

  try {
    let files: string[];

    if (recursive) {
      files = listFilesRecursive(dirPath, dirPath);
    } else {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      files = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    }

    if (files.length === 0) {
      return successResult('Directory is empty');
    }

    return successResult(files.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to list files: ${message}`);
  }
}

// ============ Tool Definitions for Registration ============

export const fileTools = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file within allowed directories. ' +
      'Returns the full file content as text. Rejects paths outside allowed directories.',
    inputSchema: readFileInputSchema,
    handler: handleReadFile,
  },
  {
    name: 'write_file',
    description:
      'Write content to a file within allowed directories. Creates parent directories if needed. ' +
      'GOTCHA: This overwrites the entire file — not a patch/append operation. ' +
      'Rejects paths outside allowed directories.',
    inputSchema: writeFileInputSchema,
    handler: handleWriteFile,
  },
  {
    name: 'list_files',
    description:
      'List files in a directory within allowed paths. Set recursive=true to include all subdirectories. ' +
      'Directories are suffixed with "/" in the output to distinguish them from files.',
    inputSchema: listFilesInputSchema,
    handler: handleListFiles,
  },
] as const;

export const fileSliceTools = [
  {
    name: 'cat_cafe_read_file_slice',
    description:
      'Read a bounded line range from a file within allowed directories. ' +
      'Use after search_evidence returns a sourcePath. Read-only; returns numbered lines and refuses large ranges.',
    inputSchema: readFileSliceInputSchema,
    handler: handleReadFileSlice,
  },
] as const;
