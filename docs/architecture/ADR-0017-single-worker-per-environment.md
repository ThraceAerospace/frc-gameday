# ADR-0017: One Runtime Worker per environment

> **Status: Superseded by [ADR-0019](ADR-0019-single-worker-with-branch-previews.md) on 2026-11-24.** This document is retained as architectural history; its per-environment Worker topology is no longer the target.

- **Original status:** Accepted
- **Original date:** 2026-11-22

The original decision deployed exactly one Cloudflare Worker per environment: `runtime-preprod` and `runtime-production`, using a base Wrangler project named `runtime`. Each deployment hosted the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore, and the deployed Workflow classes.

This topology was replaced by Cloudflare Workers Previews. The accepted current deployment boundary is one environment-neutral Worker named `runtime`, with production configuration at the top level and branch-specific Preview configuration in the Wrangler `previews` block. See ADR-0019 for the current decision.

The architectural separation described here remains valid: a single Worker deployment is not a monolith. Runtime, Jobs orchestration, provider adapters, domain logic, analytics, and HTTP routing remain separate modules with explicit responsibilities. EventRuntime and TeamRuntime remain independent Durable Object consistency and refresh boundaries. Runtime and Jobs communicate through internal module interfaces and direct Durable Object namespace access, not service bindings.

The previous requirement for independent per-environment Worker names and Wrangler named environments is superseded. Existing Cloudflare resources are not automatically renamed, migrated, or deleted by this repository decision. No Cloudflare resources are changed as part of this documentation/configuration update.
