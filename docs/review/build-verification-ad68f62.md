---
feature_ids: [F155, F229, F320]
topics: [desktop, windows, packaging, verification]
doc_kind: verification-report
created: 2026-10-16
---

# Electron Build Verification Report

## Build Information

**Source Commit**: `ad68f62b62165927176ed003b94850d3285bb59f`
- Message: fix(desktop): unpack external Node dependencies to resolve startup crash
- Author: whutzefengxie-ops
- Date: 2026-10-16 16:10:57 +0800

**Build Environment**:
- Build Time: 2026-10-16 16:33:48 +0800
- Node Version: v24.16.0
- pnpm Version: 9.15.4
- electron-builder: 26.8.1
- Electron: 35.7.5

**Build Output**: `desktop/dist/win-unpacked/`

## ASAR Verification ✅

### Critical Files in app.asar.unpacked

All four external Node dependencies successfully unpacked:

```
✓ api-startup-probe.mjs       (3.1 KB)
✓ runtime-web-server.js        (4.7 KB)
✓ runtime-web-config.js        (2.1 KB)
✓ startup-timing.js            (1.3 KB)
```

### Core Files in app.asar

```
✓ service-manager.js           (in ASAR - used by Electron main)
✓ subprocess-entry.js          (in ASAR - resolver module)
```

### Build Artifacts

- **Clowder AI.exe**: `193 MB`
  - SHA-256: `1fcd6fc1bb6782ca1e5b614b1ae962e6a8a3929429b4755660e6f8bbf919189e`
  
- **app.asar**: `4.5 MB`
  - SHA-256: `9703ad0a05719a68534cceb3c920a2e5397bf373d4f6b3fc729692677933ea39`

## Contract Validation ✅

External Node subprocess calling contract verified:

```
Electron main (app.asar)
  ├─ subprocess-entry.js (resolver)
  ├─ service-manager.js (spawner)
  │
  ├─ API: Node --import app.asar.unpacked/api-startup-probe.mjs
  │         ✓ api-startup-probe.mjs unpacked
  │
  └─ Web: Node app.asar.unpacked/runtime-web-server.js
           ✓ runtime-web-server.js unpacked
           ├─ require('./runtime-web-config.js')
           │    ✓ runtime-web-config.js unpacked
           └─ require('./startup-timing.js')
                ✓ startup-timing.js unpacked
```

## Test Results ✅

**subprocess-entry.test.js**: 2/2 pass
- Path resolution (development vs packaged)
- Unpack list completeness assertion

## Status

✅ **Build Phase Complete**: Electron candidate package verified
- All external Node dependencies correctly unpacked
- Path resolution contract preserved
- ASAR structure validated

🔄 **Next Phase**: Clean install acceptance test
- Create isolated installation directory
- Perform fresh install with new candidate
- Verify first-run startup completes to Web/API/Redis ready
- Document startup timing and logs

## Notes

- This build skipped Inno Setup installer compilation (Inno Setup not installed)
- For full deployment, need to rebuild with installer: `.\desktop\scripts\build-desktop.ps1`
- Current candidate suitable for unpacked testing: can run directly from `dist/win-unpacked/`
