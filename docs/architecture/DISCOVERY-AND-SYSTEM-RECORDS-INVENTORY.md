# Discovery and System Records

**Current repository contract:** 2026-11-27

## Storage ownership

| Logical owner | D1 table | Record families |
|---|---|---|
| Discovery | `discovery_records` | Provider-backed season, event, and team directories; staged directory generations; weekly event projection |
| System Records | `system_records` | Runtime registration markers; Workflow/admin run records; operational cursors and audit state |

`D1RecordStore` routes discovery keys to `discovery_records` and operational keys (`admin/`, `workflow/`, and `registry/runtime-*`) to `system_records`. The repositories have separate ownership even though they share a physical D1 database.

There is no DiscoveryStore Durable Object, R2 bucket, R2 object-body contract, R2 metadata, or generic HTTP key/value API.

## Discovery record families

- `discovery/current-season.json`: canonical current-season pointer and provider check metadata.
- `discovery/teams/{year}.json`: team-directory manifest, generation, page count, and team count.
- `discovery/team-pages/{year}/{generation}/{page}.json`: generation-scoped team pages.
- `discovery/events/{year}.json`: season event directory.
- `discovery/event-staging/**`: bounded staging/chunk records used while publishing directories.
- `projections/events-this-week/current.json`: canonical weekly-event projection pointer.

DiscoveryService owns provider-backed catalog operations, bounded acquisition, resumable team pagination, and directory generation publication.

## System record families

- `registry/runtime-events/{eventKey}.json` and `registry/runtime-teams/{teamKey}.json`: explicit runtime registration markers.
- `admin/workflow-runs/{type}/{id}/record.json`: administrative Workflow execution records and summaries.
- `admin/coverage-audits/**`: coverage audit cursor, counts, and resumable progress.
- `workflow/**`: operational Workflow records that are not provider catalog data.

Runtime registration is operational metadata. Creating a new registration is part of explicit first-time runtime initialization, not a side effect of a public snapshot read.

## In-process record contract

`createDiscoveryServiceClient(env)` provides typed in-process access:

- `get<T>(key)` returns parsed JSON or `null`.
- `put(key, jsonText)` validates JSON and writes a record.
- `list({ prefix, cursor, limit })` returns keys with an exclusive cursor and truncation indicator.
- `catalog(action, input)` invokes a domain-specific DiscoveryService operation.

The client does not expose R2 object wrappers such as `.json()`, `.text()`, or `httpMetadata`. The Worker does not expose generic `/get`, `/put`, or `/list` endpoints. The internal discovery route is limited to domain catalog operations.

## Read/write boundaries

- Listing and reading records are read-only.
- Provider catalog operations write only their explicit directory, pointer, staging, and check-metadata records.
- Runtime registration and bootstrap markers are written only by explicit initialization workflows/operations.
- Workflow/admin records are written by their owning operations.
- EventState and TeamState snapshot reads do not use D1 to materialize projections; their owning Durable Objects derive projections from stored provider endpoint records.
- No Queue producer/consumer, R2 binding, Redis store, or legacy DiscoveryStore Durable Object is part of the architecture.

## Deployment

Repository CI validates the D1 schema and direct record contracts. Remote migrations and Worker bindings must be applied only as part of the separately approved production cutover. Preview integration must verify discovery publication and System Records behavior without touching production resources.
