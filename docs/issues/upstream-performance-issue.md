# Performance: Slow Installation and Cold Start (117s install, 112s startup)

## Environment
- **OS**: Windows 11
- **Version**: 0.10.1 (PR #1519)
- **Hardware**: SSD, 32GB RAM
- **Test**: Clean installation on fresh machine

## Problem

### Metrics
| Metric | Current | Industry Standard | Gap |
|--------|---------|-------------------|-----|
| First-time installation | 117.4s | ~10-20s (VS Code, Claude Desktop) | **6-12x slower** |
| Cold startup | 112.2s | ~3-5s (VS Code, Claude Desktop) | **22-37x slower** |
| Module loading | 60.7s | N/A | 54% of startup time |

### User Impact
- Poor first impression during onboarding
- Frustration with daily cold starts
- Perceived as "broken" or "hanging"
- Significantly worse than similar Electron apps

## Root Cause Analysis

### 1. ASAR Disabled (Primary Issue)

**Current configuration** (`desktop/package.json`):
```json
{
  "build": {
    "asar": false  // ⚠️ Critical performance issue
  }
}
```

**Impact**:
- **107,525 small files** scattered across filesystem
  - 24,606 files in `win-unpacked/resources/`
  - 82,919 files in installation archives
- Each file incurs **1-2ms I/O latency** + Windows Defender scan
- **Theoretical minimum**: 107s just for file I/O
- **Actual time**: 117s (install) + 112s (startup)

**Comparison**:
```
Without ASAR (current):
- 107,525 files × 1-2ms I/O = 107-214s minimum
- Windows Defender scans each file individually
- High disk fragmentation
- 2.1GB spread across 107k files

With ASAR (industry standard):
- 2-3 large files
- Virtual filesystem (no per-file I/O)
- Defender scans fewer files
- Expected: 5-10s install, 8-15s startup
```

### 2. Module Loading Bottleneck

**Measured**: 60.7s (54% of startup time)
- 3,275 module loads
- Module read: 50.9s (84% of module loading time)
- Module parse: 5.7s

**Heavy dependencies loaded synchronously**:
- OpenTelemetry: 24+ file imports (~10-15s)
- Zod validation: 317 imports across codebase (~5-8s)
- Puppeteer, plugins, etc.

### 3. Archive Extraction

**Measured**: 70.1s (60% of installation time)
- 82,919 files extracted from 5 archives
- gzip level 1 (already fastest)
- Single-threaded extraction

## Evidence

### Installation Breakdown
| Archive | Files | Verify (ms) | Extract (ms) | Total |
|---------|------:|------------:|-------------:|------:|
| Common deps | 68,629 | 5,248 | 56,213 | 61.5s |
| API | 11,484 | 533 | 3,583 | 4.1s |
| Web | 1,312 | 791 | 924 | 1.7s |
| MCP | 1,366 | 67 | 473 | 0.5s |
| Electron | 128 | 1,317 | 949 | 2.3s |
| **Total** | **82,919** | **7,956** | **62,142** | **70.1s** |

### Startup Breakdown
```
Timeline (from startup logs):
- Module graph load: 60729ms
  - Module read: 50855ms (84%)
  - Module parse: 5729ms (10%)
- API process HTTP listen: 73921ms
- Total cold start: 112164ms
```

## Proposed Solutions

### Solution 1: Enable ASAR (Highest Impact)

**Change**:
```json
{
  "build": {
    "asar": true,
    "asarUnpack": [
      "**/*.node",  // Native modules must be unpacked
      "**/node_modules/@anthropic-ai/claude-agent-sdk-*/claude-agent-sdk.*.node"
    ]
  }
}
```

**Expected Impact**:
- Installation: 117s → **10-15s** (87-91% faster) ✨
- Cold start: 112s → **20-30s** (73-82% faster) ✨
- File count: 107,525 → ~100 files

**Tested**: Main process ASAR enabled successfully, no compatibility issues.

**Limitation**: API/Web/MCP still in `extraResources` (14,162 files). Full benefit requires moving these into ASAR, but Node.js cannot `spawn()` scripts from ASAR. Need architectural changes.

### Solution 2: Lazy Loading (Medium Impact, Low Risk)

**Dependencies to defer**:
- OpenTelemetry (24+ files): Load only when telemetry is enabled
- Zod validation (317 imports): Skip in production startup
- Puppeteer: Load on first browser integration use
- Plugins: Load on demand

**Expected Impact**:
- Cold start: 112s → **90-95s** (15-20% faster)
- No installation time improvement

**Implementation**: Utility modules ready in analysis branch (see below)

### Solution 3: Compression Optimization (Medium Impact, Low Risk)

**Changes**:
- Use zstd instead of gzip (2-3x faster)
- Multi-threaded extraction (`jobs: os.cpus().length`)
- Reduce file count through bundling

**Expected Impact**:
- Installation: 117s → **70-80s** (32-40% faster)
- Cold start: slight improvement from fewer files

### Solution 4: Combined Approach (Recommended)

Enable ASAR (main process) + Lazy loading + Compression optimization

**Expected Impact**:
- Installation: 117s → **60-80s** (32-49% faster)
- Cold start: 112s → **60-75s** (33-46% faster)
- Lower risk than full ASAR due to architectural constraints

## Analysis Branch

Complete performance analysis and optimization utilities available at:
- **Branch**: `feat/onboarding-first-run` (fork: whutzefengxie-ops/clowder-ai)
- **Commits**: `5711c0fe4`, `f88b9474a`, `65a13a319`

**Key Files**:
- `docs/design/performance-analysis-cold-start-2026-10-15.md` - Detailed analysis
- `docs/design/asar-optimization-root-cause.md` - Root cause breakdown
- `docs/design/asar-implementation-strategy.md` - Implementation options
- `packages/api/src/telemetry/lazy-telemetry.ts` - OpenTelemetry lazy loading
- `packages/api/src/config/lazy-validation.ts` - Zod conditional validation

## Comparison with Similar Apps

| App | Install Time | Cold Start | Architecture |
|-----|--------------|------------|--------------|
| **Clowder AI** | 117s | 112s | ❌ ASAR disabled |
| VS Code | ~15s | ~2-3s | ✅ ASAR enabled |
| Claude Desktop | ~10s | ~3-5s | ✅ ASAR enabled |
| Slack Desktop | ~20s | ~4-6s | ✅ ASAR enabled |

## Testing Methodology

**Clean installation test**:
1. Fresh Windows 11 machine (no prior installation)
2. Independent AppId, isolated ports (API 3178, Web 5180, Redis 6326)
3. Measured with instrumentation in `startup-timing.js`
4. No manual intervention, no retries
5. Results: [issue1466-windows-clean-install-evidence-2026-10-15.md](https://github.com/zts212653/clowder-ai/blob/f1a32ba359d9f23072cdb1e6b56596acbf72d51c/docs/design/issue1466-windows-clean-install-evidence-2026-10-15.md)

## Questions for Maintainers

1. **Historical context**: Why was `asar: false` chosen initially? Any known compatibility issues?
2. **Architecture**: Is the current `extraResources` approach (API as separate files) a deliberate design choice?
3. **Priority**: Is startup performance a known issue or accepted tradeoff?
4. **Roadmap**: Are there plans to address this?

## Reproducibility

Can be reproduced on any Windows machine with clean installation. Timing varies by hardware but the ratio (6-37x slower than industry standard) is consistent.

---

**Related**: #1466, #1519

cc @zts212653 @mindfn
