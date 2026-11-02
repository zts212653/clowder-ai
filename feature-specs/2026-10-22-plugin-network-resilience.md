# Plugin Manager Local-First Loading and Desktop System Proxy

## Outcome

Opening Plugin Manager must never wait for GitHub or npm before showing Host-bundled candidates or operating on installed plugins. The packaged Electron application uses Chromium's system-proxy-aware network stack for official catalog and package downloads. Source/headless deployments keep explicit environment-proxy configuration.

This is a Host transport and projection repair. It does not add plugin-specific branches, a second catalog, background polling, proxy settings UI, or a replacement for the user's native Git configuration.

## Truth-source matrix

| Fact | Canonical owner | Consumer | Failure behavior |
| --- | --- | --- | --- |
| Built-in candidates shipped by the Host | Host-bundled catalog snapshot | Initial Plugin Manager list/detail | Visible immediately without starting remote discovery |
| Installed package, instance, grants and lifecycle | Host inventory and installed-package projection | Initial Plugin Manager list/detail | Remains available without any remote request |
| Discoverable versions and update candidates | Signed official catalog | One incremental page refresh and explicit install/update | Failure degrades discovery/update only |
| Package bytes | Catalog-pinned npm archive plus SHA-512 verification | Explicit install/update | Fail closed; never substitute local or stale bytes |
| Packaged desktop network route | Electron default session / Chromium network stack | Official catalog and npm archive fetches | Uses OS proxy, PAC/WPAD, TLS tunnel and supported proxy authentication |
| Source/headless network route | Node started with `NODE_USE_ENV_PROXY=1`, plus `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Official catalog and npm archive fetches | Direct when unset; explicit deployment configuration when required |
| Native Git routing | User/admin Git configuration | Git-based local/marketplace installs | Unchanged by this work |

## Invariants

| Invariant | Executable evidence |
| --- | --- |
| Local list/detail do not await catalog I/O | Deferred remote catalog promise stays unresolved while local endpoint returns Host-bundled candidates and installed state |
| The page paints local state before remote discovery settles | Web test observes installed row while remote list promise is pending, then observes remote additions |
| No idle/background polling is introduced | Component performs one local read and one remote read per load/search/mutation refresh |
| Catalog failure cannot erase or disable installed state | Service and UI tests retain installed row and expose a discovery warning |
| Desktop bridge cannot become an arbitrary localhost proxy | Loopback bind, random bearer credential, POST-only protocol, exact host/path allowlist and response-size caps |
| Proxy credentials never enter API config, logs or response bodies | Bridge delegates authentication to Electron and exports only loopback endpoint plus random process credential |
| Package trust is unchanged | Registry host restriction, redirect rejection, byte cap and SHA-512 verification remain in the API path |
| Pure Node deployments do not depend on Electron | Missing bridge environment falls back to Node fetch; administrators opt into Node environment-proxy support at process startup |

## Existing behavior protection

| Existing behavior | Protection |
| --- | --- |
| Catalog rollback/equivocation continuity | `MachineOfficialPluginCatalog` remains the sole validator and continuity owner |
| Concurrent catalog reads coalesce but completed reads are not cached | Existing `inFlight` lifecycle remains unchanged |
| Mutation read ordering | Existing `afterCurrentGet`, generation fencing and lifecycle deadlines remain unchanged |
| Explicit install/update selects exact version and digest | Catalog install request and archive digest checks remain unchanged |
| Local directory/archive install and lifecycle operations | Local projection uses the same inventory, quarantine and configuration ports |
| Installed selection survives remote hydration | Remote response merges through the same canonical manager projection and refreshes selected detail |

## Implementation units

1. Add local-only list/search/detail service methods and read-only routes. They project the Host-owned local catalog snapshot plus existing inventory without invoking remote `catalog.snapshot()` or repository refresh.
2. Change the live Plugin Manager loader to commit the local response first, then make one canonical remote request and replace it only if its generation is current.
3. Add a packaged-desktop loopback bridge around Electron `net.fetch`. Permit only the canonical catalog URL and `registry.npmjs.org`, bound response sizes, and pass an ephemeral endpoint/token only to the owned API child.
4. Route official catalog/archive fetches through a shared API adapter: desktop bridge when present, ordinary Node fetch otherwise. Source/headless administrators opt into Node's standard environment-proxy support at process startup.
5. Verify RED to GREEN with service, route, Web, bridge, archive/catalog, desktop startup/env and builds. Run an independent non-author review on the frozen exact HEAD.

## Out of scope

- Native Git clone proxy discovery or rewriting.
- A user-facing proxy credential store or custom proxy selector.
- Catalog caching, retry timers, page polling or automatic package downloads.
- Changes to the running `develop_base` instance or runtime configuration.
