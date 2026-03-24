/**
 * File Tools
 * MCP 文件操作工具
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
