import type Database from 'better-sqlite3';
import type { DisplayCategory, SubjectKind, TriggerSpec } from './types.js';

export interface PackTemplateDef {
  templateId: string;
  packId: string;
  label: string;
  description: string;
  category: DisplayCategory;
  subjectKind: SubjectKind;
  defaultTrigger: TriggerSpec;
  paramSchema: Record<string, { type: string; required: boolean; description: string }>;
  builtinTemplateRef: string;
  createdAt?: string;
}

export class PackTemplateStore {
  constructor(private db: Database.Database) {}

  install(def: PackTemplateDef): void {
    // Namespace validation: must start with "pack:"
    if (!def.templateId.startsWith('pack:')) {
      throw new Error(`Pack template ID must start with pack: — got "${def.templateId}"`);
    }
    // Namespace consistency: pack:{packId}:{name}
    const parts = def.templateId.split(':');
    if (parts.length < 3 || parts[1] !== def.packId) {
      throw new Error(`Namespace mismatch: templateId "${def.templateId}" does not match packId "${def.packId}"`);
    }
    // Duplicate check
    const existing = this.get(def.templateId);
    if (existing) {
      throw new Error(`Pack template "${def.templateId}" already installed`);
    }

    const now = def.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pack_template_defs
         (template_id, pack_id, label, description, category, subject_kind,
          default_trigger_json, param_schema_json, builtin_template_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        def.templateId,
        def.packId,
        def.label,
        def.description,
        def.category,
        def.subjectKind,
        JSON.stringify(def.defaultTrigger),
        JSON.stringify(def.paramSchema),
        def.builtinTemplateRef,
        now,
      );
  }

  get(templateId: string): PackTemplateDef | null {
    const row = this.db.prepare('SELECT * FROM pack_template_defs WHERE template_id = ?').get(templateId) as
      | RawRow
      | undefined;
    if (!row) return null;
    return toPackTemplateDef(row);
  }

  uninstall(templateId: string): boolean {
    const result = this.db.prepare('DELETE FROM pack_template_defs WHERE template_id = ?').run(templateId);
    return result.changes > 0;
  }

  listByPack(packId: string): PackTemplateDef[] {
    const rows = this.db
      .prepare('SELECT * FROM pack_template_defs WHERE pack_id = ? ORDER BY created_at')
      .all(packId) as RawRow[];
    return rows.map(toPackTemplateDef);
  }

  listAll(): PackTemplateDef[] {
    const rows = this.db.prepare('SELECT * FROM pack_template_defs ORDER BY created_at').all() as RawRow[];
    return rows.map(toPackTemplateDef);
  }
}

interface RawRow {
  template_id: string;
  pack_id: string;
  label: string;
  description: string;
  category: string;
  subject_kind: string;
  default_trigger_json: string;
  param_schema_json: string;
  builtin_template_ref: string;
  created_at: string;
}

function toPackTemplateDef(row: RawRow): PackTemplateDef {
  return {
    templateId: row.template_id,
    packId: row.pack_id,
    label: row.label,
    description: row.description,
    category: row.category as DisplayCategory,
    subjectKind: row.subject_kind as SubjectKind,
    defaultTrigger: JSON.parse(row.default_trigger_json),
    paramSchema: JSON.parse(row.param_schema_json),
    builtinTemplateRef: row.builtin_template_ref,
    createdAt: row.created_at,
  };
}
