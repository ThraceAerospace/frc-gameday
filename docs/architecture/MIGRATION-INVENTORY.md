# FieldView Migration Inventory

**Status:** Source-level migration inventory, first pass complete; live configuration and dependency-graph verification remain open  
**Branch:** `fieldview-architecture-migration`  
**Baseline commit:** `9bf16698` (pre-migration baseline recorded during the initial audit)

This inventory maps the existing application to target responsibilities. It is organized by ownership, not by mechanical file moves. The historical `docs/APPLICATION-AUDIT.md` records 104 findings and the source-level audit of the legacy data paths; findings must be revalidated against the target architecture before being treated as defects or implementation tasks.

## 1. Repository and deployment baseline

| Area | Current state | Migration treatment |
|---|---|---|
| Repository | Next.js application relocated to `apps/web`; root manifest and lockfile remain | Complete npm workspace conversion while preserving one root lockfile |
| Web framework | Next.js 16.3.8, React 19, now under `apps/web` | Keep Next.js; validate app-specific configuration and root-level commands after relocation |
| Runtime version | Vercel project configured for Node 24.x; migration environment uses Node 24.22.3 | Standardize local/CI/runtime on Node 24 and preserve the pinned runtime |
| Package manager | npm 11.19.1; root `package-lock.json`; workspaces not yet enabled | Keep npm and one root lockfile; enable npm workspaces without changing package manager |
| Build scripts | `dev`, `build`, `start`, `lint`; type generation runs in `predev` and `prebuild` | Preserve current commands through workspace scripts; later make generation explicit and reproducible |
| TypeScript | `apps/web/tsconfig.json`, strict mode, bundler resolution, `@/* -> ./src/*` alias relative to the app | Keep strictness; validate typechecking from the app workspace and root scripts |
| Next config | `apps/web/next.config.ts`; custom setting `allowedDevOrigins: ['192.168.18.6']` | Verify app-root discovery and LAN development after relocation |
| Styling/build config | Root `eslint.config.mjs`; `apps/web/postcss.config.mjs`; Tailwind CSS v4 | Keep lint tooling at root for now; app styling config stays with `apps/web` |
| Vercel config | No root `vercel.json` found at baseline | Project settings currently provide deployment configuration; do not infer settings from absent config file |
| Cloudflare config | No `wrangler.toml`, `wrangler.json`, or Worker entrypoint found at baseline | Create only after Worker/DO contracts and bindings are defined |
| CI | No GitHub Actions workflow found in initial audit | Add CI as part of repository foundation; do not deploy from migration branch |
| Tests | No test runner dependency or test script in baseline package manifest | Establish a focused test harness in the workspace foundation and add tests alongside slices |
| Ignore rules | Root `.gitignore` covers root Next output, node_modules, env files, Vercel, and TypeScript build artifacts | Add app-local Next output ignores and Cloudflare artifacts as those workspaces are introduced |

The Vercel project is `frc-gameday`, linked to `ThraceAerospace/frc-gameday`. Its migration-branch preview build is currently skipped by a project-level Ignored Build Step that checks `VERCEL_GIT_COMMIT_REF`. The project-level setting applies to the migration branch only; do not overwrite it casually. The current production/other-branch deployment behavior was intentionally left unchanged.

### Current root package scripts

- `npm run dev` → `next dev`
- `npm run build` → `next build`
- `npm run start` → `next start`
- `npm run lint` → `eslint`
- `predev` and `prebuild` regenerate TBA and Statbotics types.
- `generate:tba-types` fetches the TBA OpenAPI schema.
- `generate:statbotics-types` runs `scripts/generate-statbotics-types.mjs`.

Do not move the generator scripts or change their working-directory assumptions without validating generated output and the clean-install build.

## 2. Environment variables and external dependencies

The following names were found by source scan. This is a variable-name inventory only; no secret values are recorded.

| Variable | Current use | Target treatment |
|---|---|---|
| `TBA_API_KEY` | Server-side TBA authentication in `src/lib/tba/index.ts` | Secret binding for the TBA provider adapter |
| `TBA_WEBHOOK_TOKEN` | TBA webhook HMAC verification | Worker secret binding for webhook ingress |
| `REDIS_URL` | `ioredis` connection in `src/lib/cache/redis.ts` | Legacy-only during migration; replace per lifecycle need, not with blanket cache copying |
| `STATBOTICS_API_BASE_URL` | Optional Statbotics runtime endpoint override | Retain only for approved official/FieldView-operated compatible endpoint |
| `STATBOTICS_OPENAPI_URL` | Override for Statbotics type-generation schema URL | Build-time generator configuration; not a runtime provider credential |
| `NEXT_PUBLIC_DOMAIN` | Twitch embed parent-domain value | Web-only public configuration; assess replacement with request/deployment origin |
| `NEXT_PUBLIC_REMOTE_WEBSOCKET_URL` | Browser WebSocket host override | Legacy delivery configuration; replace with explicit web-to-backend endpoint configuration |

Vercel project environment-variable inventory was also checked with values withheld. The project has the following configured names/scopes:

| Variable | Configured targets | Notes |
|---|---|---|
| `TBA_API_KEY` | Production and Preview | Separate entries; no Development entry was returned |
| `TBA_WEBHOOK_TOKEN` | Production, Preview, and Development | Separate entries for each target |
| `REDIS_URL` | Production, Preview, and Development | Managed integration secret; values were not inspected |
| `NEXT_PUBLIC_CAST_APP_ID` | Production and Preview | Present in deployment configuration; source usage needs tracing |
| `NEXT_PUBLIC_DOMAIN` | Production | Browser-visible build/runtime configuration |
| `NEXT_PUBLIC_SITE_URL` | Production | Browser-visible build/runtime configuration |

No branch-specific environment-variable entries were returned for `fieldview-architecture-migration`. The source references `STATBOTICS_API_BASE_URL`, `STATBOTICS_OPENAPI_URL`, and `NEXT_PUBLIC_REMOTE_WEBSOCKET_URL`, but no corresponding Vercel project entries were present in the project-level environment list. In particular, the missing `STATBOTICS_API_BASE_URL` means the legacy runtime default remains active unless supplied through another deployment mechanism; this matches the provider-compliance finding FV-AUD-001. Do not infer that a missing project-level entry is absent from every possible runtime or external integration.

All values were requested with decryption disabled and were not inspected or copied into this inventory.

External systems/dependencies observed:
- The Blue Alliance REST API and TBA webhook sender.
- Official Statbotics API (the legacy default currently points to an unapproved community mirror; see FV-AUD-001).
- FRC Colors service.
- Redis-compatible hosted service for response caches, Pub/Sub, locks, and analytics jobs.
- Vercel Git integration, Next.js hosting, and Vercel-specific analytics/speed-insights/functions packages.
- Twitch player embeds.
- Browser WebSocket, SharedWorker, WebRTC, and remote display/session transport.

Before changing runtime configuration, inspect the actual Vercel environment-variable names/scopes without revealing values. Determine which variables are still needed by legacy routes, which move to Worker secrets/vars, and which are build-time or browser-visible. Do not copy credentials into Cloudflare until each use, access policy, and rotation path is defined.

## 3. Application and API route inventory

The source audit inspected 22 App Router API handlers. Their migration classification is:

| Current route | Current responsibility | Target classification |
|---|---|---|
| `GET /api/district` | Current-year district list | FieldView district query/service |
| `GET /api/district/all/cmp` | District teams advanced to CMP | FieldView district query/service |
| `GET /api/district/[district]/advancement` | District advancement results | FieldView district query/service |
| `GET /api/district/[district]/advancement/cmp` | District CMP advancement | FieldView district query/service |
| `GET /api/team/[team]` | TBA team record | FieldView team query/service |
| `GET /api/team/[team]/district` | Team district history/current district | FieldView team-season query/service |
| `GET /api/events/active` | Current-year active/upcoming event summary | FieldView event query; preserve event-timezone semantics |
| `GET /api/event/[event]` | TBA event record | FieldView event query |
| `GET /api/event/[event]/teams` | TBA event team roster | FieldView event-team collection |
| `GET /api/event/[event]/matches` | Canonical TBA event match schedule | FieldView event match collection |
| `GET /api/event/[event]/matches/next` | Derived next match | Domain/query projection over FieldViewMatch |
| `GET /api/event/[event]/matches/last` | Derived last completed match | Domain/query projection over FieldViewMatch |
| `GET /api/event/[event]/oprs` | TBA OPR/DPR/CCWM data | Normalized event metrics; source remains explicit |
| `GET /api/event/[event]/webcasts` | TBA webcast list | Normalized event media metadata |
| `GET /api/event/[event]/teams/statuses` | TBA team event statuses | FieldViewEventTeam state; refresh ownership still open |
| `GET /api/event/[event]/playoffs/alliances` | TBA playoff alliances | FieldViewPlayoffAlliance collection |
| `GET /api/statbotics/match/[match]` | Statbotics match prediction/record | Provider adapter input; publish normalized FieldView match metrics only |
| `GET /api/insights/event/[event]` | Assembled event analytics snapshot | Versioned FieldViewEventAnalytics contract |
| `GET /api/insights/team/[team]` | Assembled team season history | Versioned FieldViewTeamAnalytics contract |
| `GET /api/insights/team/[team]/matches` | Derived team match history/review analysis | Analytics service result and contract |
| `POST /api/tba/webhook` | Authenticated TBA webhook ingestion/cache mutation | Worker ingress → event reconciliation signal |
| `GET /api/remote/ws` | Remote-session WebSocket signaling upgrade | Worker/DO session transport; separate from event state |

The existing TBA proxy-style routes return provider-shaped payloads and are internal compatibility endpoints, not a stable public FieldView API. During migration, Next.js route handlers may remain thin same-origin BFF adapters, but they must translate to/from versioned FieldView contracts rather than expose provider schemas to the browser.

## 4. Provider integrations

| Current implementation | Target responsibility | Proposed destination | Treatment |
|---|---|---|---|
| `src/lib/tba/generated.ts`, `src/lib/tba/types.ts` | Raw TBA schema and provider types | `packages/providers/tba` | Generated/provider types remain private |
| `src/lib/tba/client.ts`, `src/lib/tba/service.ts` | TBA transport, ETags, cache policy, reconciliation | `packages/providers/tba` | Rebuild adapter boundary; preserve useful upstream semantics |
| `src/lib/tba/index.ts` | TBA client construction and credential wiring | `packages/providers/tba` | Inject Worker secrets/config rather than process globals |
| TBA webhook route and Redis mutation/realtime bridge | Webhook ingress and invalidation | `workers/backend/src/entrypoints` plus event reconciliation | Redesign around normalized event state |
| `src/lib/statbotics/generated.ts`, `src/lib/statbotics/types.ts` | Raw Statbotics schema and provider types | `packages/providers/statbotics` | Keep provider types private |
| `src/lib/statbotics/client.ts`, `src/lib/statbotics/service.ts` | Statbotics transport, cache, retries, request policy | `packages/providers/statbotics` | Rebuild; enforce approved endpoint |
| `src/lib/frc-colors/**` | FRC Colors acquisition and normalization | `packages/providers/frc-colors` | Isolated enrichment adapter |
| `scripts/generate-statbotics-types.mjs` | Build-time provider type generation | Provider package tooling | Keep generation reproducible and independent of Worker runtime |

**Boundary rule:** adapters return normalized FieldView domain values plus internal acquisition metadata. They must not publish raw provider responses to the browser. Normalization and aggregation remain separate.

## 5. State, realtime, and persistence

| Current implementation | Target responsibility | Proposed destination | Treatment |
|---|---|---|---|
| `src/lib/events/EventState.ts` | Event lifecycle, acquisition/reconciliation mixed with provider/client concerns | EventRuntime modules plus domain state | Decompose; no direct file transplant |
| SharedWorker and its client/controller modules | Browser-owned acquisition and cross-tab state | Backend EventRuntime plus client subscription adapter | Retire acquisition ownership after parity |
| `src/lib/realtime/**`, `src/app/api/ws/route.ts` | Redis Pub/Sub and WebSocket bridge | Worker/DO publication and subscription boundary | Replace transport while preserving client behavior |
| Redis provider caches | Provider response freshness/cache policy | Adapter cache policy and/or deliberate provider cache | Do not blanket-copy Redis keys |
| Redis analytics jobs/cohort records | Persistent progress and derived snapshots | DO SQLite or another explicit storage choice | Decide retention, recovery, and concurrency per lifecycle |
| Event status, alliances, rankings, OPR/DPR/CCWM, matches | Canonical event state | FieldView domain objects | Normalize and define field ownership/reconciliation |
| Remote WebRTC/session state | Shared controller and display session | Dedicated session runtime only if lifecycle requires it | Preserve controller authority; do not couple it to EventRuntime by default |

The initial runtime candidate is one EventRuntime per event. Event-team status refresh ownership and targeted-versus-full status acquisition remain open; avoid two runtimes polling the same authoritative endpoint.

## 6. Analytics

| Current implementation | Target responsibility | Proposed destination | Treatment |
|---|---|---|---|
| `src/lib/insights/calculations.ts` | Metric calculation logic | `packages/analytics` definitions and engine | Extract known operations; define semantics/version/scope |
| `src/lib/insights/service.ts` | Analytics orchestration | Worker application service | Assemble inputs and invoke engine |
| `src/lib/insights/progressive-service.ts` | Progressive acquisition/job orchestration | Worker orchestration; DO only if lifecycle/coordination requires | Reassess persistence and recovery |
| `src/lib/insights/season-cohort.ts` | Season-wide team-event collection/comparison | Analytics service and persisted job/runtime state | Preserve latest-prior-event comparison semantics |
| `src/components/insights/EventAnalyticsDashboard.tsx` | Analytics presentation | `apps/web/features/insights` | Split presentation; remove browser calculations |
| `/api/insights/**` | Analytics request/response boundary | Worker API plus optional web BFF | Return versioned FieldView analytics contracts |

The engine must not fetch providers or know about UI. Definitions declare inputs, operation, output semantics, scope, version, and interpretation. Collection calculations expose eligible population and sample size. Keep calculations, comparison/classification, summaries, and rendering separate.

## 7. Frontend and remote surfaces

| Current implementation | Target responsibility | Proposed destination | Treatment |
|---|---|---|---|
| `src/app` | Web routes/layouts and route adapters | `apps/web/app` | Relocate after workspace foundation |
| `src/components/event`, `eventview`, `match`, `team` | Feature presentation | `apps/web/features/**` | Move incrementally by feature |
| `src/components/multiview`, `src/components/surface/**` | Tile View and remote controller presentation | `apps/web/features/remote` and gameday | Preserve stable identity/priority/layout/controller rules |
| `src/components/insights/**` | Analytics presentation | `apps/web/features/insights` | Consume server-calculated DTOs |
| `src/lib/**` shared helpers | Domain, provider, analytics, or web-specific utilities | Split by ownership across packages and app | Do not move by filename alone |
| Shared UI primitives | Web UI primitives | `apps/web/components` | Keep web-local until another consumer exists |

Exact component moves require import-graph tracing. The target package boundaries are ownership boundaries, not a mandate to split every helper into its own package.

## 8. Historical audit findings as migration acceptance criteria

The 104 findings in `docs/APPLICATION-AUDIT.md` should be dispositioned by risk category:

- **Provider correctness/provenance:** FV-AUD-001, 043, 067, 077, 078, 101 → provider adapter and normalization tests.
- **Provider-independent contracts:** FV-AUD-006, 017, 026, 029 → domain/contract boundary tests.
- **Realtime/cache consistency:** FV-AUD-004, 028, 035, 050–055, 070 → reconciliation, ordering, freshness, publication tests.
- **Analytics correctness/ownership:** FV-AUD-010, 011, 014, 022, 096–100 → analytics definition/engine fixtures and presentation constraints.
- **Persistence/concurrency:** FV-AUD-012, 057, 062, 080, 094, 099 → storage schema, concurrency, recovery, and partial-failure requirements.
- **Remote sessions:** FV-AUD-020, 032, 033, 073, 084, 085 → controller/session integration tests.
- **Validation/resource limits:** FV-AUD-071, 082, 102, 104 → API/input validation and bounded-resource tests.

These references are not assumed to remain defects in the new architecture. Revalidate each against the target implementation and close it when its risk is eliminated or explicitly accepted.

## 9. Open architecture decisions

These must be resolved through focused decision records before implementing their subsystem:

1. **EventRuntime ownership:** exact authoritative event resources versus derived projections.
2. **Event-team status refresh:** endpoint availability/cost, targeted refresh feasibility, full-event reconciliation interval, and webhook dirtying strategy.
3. **Publication protocol:** snapshot versus change events, version sequencing, reconnect replay, subscription authorization, and backpressure.
4. **Persistence boundary:** DO SQLite versus recomputable state versus external storage; retention and recovery requirements.
5. **Provider cache policy:** which upstream freshness/ETag semantics are preserved, translated, or retired.
6. **Web API boundary:** thin same-origin Next.js BFF versus direct browser-to-Worker API for each resource.
7. **Remote session ownership:** runtime boundary and how session/controller state composes with event subscriptions.

## 10. Immediate sequence

1. Finish deployment/environment-variable and import-graph verification before moving files.
2. Keep `AGENTS.md` aligned with the target architecture and product invariants.
3. Establish npm workspaces with the existing Next.js app still at the root as the first behavior-preserving step; relocate it to `apps/web` only as a separate verified change.
4. Add CI and the initial test harness before domain/provider/runtime migration.
5. Define versioned domain and client contracts before replacing legacy acquisition or publishing new state.

**Current implementation status:** the migration plan and inventory are documentation only. The repository still has one root Next.js app and the legacy Redis/SharedWorker/Vercel data path. No Cloudflare Worker, Durable Object, workspace package, or production infrastructure is claimed to exist.


## Runtime ownership correction (2026-11-20)

- EventRuntime: event-scoped TBA and Statbotics data only; coordinates with TeamRuntime instances for participating-team data; no team-scoped data persistence.
- TeamRuntime: team-scoped TBA and Statbotics data plus FRC-Colors; durable ETags and cached representations; active-event membership awareness and activity-sensitive polling.
- TaskScheduler: generic daily/background job and lifecycle orchestrator, including event discovery, EventRuntime creation, and event-week classification. It must not proxy normal runtime provider traffic.
- EventRuntime and TeamRuntime provider requests are concurrent within and across Durable Objects. A global request lease or mutex is prohibited.
