# FieldView Migration Inventory

**Status:** Initial inventory; source-level verification remains in progress  
**Branch:** `fieldview-architecture-migration`  
**Baseline commit:** `9bf16698` (pre-migration baseline recorded during the initial audit)

This inventory translates the existing application audit into migration work. It is intentionally organized by responsibility rather than by a mechanical file move. Paths below are known legacy locations; target paths are proposed destinations.

## 1. Application and deployment

| Current implementation | Target responsibility | Proposed destination | Treatment |
| --- | --- | --- | --- |
| Root Next.js application and `src/app` | Web application and presentation routes | `apps/web/app` | Preserve behavior; relocate during workspace foundation |
| `src/app/api/**` route handlers | Web-facing BFF routes or backend API entrypoints | Web routes under `apps/web` where UI-specific; backend handlers under `workers/backend` | Classify individually; do not move all routes mechanically |
| Root Next.js configuration, Tailwind, PostCSS, ESLint, TypeScript configuration | Web workspace tooling | `apps/web` plus root shared configuration | Relocate and verify build parity |
| Vercel-specific deployment/runtime dependencies | Legacy deployment adapter | Retain only while legacy paths need them; new backend uses Cloudflare | Remove only after callers and production dependencies are retired |

## 2. Provider integrations

| Current implementation | Target responsibility | Proposed destination | Treatment |
| --- | --- | --- | --- |
| `src/lib/tba/generated.ts`, `src/lib/tba/types.ts` | Raw TBA schema and application-facing provider types | `packages/providers/tba` | Keep generated provider types private to adapter |
| `src/lib/tba/client.ts`, `src/lib/tba/service.ts` | TBA transport, caching, retries, request policy | `packages/providers/tba` | Rebuild adapter boundary; preserve useful HTTP semantics |
| TBA webhook route and Redis mutation/realtime bridge | Webhook ingress and invalidation | `workers/backend/src/entrypoints` and event reconciliation | Redesign around EventRuntime; do not carry Redis-specific assumptions forward |
| `src/lib/statbotics/generated.ts`, `src/lib/statbotics/types.ts` | Raw Statbotics schema and provider types | `packages/providers/statbotics` | Keep provider types private |
| `src/lib/statbotics/client.ts`, `src/lib/statbotics/service.ts` | Statbotics transport, caching, retries, request policy | `packages/providers/statbotics` | Rebuild; enforce approved official or FieldView-operated endpoint |
| `src/lib/frc-colors/**` | FRC Colors acquisition and normalization | `packages/providers/frc-colors` | Migrate as isolated enrichment adapter |

**Boundary rule:** adapters return normalized FieldView domain values and internal acquisition metadata. They must not publish raw provider responses to the browser.

## 3. State, realtime, and persistence

| Current implementation | Target responsibility | Proposed destination | Treatment |
| --- | --- | --- | --- |
| `src/lib/events/EventState.ts` | Event lifecycle, acquisition/reconciliation currently mixed with provider and client concerns | EventRuntime modules plus domain state | Decompose by responsibility; no direct file transplant |
| SharedWorker and its client/controller modules | Browser-owned acquisition and cross-tab state | Backend EventRuntime ownership plus client subscription adapter | Retire acquisition ownership from browser after backend parity |
| `src/lib/realtime/**`, `src/app/api/ws/route.ts` | Redis Pub/Sub and WebSocket bridge | Worker/Durable Object publication and subscription boundary | Replace transport and ownership; retain only required client protocol behavior |
| Redis cache and analytics job records | Provider response cache and application job state | Provider cache policy and Durable Object/SQLite or other deliberate storage | Decide per data lifecycle; no blanket Redis-to-SQLite copy |
| Event status, alliances, rankings, OPR/DPR/CCWM, match data | Canonical event-scoped domain state | `FieldViewEvent`, `FieldViewEventTeam`, `FieldViewMatch`, `FieldViewPlayoffAlliance` | Normalize, define field ownership and reconciliation semantics |

The EventRuntime is the initial candidate for one authoritative event-scoped owner. Event-team status refresh ownership and targeted-vs-full status acquisition remain explicit design questions; avoid two runtimes polling the same authoritative event-status endpoint.

## 4. Analytics

| Current implementation | Target responsibility | Proposed destination | Treatment |
| --- | --- | --- | --- |
| `src/lib/insights/calculations.ts` | Metric calculation logic | `packages/analytics/engine` plus definitions | Extract reusable operations; express metric meaning declaratively |
| `src/lib/insights/service.ts` | Analytics orchestration | Worker application service | Reduce to input assembly and engine invocation |
| `src/lib/insights/progressive-service.ts` | Progressive acquisition/job orchestration | Worker job orchestration; Durable Object only if coordination/persistence requires it | Reassess lifecycle and state ownership |
| `src/components/insights/EventAnalyticsDashboard.tsx` | Analytics presentation | `apps/web/features/insights` | Split into feature-level presentation components; remove browser calculations |
| `/api/insights/**` routes | Analytics request/response boundary | Worker API plus web-facing route adapter if needed | Return versioned FieldView analytics contracts |

The analytics engine must not fetch providers or know about UI. Definitions should specify inputs, operation, output semantics, scope, and version. Collection-wide calculations must expose eligible population and sample size.

## 5. Frontend features and remote surfaces

| Current implementation | Target responsibility | Proposed destination | Treatment |
| --- | --- | --- | --- |
| Event pages and event components | Event browsing and event presentation | `apps/web/features/events` | Preserve product behavior; consume FieldView contracts |
| Team pages and team components | Team browsing and team presentation | `apps/web/features/teams` | Consume team/team-season/event-team contracts |
| Gameday and EventView components/hooks | Live event presentation | `apps/web/features/gameday` | Remove shared data acquisition from views |
| Tile View / Multiview components and `TileSurfaceController` | Surface presentation and controller behavior | `apps/web/features/remote` and `apps/web/features/gameday` | Preserve stable tile identity, priority/layout separation, and controller authority |
| Insights dashboard components | Analytics presentation | `apps/web/features/insights` | Render server-calculated analytics results |
| Shared visual components | UI primitives | `apps/web/components` | Keep inside web workspace until another consumer exists |

The exact file-level mapping for feature components and API routes is a follow-up inventory task. This table establishes ownership, not permission to move folders without tracing imports and behavior.

## 6. Historical audit findings as migration acceptance criteria

The 104 findings in `docs/APPLICATION-AUDIT.md` should be dispositioned as follows:

- **Provider correctness / provenance:** FV-AUD-001, 043, 067, 077, 078, 101 become provider adapter and normalization tests.
- **Provider-independent contracts:** FV-AUD-006, 017, 026, 029 become domain/contract boundary tests.
- **Realtime/cache consistency:** FV-AUD-004, 028, 035, 050–055, 070 become reconciliation, ordering, freshness, and publication tests.
- **Analytics correctness and ownership:** FV-AUD-010, 011, 014, 022, 096–100 become analytics definition/engine fixtures and frontend presentation constraints.
- **Persistence/concurrency:** FV-AUD-012, 057, 062, 080, 094, 099 become storage schema, concurrency, recovery, and partial-failure requirements.
- **Remote sessions:** FV-AUD-020, 032, 033, 073, 084, 085 become controller/session integration tests.
- **Validation and resource limits:** FV-AUD-071, 082, 102, 104 become API/input validation and bounded-resource tests.

These references are not assumed to remain defects in the new architecture. Revalidate each against the target implementation and close it when its risk is eliminated or explicitly accepted.

## 7. Open design questions before M2/M3

1. **EventRuntime state ownership:** which event resources are authoritative event state, and which are derived projections?
2. **Event-team status refresh:** confirm available TBA endpoints and request costs before selecting webhook-triggered targeted refresh versus periodic full-event reconciliation.
3. **Publication contract:** snapshot vs change events, version sequencing, reconnect replay, and client subscription authorization.
4. **Persistence boundary:** which state belongs in Durable Object SQLite, which can be recomputed, and what retention is required?
5. **Provider cache policy:** which provider freshness semantics should be preserved, translated, or retired?
6. **Web API boundary:** whether Next.js route handlers remain a thin same-origin BFF or the browser talks directly to Worker APIs.
7. **Remote session ownership:** where session/controller authority lives in the target backend and how it composes with event subscriptions.

Resolve these through small architecture decision records before implementing the corresponding subsystem.

## 8. Immediate follow-up

Complete a source-level route/import/dependency inventory, then update `AGENTS.md` to distinguish current legacy behavior from target migration rules. Do not start the workspace relocation until the current build/deployment configuration and environment-variable dependencies have been mapped.
