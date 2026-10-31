---
feature_ids: [F317]
doc_kind: guide
created: 2026-10-14
description: Run the portable synthetic page-action regressions without private reports, model calls or the PPT workspace.
---

# Synthetic page-action regressions

These regressions launch disposable headless browsers against synthetic loopback
pages. They exercise clicks, input, actual readback, target replacement, owner
consent, revocation and restoration. They do not attach to your browser, read
accounts, call a model or start audio/video capture.

Install the workspace with `pnpm install --frozen-lockfile`. Install Google Chrome
in its standard location, or set `F317_BROWSER_EXECUTABLE_PATH` to an executable
Chrome/Chromium binary. `puppeteer-core` is an existing API dependency and does not
download a browser. An invalid explicit path fails instead of selecting another
browser. Linux containers may need the browser's normal system libraries and a
user namespace configuration that supports its sandbox; this runner does not
disable the browser sandbox.

Use a linked Git worktree: the default suite already includes the owner-service
integration, whose isolated Host fixture deliberately rejects ordinary checkouts.
From a clone, create and install that worktree first:

```sh
git worktree add ../page-action-lab -b page-action-lab
cd ../page-action-lab
pnpm install --frozen-lockfile
```

From that worktree's root:

```sh
pnpm --dir packages/api test:page-action
```

The command builds the required workspace packages, initializes the isolated test
registry and runs the twelve named `.test.mjs` files. After those builds, use
`pnpm --dir packages/api test:page-action:prepared` to repeat the same suite. To see
the selected files without launching a browser:

```sh
node packages/api/scripts/run-page-action-tests.mjs --list
```

This dedicated suite is separate from `test:public`, whose existing `.test.js`
selection is unchanged. Its successful result is evidence for only the files
printed by the dedicated entry.

## Optional isolated Host lab

The thirteenth and fourteenth test files check the opt-in owner-local-note lab and
its owner HTTP simulation. They cover refusal of ordinary runtime, Alpha,
network-facing and persistent-state launches, plus inspect/cancel/confirm/restore
and expiration of the labeled simulation. Use the linked worktree prepared above:

```sh
pnpm --dir packages/api test:page-action:prepared --owner-lab
```

No network-listening Host/API server is started by these tests; their browser
connector, injected HTTP requests and memory fixtures are isolated. The lab
helper and both tests remain distributed so this
optional path has the same executable closure as the ordinary regressions.

The historical `f317-page-action-lineage.test.mjs` stays in the internal source
checkout. It validates private committed Jev/Sol comparison reports and the
model replay; that exact test, those reports and the model-runner files are not
distributed. This boundary does not exclude the synthetic product regressions.
