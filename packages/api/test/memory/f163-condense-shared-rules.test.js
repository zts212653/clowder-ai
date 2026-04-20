/**
 * F163 Phase B Task 8: Shared-rules condensation script (AC-B4)
 * Tests the condensation analysis — identifies redundant rule clusters
 * and reports potential line-count reduction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSharedRules } from '../../dist/domains/memory/f163-condense-shared-rules.js';

describe('F163 shared-rules condensation (AC-B4)', () => {
  it('identifies redundant rule clusters in mock content', () => {
    const mockContent = `# Shared Rules

## §1 Redis Safety

Redis 6399 是用户数据圣域。开发只用 6398，误触 6399 立即停服务通知铲屎官。

## §2 Redis Connection Isolation

Worktree 环境必须设置 REDIS_URL=redis://localhost:6398。不设置默认 fallback 到 6399 = 数据丢失风险。

## §3 Redis Test Isolation

Redis 测试只用 pnpm test:redis，禁止直连环境 Redis。测试脚本自动起临时 Redis。

## §4 Code Quality

Biome: pnpm check / pnpm check:fix。代码不能带着 biome errors 提 review。

## §5 File Size Limits

文件 200 行警告 / 350 硬上限。目录 15 warn / 25 error。

## §6 Redis Key Safety

ioredis keyPrefix 不适用 EVAL/EVALSHA 命令。Redis scripting 命令需要手动拼 prefix。

## §7 Testing Discipline

先写测试。看它失败。写最少代码通过。没有失败的测试就没有实现代码。
`;

    const result = analyzeSharedRules(mockContent);

    assert.ok(result.clusters.length >= 1, 'should find at least 1 cluster');
    // Should find a Redis-related cluster (§1, §2, §3, §6 are all about Redis safety)
    const redisCluster = result.clusters.find(
      (c) => c.sections.some((s) => s.includes('§1')) || c.sections.some((s) => s.includes('Redis')),
    );
    assert.ok(redisCluster, 'should find Redis-related cluster');
    assert.ok(redisCluster.sections.length >= 2, 'Redis cluster should have >=2 sections');
    assert.ok(typeof result.originalLineCount === 'number');
    assert.ok(typeof result.proposedLineCount === 'number');
    assert.ok(typeof result.reductionPercent === 'number');
  });

  it('returns source markers in condensed output', () => {
    const mockContent = `# Rules

## §1 Review Rule A

同一个体不能 review 自己的代码。

## §2 Review Rule B

跨 family 优先做 review，可降级到同 family 不同个体。

## §3 Unrelated Rule

Redis 6399 是圣域。
`;

    const result = analyzeSharedRules(mockContent);

    // Each cluster should have source markers
    for (const cluster of result.clusters) {
      assert.ok(cluster.sections.length >= 2, 'cluster should have >=2 sections');
      assert.ok(typeof cluster.similarity === 'number');
      assert.ok(cluster.similarity > 0);
    }
  });

  it('handles content with no duplicates gracefully', () => {
    const mockContent = `# Rules

## §1 Redis

Redis safety rules.

## §2 Testing

TDD rules.

## §3 Files

File size limits.
`;

    const result = analyzeSharedRules(mockContent, { threshold: 0.8 });
    // At high threshold, distinct topics should not cluster
    assert.equal(result.clusters.length, 0, 'no clusters expected for distinct topics');
  });
});
