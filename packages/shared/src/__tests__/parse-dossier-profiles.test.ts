import { describe, expect, it } from 'vitest';
import type { DossierProfile } from '../dossier/parse-dossier-profiles.js';
import { parseDossierProfiles } from '../dossier/parse-dossier-profiles.js';

const SAMPLE_DOSSIER = `---
version: 0.3
status: draft
---

# Clowder AI 能力画像档案

## Schema: L1 画像 6 字段

Some schema docs here...

---

## 四主力猫 L1 画像

---

### 布偶猫 Opus 4.6 · @opus · \`cat:opus\`

\`\`\`yaml
# structured-profile: cat:opus
entityId: "cat:opus"
oneLiner: "快枪手——出活快但爱糊弄"
l0RosterSummary: "快速编码 + 系统设计，全链路推进"
routingSignals:
  peakCapabilities:
    - "快速编码 + 系统设计一体"
    - "人类需求转译"
  antiSignals:
    - "alpha 验收（太贵）"
    - "独立做 reviewer"
provenance:
  version: "0.1"
  date: "2026-05-25"
  primarySources: ["cvo", "peer"]
\`\`\`

> **一句话画像**: 快枪手...

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | 快速编码... |

---

### 缅因猫 GPT-5.5 · 砚砚 · @codex · \`cat:codex\`

\`\`\`yaml
# structured-profile: cat:codex
entityId: "cat:codex"
oneLiner: "全能 reviewer"
l0RosterSummary: "Review、找 bug、coding 落地"
provenance:
  version: "0.1"
  date: "2026-05-25"
\`\`\`

> **一句话画像**: 全能 reviewer...

---

### 缅因猫 Spark · @spark

\`\`\`yaml
# structured-profile: cat:spark
entityId: "cat:spark"
oneLiner: "快速编码、精确点改"
l0RosterSummary: "快速编码、精确点改"
provenance:
  version: "0.1"
  date: "2026-05-25"
\`\`\`

> 快速编码...
`;

describe('parseDossierProfiles', () => {
  it('extracts all structured profiles from markdown', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    expect(profiles.size).toBe(3);
    expect(profiles.has('opus')).toBe(true);
    expect(profiles.has('codex')).toBe(true);
    expect(profiles.has('spark')).toBe(true);
  });

  it('parses entityId correctly', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    expect(profiles.get('opus')?.entityId).toBe('cat:opus');
    expect(profiles.get('codex')?.entityId).toBe('cat:codex');
  });

  it('parses oneLiner correctly', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    expect(profiles.get('opus')?.oneLiner).toBe('快枪手——出活快但爱糊弄');
    expect(profiles.get('codex')?.oneLiner).toBe('全能 reviewer');
  });

  it('parses l0RosterSummary correctly', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    expect(profiles.get('opus')?.l0RosterSummary).toBe('快速编码 + 系统设计，全链路推进');
    expect(profiles.get('codex')?.l0RosterSummary).toBe('Review、找 bug、coding 落地');
    expect(profiles.get('spark')?.l0RosterSummary).toBe('快速编码、精确点改');
  });

  it('parses routingSignals when present', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    const opus = profiles.get('opus')!;
    expect(opus.routingSignals).toBeDefined();
    expect(opus.routingSignals?.peakCapabilities).toEqual(['快速编码 + 系统设计一体', '人类需求转译']);
    expect(opus.routingSignals?.antiSignals).toEqual(['alpha 验收（太贵）', '独立做 reviewer']);
  });

  it('returns undefined routingSignals for profiles without them', () => {
    const profiles = parseDossierProfiles(SAMPLE_DOSSIER);
    expect(profiles.get('codex')?.routingSignals).toBeUndefined();
    expect(profiles.get('spark')?.routingSignals).toBeUndefined();
  });

  it('returns empty map for content without structured profiles', () => {
    const profiles = parseDossierProfiles('# Just a regular markdown file\n\nNo yaml blocks.');
    expect(profiles.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    const profiles = parseDossierProfiles('');
    expect(profiles.size).toBe(0);
  });

  it('ignores yaml blocks that are not structured profiles', () => {
    const md = `
\`\`\`yaml
# not a structured profile
key: value
\`\`\`

\`\`\`yaml
# structured-profile: cat:test
entityId: "cat:test"
l0RosterSummary: "test cat"
\`\`\`
`;
    const profiles = parseDossierProfiles(md);
    expect(profiles.size).toBe(1);
    expect(profiles.get('test')?.l0RosterSummary).toBe('test cat');
  });

  it('extracts catId from entityId (strips cat: prefix)', () => {
    const md = `
\`\`\`yaml
# structured-profile: cat:opus-47
entityId: "cat:opus-47"
l0RosterSummary: "架构设计"
\`\`\`
`;
    const profiles = parseDossierProfiles(md);
    expect(profiles.has('opus-47')).toBe(true);
    expect(profiles.get('opus-47')?.entityId).toBe('cat:opus-47');
  });
});
