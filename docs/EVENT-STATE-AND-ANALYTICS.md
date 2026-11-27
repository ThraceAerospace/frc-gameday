# EventState, TeamState, and analytics

## State projections

EventState and TeamState are normalized FieldView contracts intended for clients. They are not provider payloads and are not durable canonical records.

- EventRuntime stores event-scoped provider endpoint responses and acquisition metadata.
- TeamRuntime stores team/year-scoped provider endpoint responses and acquisition metadata.
- A request for an event or team snapshot derives the corresponding normalized projection from the owning runtime's stored endpoint records.
- The runtime may reuse a disposable in-memory projection while the source revision/signature is unchanged.
- A cold read or cache eviction recomputes the projection. Snapshot reads do not write Durable Object storage, call provider APIs, initialize runtimes, or schedule work.

Provider endpoint records—not a previously materialized EventState/TeamState object—are the durable inputs. Analytics records are separate purpose-specific outputs and do not gate snapshot projection.

## Analytics ownership

Analytics calculations are implemented in the provider/UI-independent analytics package and orchestrated by backend jobs. EventRuntime owns event-wide analytics publications. TeamRuntime owns team- and team-event-scoped analytics publications. Cross-runtime inputs are read through explicit versioned interfaces; a runtime must not copy another runtime's complete canonical aggregate into its own storage.

Analytics publications have their own revision and provenance. A publication is committed only when its required inputs and source revisions satisfy the calculation contract. Revisions must be monotonic within their publication scope. Partial or failed inputs must not silently erase a last-good result.

## Realtime contract

The browser performs an HTTP snapshot read before opening the shared Multiplexer `/stream` WebSocket. The initial snapshot establishes the starting version; subsequent stream messages carry the actual changed data.

- Event snapshot notifications carry the updated EventState data.
- Team-event updates carry the changed patch/data and its owning scope.
- Analytics notifications carry the committed analytics publication.
- Messages include identity and ordering/revision metadata so the SharedWorker can reject duplicates or out-of-order updates.
- A revision-only invalidation is not a valid update.
- The SharedWorker applies data-bearing messages to its in-memory cache and fans them out to subscribed clients.
- Notifications, acknowledgements, gaps, disconnects, and reconnects never cause a hidden HTTP snapshot or analytics refetch. Reconnect restores subscriptions only.

A new page/client read or an explicit user refresh may request another HTTP snapshot. The browser does not persist normalized snapshots in IndexedDB.

## Provider and failure semantics

Provider clients return upstream data without converting it into frontend contracts. Domain normalization owns FieldView construction, cross-provider correlation, and explicit source precedence.

Preserve provenance and freshness. Missing/unavailable data, explicit null/clear, zero, stale values, and failed acquisition are distinct states. A partial provider failure must not erase unrelated valid data. Do not let request completion order determine which provider wins a field.

## Related contracts

- [Canonical data model](domain/FIELDVIEW-DATA-MODEL-V1.md)
- [Analytics result contract](analytics/DOMAIN-RESULT-CONTRACT.md)
- [Calculation auditability](analytics/CALCULATION-AUDITABILITY.md)
- [ADR-0020](architecture/decisions/ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md)
