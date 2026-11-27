# FieldView documentation

This documentation describes the intended production architecture and the current repository interfaces. ADR-0020 is the governing decision for provider-record storage, ephemeral state projections, and snapshot-first/data-bearing realtime.

## Start here

- [Architecture overview](ARCHITECTURE.md) — system boundaries and ownership.
- [Runtime lifecycle](development/FIELDVIEW-RUNTIME.md) — acquisition, initialization, reads, polling, and realtime.
- [Cloudflare deployment](development/CLOUDFLARE-ENVIRONMENTS.md) — the single Worker and Preview model.
- [EventState and analytics](EVENT-STATE-AND-ANALYTICS.md) — client projections and analytics contracts.
- [Production integration and cutover](architecture/MIGRATION-PLAN.md) — final validation gates.
- [Architecture decisions](architecture/decisions/) — durable decisions and their supersession status.

## Supporting references

- [Domain data model](domain/FIELDVIEW-DATA-MODEL-V1.md)
- [TBA provider types](TBA-TYPES.md)
- [Statbotics provider types](STATBOTICS-TYPES.md)
- [TBA schema gaps](providers/TBA-API-SCHEMA-GAPS.md)
- [Analytics result contract](analytics/DOMAIN-RESULT-CONTRACT.md)
- [Analytics calculation auditability](analytics/CALCULATION-AUDITABILITY.md)
- [Administrator authentication](architecture/ADMINISTRATOR-AUTHENTICATION.md)
- [Runtime administration](architecture/ADMIN-RUNTIME-DASHBOARD.md)
- [Remote session lifecycle](architecture/REMOTE-SESSION-LIFECYCLE.md)
- [Color system](COLOR-SYSTEM.md)

Historical migration inventories, temporary audit notes, and obsolete test plans are intentionally not maintained as current architecture documentation.
