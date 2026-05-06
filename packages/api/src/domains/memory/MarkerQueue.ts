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
    if (input.sourceCollectionId) marker.sourceCollectionId = input.sourceCollectionId;
    if (input.sourceSensitivity) marker.sourceSensitivity = input.sourceSensitivity;
    if (input.targetCollectionId) marker.targetCollectionId = input.targetCollectionId;
    if (input.promoteReviewStatus) marker.promoteReviewStatus = input.promoteReviewStatus;
    if (input.secretScanFingerprint) marker.secretScanFingerprint = input.secretScanFingerprint;

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

  async transition(id: string, to: MarkerStatus, patch?: Partial<Marker>): Promise<void> {
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
    if (patch?.targetCollectionId) marker.targetCollectionId = patch.targetCollectionId;
    if (patch?.sourceCollectionId) marker.sourceCollectionId = patch.sourceCollectionId;
    if (patch?.sourceSensitivity) marker.sourceSensitivity = patch.sourceSensitivity;
    if (patch?.promoteReviewStatus) marker.promoteReviewStatus = patch.promoteReviewStatus;
    if (patch?.secretScanFingerprint) marker.secretScanFingerprint = patch.secretScanFingerprint;
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
    if (marker.sourceCollectionId) lines.push(`source_collection_id: ${marker.sourceCollectionId}`);
    if (marker.sourceSensitivity) lines.push(`source_sensitivity: ${marker.sourceSensitivity}`);
    if (marker.targetCollectionId) lines.push(`target_collection_id: ${marker.targetCollectionId}`);
    if (marker.promoteReviewStatus) lines.push(`promote_review_status: ${marker.promoteReviewStatus}`);
    if (marker.secretScanFingerprint) lines.push(`secret_scan_fingerprint: ${marker.secretScanFingerprint}`);
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
    if (fields.target_kind) marker.targetKind = fields.target_kind as NonNullable<Marker['targetKind']>;
    if (fields.source_collection_id) marker.sourceCollectionId = fields.source_collection_id;
    if (fields.source_sensitivity)
      marker.sourceSensitivity = fields.source_sensitivity as NonNullable<Marker['sourceSensitivity']>;
    if (fields.target_collection_id) marker.targetCollectionId = fields.target_collection_id;
    if (fields.promote_review_status)
      marker.promoteReviewStatus = fields.promote_review_status as NonNullable<Marker['promoteReviewStatus']>;
    if (fields.secret_scan_fingerprint) marker.secretScanFingerprint = fields.secret_scan_fingerprint;
    return marker;
  }
}
