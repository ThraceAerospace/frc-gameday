# FieldView Agent Instructions

## Project and migration status

FieldView is a data application for FIRST Robotics Competition. Its web application presents live event information, team/event history, remote display sessions, and server-calculated analytics.

The repository is undergoing an **incremental architecture migration** on branch `fieldview-architecture-migration`. The current Next.js/Vercel/Redis/SharedWorker implementation is the legacy system being migrated, not the target architecture. Preserve a working application throughout the migration; do not perform a clean rebuild or a production cutover before the replacement path is validated.

## Confirmed target decisions

- Monorepo: npm workspaces.
- Frontend: retain Next.js.
- Migration: incremental, with temporary compatibility adapters where necessary.
- Backend: hybrid Cloudflare Workers and Durable Objects.
- Runtime ownership: one EventRuntime per event and one TeamRuntime per team. EventRuntime owns event-scoped provider data only; TeamRuntime owns team-scoped TBA, Statbotics, and FRC-Colors data. TaskScheduler owns system-wide scheduled jobs and runtime lifecycle orchestration.
- Domain and analytics packages must be reusable independently of Next.js and Cloudflare. The domain may use provider packages as type-only dependencies for unchanged provider-sourced fields; it must not depend on provider clients or transport at runtime.
- Provider-independent FieldView domain contracts are the only data contracts the frontend should consume.
- The migration branch has Vercel preview deployments intentionally skipped through the project's Ignored Build Step. Do not remove or override this branch-specific setting in repository work.

See `docs/architecture/MIGRATION-PLAN.md` and `docs/architecture/MIGRATION-INVENTORY.md` for phase sequencing and known legacy mappings.

## Non-negotiable product and data principles

1. **FieldView owns its domain model.** External APIs are inputs, not the application's public data model.
2. Pass provider payloads unchanged into FieldView domain normalization. Preserve provider field names, values, types, nullability, and structures. Provider schemas remain in provider packages; the backend domain may use their types for pass-through fields.
3. Keep acquisition, normalization, domain state/reconciliation, derivation, and presentation as distinct responsibilities.
4. Preserve provenance and freshness internally. Distinguish unavailable/missing data, explicit null/clear, zero, stale values, and failed acquisition.
5. A failed or partial provider request must not erase unrelated valid state. A successful explicit clear may clear the corresponding prior value.
6. Define source precedence per field. Do not let request timing or incidental merge order decide which source wins.
7. Build data capabilities once and make them reusable across web pages, live surfaces, remote displays, and future consumers.
8. Server-side calculations are authoritative. Presentation components must not independently reproduce analytics or fetch providers.
9. Do not claim a public developer API, production Cloudflare runtime, Durable Object, or completed migration until it exists and has been validated.

## Target repository boundaries

The planned npm workspace layout is:

- `apps/web` — Next.js application, pages, UI, and web-specific route adapters.
- `workers/backend` — Cloudflare Worker entrypoints, backend application services, and Durable Object runtime implementations.
- `packages/domain` — canonical FieldView domain objects, FieldView normalization/correlation, and domain rules.
- `packages/contracts` — versioned serializable client-facing DTOs and validation schemas.
- `packages/providers/*` — isolated provider clients, raw provider types, validation, normalization, retries, rate limits, and source metadata.
- `packages/analytics` — declarative metric definitions and a small provider/UI-independent calculation engine.
- `packages/config` or root configuration — shared TypeScript/lint/tooling only when reuse justifies it.

This is a target boundary map, not permission to move every existing folder mechanically. Keep changes small, trace imports, and validate the build after each structural step. Do not create placeholder packages without a concrete first consumer.

## Provider adapter boundary
### Provider package ownership

Each external provider has one self-contained package under `packages/providers/<provider>/`.

Everything specific to that provider belongs in that package:
- generated OpenAPI types and raw provider schemas;
- schema-generation scripts, configuration, and supporting files;
- provider API clients and service layers;
- provider-specific validation and response types;
- provider-specific request, retry, rate-limit, and freshness behavior.

Do not split generated schemas, clients, services, or normalization into separate generic packages. Do not put provider-owned implementation or generated types in `apps/web` or `packages/domain`.

The domain may depend on provider packages for types only. It must not import provider clients, service implementations, or transport code. Client contracts must not import or expose provider types.

Provider packages own:
- API transport, credentials, provider-specific request/response types, and generated schemas;
- retry, backoff, rate limiting, and provider-specific request behavior;
- unchanged provider payload delivery to the FieldView domain normalization layer.

FieldView domain normalization owns cross-provider correlation, associations, and explicitly approved transformations. Analytics calculations remain in the analytics layer. Provenance and freshness are maintained by backend acquisition/orchestration and associated with domain state.

Provider packages must not expose raw provider response objects directly to the frontend or published client DTOs. The backend domain may use provider types to preserve source values. Do not leak names such as `TBAEvent`, `TBAMatch`, `StatboticsMatch`, provider status enums, or provider response envelopes into client-facing contracts.

Provider packages do not normalize, correlate, aggregate, or calculate FieldView values. They deliver unchanged provider payloads to the FieldView domain. The domain owns canonical model construction, cross-source associations, and explicitly approved transformations; analytics calculations remain in the analytics layer. Preserve field-level source precedence and partial-failure semantics.

Statbotics runtime data may come only from the official API (`https://api.statbotics.io`) or a FieldView-operated compatible fork. Do not use a community-operated mirror. Keep the provider endpoint configurable only for approved compatible endpoints.

## Domain model and runtime ownership

Canonical domain concepts include:
- `FieldViewTeam` and `FieldViewTeamSeason`;
- `FieldViewEvent` and `FieldViewEventTeam`;
- `FieldViewMatch` and `FieldViewPlayoffAlliance`;
- `FieldViewDistrict`;
- `FieldViewEventAnalytics` and `FieldViewTeamAnalytics`.

A domain object is data; a runtime is machinery that acquires, reconciles, persists, and publishes data. Do not create a Durable Object for every interface or DTO.

Use one event-scoped EventRuntime per event and one team-scoped TeamRuntime per team. EventRuntime owns canonical event data and event-wide analytics only. TeamRuntime owns canonical team/season data, every team-specific event state, and all team-scoped analytics. TeamRuntime tracks every event in which its team is actively competing. EventRuntime consumes TeamRuntime-owned FieldViewTeamEventState records to calculate event-wide rankings and other field-level metrics; it must not independently recalculate team-scoped metrics. TaskScheduler is a generic system orchestrator for discovery, runtime initialization, daily jobs, lifecycle transitions, scheduled roster reconciliation, and maintenance; it does not proxy provider requests for runtimes.

Maintain one authoritative writer for each state resource. EventRuntime owns event-scoped TBA/Statbotics resources; TeamRuntime owns team-scoped TBA/Statbotics/FRC-Colors resources. Do not duplicate team-scoped provider data in EventRuntime or event-scoped provider data in TeamRuntime. Both runtime types issue provider requests directly and may execute requests concurrently within and across Durable Objects; do not add a global provider-request lease, mutex, or serialized queue. Persist each resource's ETag and cached representation indefinitely; freshness expiration triggers revalidation and must never be treated as a storage TTL. TeamRuntime must persist a possibly partial FieldViewTeamState as part of runtime initialization and refresh it when its provider inputs change. TeamRuntime also persists per-event FieldViewTeamEventState and FieldViewTeamEventAnalytics. EventRuntime persists FieldViewEventState and FieldViewEventAnalytics, and composes event views from the event state plus participating TeamRuntime event states. Publish versioned snapshots or changes with explicit ordering/reconnect semantics; do not make clients reconstruct authoritative state from incidental provider events.

For event-team status, preserve the distinction between match freshness and team-status freshness. The TBA full-event status dataset is a coherent source for event team status; targeted refresh versus periodic full reconciliation remains a documented design decision until endpoint availability/cost and invalidation behavior are verified. Successful explicit null clears; failed fetches do not clear prior valid state. Derive user-facing summaries from structured normalized fields rather than provider HTML strings.

## Analytics architecture

Analytics must be easy to inspect, explain, test, and modify.

- Analytics ownership follows scope: TeamRuntime owns team and team-event calculations; EventRuntime owns event-wide calculations and aggregation over participating TeamRuntime results.
- TeamRuntime recalculates team metrics against its own season data and persists the result in FieldViewTeamEventAnalytics / FieldViewTeamEventState. EventRuntime may rank or compare those results but must not reproduce their underlying team-scoped calculations.
- A complete event FieldView is FieldViewEventState + FieldViewEventAnalytics + the roster's array of FieldViewTeamEventState records. TaskScheduler performs roster reconciliation on a scheduled job, not as a side effect of ordinary event reads.
- Every generated model uses the FieldView prefix. Provider-originated models retain their provider prefix (TBA, Statbotics, FRCColors). Canonical names include FieldViewTeamState (team/season), FieldViewTeamEventState (team/event), FieldViewTeamEventAnalytics (team/event analytics), and FieldViewEventAnalytics (event analytics).

- Metric definitions declare inputs, operation, output semantics/unit, scope, version, and relevant interpretation/limitations.
- A small generic engine resolves supplied inputs, validates them, and executes a registered vocabulary of safe operations.
- Do not use `eval()`, arbitrary expression strings, or provider/UI-specific code in the engine.
- Complex metrics compose known operations rather than introducing hidden bespoke execution paths.
- Support both per-object and collection/event-wide calculations. Collection results must expose eligible population and sample size.
- Keep calculation, comparison/classification, human-readable interpretation, and UI rendering separate.
- Do not fetch providers from the engine. Inputs are passed in by orchestration.
- Keep missing, null, and zero distinct; version definitions so historical results can be compared deliberately.

Analytics conclusions are descriptive evidence, not causal determinations. Alliance residuals, shared model updates, win-probability mismatches, and partner patterns must not be attributed to an individual robot. Review flags invite a human scout to investigate.

For event-wide team change comparisons, compare each team against its own most recent prior official event. Include all target-event teams in event views, but rank only teams with usable prior/current data. Do not require a shared prior event and do not silently fall back to an older event when the most recent prior event lacks usable data. Show eligible comparison coverage. See `docs/ANALYTICS-REDESIGN.md`.

## Event time

**All event-related dates, times, and datetimes displayed by the application must use that event's IANA timezone.**

- Do not display event dates/times in the viewer's browser timezone or silently fall back to browser-local formatting.
- In multi-event views, format each event using its own timezone.
- Countdown values are relative durations and do not require a timezone conversion in the display.
- Use the event timezone consistently for schedules, match times, timestamps, date labels, and event comparisons.

The goal is consistency with the venue and announcers.

## Frontend, live views, and remote sessions

The frontend consumes versioned FieldView DTOs and presentation state; it does not own provider acquisition or canonical reconciliation.

Preserve these product semantics during migration:
- Match presentation uses red/blue alliance identity only in match context. A team in `dq_team_keys` is displayed with a strikethrough in that match.
- Preserve established next/last match semantics and stale-response protection until an explicitly validated replacement exists.
- Keep remote-session controller authority and display clients separate. Remote actions must use the same controller path as local actions.
- Keep content/data, stable tile identity, priority, layout, and highlight as separate concepts. Never reorder stable streams merely to change priority.
- TileSurface is a deliberately dark-only broadcast surface; retain restrained FieldView purple accents and semantic alliance colors.
- Do not reintroduce Nexus unless explicitly requested.

The existing SharedWorker, browser EventState, Redis Pub/Sub, WebSocket bridge, and current API routes are legacy delivery/acquisition mechanisms. Preserve their behavior only while required for the incremental transition. Do not treat them as the target source of truth or add new dependencies on them. Avoid adding new provider-shaped fields to their snapshots; introduce compatibility mapping at the boundary.

## Existing legacy system — migration reference only

The current implementation includes:
- one Next.js application rooted at the repository root;
- 22 API route handlers at the time of the initial audit;
- Redis-backed TBA/Statbotics/FRC Colors caches and analytics job records;
- TBA webhook ingress, Redis Pub/Sub, and `/api/ws`;
- browser SharedWorker/EventState acquisition and reconciliation;
- server-side insights calculations and progressive collection;
- Vercel deployment/runtime integration.

Known legacy paths include `src/lib/tba`, `src/lib/statbotics`, `src/lib/frc-colors`, `src/lib/cache`, `src/lib/realtime`, `src/lib/events`, and `src/lib/insights`. These are migration sources, not mandatory target locations.

Never copy legacy implementation rules into new packages merely for parity. Preserve user-visible behavior and correctness, not obsolete infrastructure choices.

## Workspace and tooling rules

- Use npm workspaces; do not introduce another package manager.
- Keep Next.js as the web framework.
- Keep root scripts explicit and delegate app-specific scripts to the relevant workspace.
- Use the repository's pinned Node/npm compatibility and lockfile consistently. Do not silently regenerate or replace the lockfile with another package manager.
- Keep generated provider types generated; do not hand-edit generated output.
- Do not add Cloudflare resources or deploy backend infrastructure until local contracts, bindings, and runtime responsibilities are defined and validated.
- Do not relocate the Next.js app until current build configuration, environment dependencies, and import aliases have been mapped.
- Do not make production changes or cut over traffic as part of a structural migration step.

## Environment and secrets

Never commit secrets or real environment values. Document variable names, purpose, scope, and migration destination; use placeholders in examples. Separate browser-exposed `NEXT_PUBLIC_*` configuration from server-only credentials. Do not copy Vercel-specific secrets into Cloudflare without defining their use, access policy, and rotation.

Current legacy environment variables identified during the initial source scan include:
- `TBA_API_KEY`
- `TBA_WEBHOOK_TOKEN`
- `REDIS_URL`
- `STATBOTICS_API_BASE_URL`
- `STATBOTICS_OPENAPI_URL`
- `NEXT_PUBLIC_DOMAIN`
- `NEXT_PUBLIC_REMOTE_WEBSOCKET_URL`

This list is provisional; re-scan the source and deployment settings before changing runtime configuration. Never print or expose secret values.

## Design system and accessibility

- Follow `docs/COLOR-SYSTEM.md`. Purple is FieldView branding; red/blue are reserved for alliance identity in match context; gold/greens are metric percentile tiers; orange is a human-review indicator; team colors are provider metadata.
- Do not use generic blue utility colors for product branding, navigation, links, selection, or focus.
- Centralize non-Tailwind design values in semantic CSS custom properties. Use Tailwind for standard layout/styling where appropriate.
- Site link hover/focus uses FieldView purple. Preserve accessible focus states and semantic controls.

## Code quality and change discipline

- Search for and reuse existing helpers before adding new logic. Use `src/lib/time` for legacy date/time behavior until migrated.
- Keep route handlers thin; business logic belongs in reusable services/packages.
- Keep provider acquisition out of presentation components.
- Avoid broad unrelated refactors, dead-file cleanup, or visual changes during architecture work.
- Before deleting a file, search repository-wide for imports and callers and confirm no live use remains.
- Prefer small, focused commits with a clear purpose. Keep the branch buildable after each migration slice.
- Update README and architecture docs when behavior or ownership changes materially.
- Never modify `main` as part of this migration. Work on `fieldview-architecture-migration` unless the user explicitly changes scope.

## Agent documentation

`CLAUDE.md` must remain the one-line pointer `@AGENTS.md` so all repository agents use this source of truth.
