// F102: IMarkerQueue — YAML-backed marker candidate queue
// Truth source: docs/markers/*.yaml (git-tracked), not SQLite

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IMarkerQueue, Marker, MarkerFilter, MarkerStatus } from './interfaces.js';

// Defense-in-depth: only allow safe characters in marker ids (no path traversal)
const SAFE_ID_RE = /^[a-z0-9-]+$/i;
function validateMarkerId(id: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid marker id: ${id}`);
  }
}

export class MarkerQueue implements IMarkerQueue {
  constructor(private readonly markersDir: string) {}

  async submit(input: Omit<Marker, 'id' | 'createdAt'>): Promise<Marker> {
    const marker: Marker = {
      id: randomUUID().slice(0, 12),
      content: input.content,
      source: input.source,
      status: input.status,
      createdAt: new Date().toISOString(),
    };
    if (input.targetKind) marker.targetKind = input.targetKind;

    this.writeYaml(marker);
    return marker;
  }

  async list(filter?: MarkerFilter): Promise<Marker[]> {
    const markers = this.readAll();
    if (!filter) return markers;

    return markers.filter((m) => {
      if (filter.status && m.status !== filter.status) return false;
      if (filter.targetKind && m.targetKind !== filter.targetKind) return false;
      if (filter.source && m.source !== filter.source) return false;
      return true;
    });
  }

  async transition(id: string, to: MarkerStatus): Promise<void> {
    validateMarkerId(id);
    const filePath = join(this.markersDir, `${id}.yaml`);
    if (!existsSync(filePath)) {
      throw new Error(`Marker not found: ${id}`);
    }

    const marker = this.parseYaml(readFileSync(filePath, 'utf-8'));
    if (!marker) throw new Error(`Marker not found: ${id}`);

    // SECURITY: Always use the input id, not the YAML-parsed id,
    // to prevent path traversal via tampered YAML content
    marker.id = id;
    marker.status = to;
    this.writeYaml(marker);
  }

  // ── Private ──────────────────────────────────────────────────────

  private readAll(): Marker[] {
    let files: string[];
    try {
      files = readdirSync(this.markersDir).filter((f) => f.endsWith('.yaml'));
    } catch {
      return [];
    }

    const markers: Marker[] = [];
    for (const file of files) {
      const content = readFileSync(join(this.markersDir, file), 'utf-8');
      const marker = this.parseYaml(content);
      if (marker) markers.push(marker);
    }
    return markers;
  }

  private ensureDir(): void {
    if (!existsSync(this.markersDir)) {
      mkdirSync(this.markersDir, { recursive: true });
    }
  }

  private writeYaml(marker: Marker): void {
    validateMarkerId(marker.id);
    this.ensureDir();
    const lines = [
      `id: ${marker.id}`,
      `status: ${marker.status}`,
      `source: ${marker.source}`,
      `created_at: ${marker.createdAt}`,
    ];
    if (marker.targetKind) lines.push(`target_kind: ${marker.targetKind}`);
    lines.push(`content: |`);
    for (const line of marker.content.split('\n')) {
      lines.push(`  ${line}`);
    }
    writeFileSync(join(this.markersDir, `${marker.id}.yaml`), `${lines.join('\n')}\n`);
  }

  private parseYaml(text: string): Marker | null {
    const fields: Record<string, string> = {};
    let contentLines: string[] = [];
    let inContent = false;

    for (const line of text.split('\n')) {
      if (inContent) {
        if (line.startsWith('  ')) {
          contentLines.push(line.slice(2));
        } else if (line.trim() === '') {
          contentLines.push('');
        } else {
          inContent = false;
        }
      }
      if (!inContent) {
        if (line.startsWith('content: |')) {
          inContent = true;
          contentLines = [];
        } else {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match?.[1] && match[2]) {
            fields[match[1]] = match[2].trim();
          }
        }
      }
    }

    const id = fields.id;
    const status = fields.status;
    const source = fields.source;
    const createdAt = fields.created_at;
    const content = contentLines.join('\n').trimEnd();

    if (!id || !status || !source || !createdAt || !content) return null;

    const marker: Marker = {
      id,
      content,
      source,
      status: status as MarkerStatus,
      createdAt,
    };
    const tk = fields.target_kind;
    if (tk) marker.targetKind = tk as NonNullable<Marker['targetKind']>;
    return marker;
  }
}
