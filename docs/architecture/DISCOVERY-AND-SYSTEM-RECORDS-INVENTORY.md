# Discovery and System Records inventory

**Current implementation inventory — 2026-11-27**

This document describes the final branch architecture. It replaces the older DiscoveryStore Durable Object and R2-shaped record transport analysis. The migration branch has never been deployed; there are no legacy records or queue messages to preserve.

## Storage ownership

| Logical owner | D1 table | Record families |
|---|---|---|
| Discovery | `discovery_records` | Provider-backed season, event, and team directories; staged directory generations; weekly event projection |
| System Records | `system_records` | Runtime registration markers; Workflow/admin run records; operational cursors and audit state |

`D1RecordStore` is the in-process D1 repository router. It sends discovery keys to `discovery_records` and operational keys (`admin/`, `workflow/`, and `registry/runtime-*`) to `system_records`. Its multi-record operation batches writes and deletes across the owning tables.

There is no DiscoveryStore Durable Object, R2 bucket, R2 object-body contract, R2 metadata, or generic HTTP key/value API.

## Discovery record families

- `discovery/current-season.json`: the persisted current-season pointer and its provider check metadata.
- `discovery/teams/{year}.json`: team-directory manifest, generation, page count, and team count.
- `discovery/team-pages/{year}/{generation}/{page}.json`: generation-scoped team pages used for bounded acquisition and publication.
- `discovery/events/{year}.json`: event directory for a season.
- `discovery/event-staging/**`: bounded staging/chunk records used while publishing event directories.
- `projections/events-this-week/current.json`: one canonical weekly-event projection record.

The DiscoveryService owns provider-backed catalog operations and generation publication. It can resolve the current season, acquire team pages, resume a partial team directory, publish team directories, acquire event directories, write bounded event chunks, and publish event directories.

## System record families

- `registry/runtime-events/{eventKey}.json` and `registry/runtime-teams/{teamKey}.json`: explicit runtime registration markers.
- `admin/workflow-runs/{type}/{id}/record.json`: administrative Workflow execution records and summaries.
- `admin/coverage-audits/**`: coverage audit cursor, counts, and resumable progress.
- `workflow/**`: operational Workflow records that are not provider catalog data.

Runtime registration and admin inspection read these records directly from System Records D1. They do not depend on a DiscoveryStore object or a generic cross-domain storage service.

## In-process record contract

`createDiscoveryServiceClient(env)` provides typed in-process access:

- `get<T>(key)` returns a parsed JSON value or `null`.
- `put(key, jsonText)` validates JSON and writes the D1 record.
- `list({ prefix, cursor, limit })` returns record keys with an exclusive cursor and a truncation indicator.
- `catalog(action, input)` invokes a domain-specific DiscoveryService catalog operation.

The client does not expose R2 object wrappers such as `.json()`, `.text()`, or `httpMetadata`. The Worker does not expose generic `/get`, `/put`, or `/list` HTTP endpoints. The internal discovery route is limited to domain catalog operations.

`RuntimeEnvironment.DISCOVERY_STORAGE` is only an injectable in-memory record adapter for isolated tests. It is not a Wrangler binding or a production fallback. Deployed runtime code uses the configured D1 database.

## Read/write boundaries

- Listing and reading records are read-only.
- Provider catalog operations write only their explicit directory, pointer, staging, and check-metadata records.
- Runtime registration writes occur only on explicit registration/refresh paths.
- Workflow/admin records are written by the owning workflow operations.
- Snapshot reads do not access this record store to materialize EventState or TeamState. Those projections are constructed from the endpoint records held by EventRuntime and TeamRuntime.
- No queue producer, queue consumer, R2 binding, Redis store, or legacy DiscoveryStore Durable Object is part of the architecture.

## Validation and deployment status

Repository CI validates the D1 schema and the direct record contracts. The remote D1 migrations and Worker bindings have not been applied or verified because this branch has never been deployed.

Final integration testing must use a clean Cloudflare Preview resource baseline, verify discovery publication and system-record reads/writes, and inspect actual D1/DO write counts. No historical data migration is required.
