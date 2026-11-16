# @fieldview/domain

Canonical, provider-independent FieldView domain models and rules.

This package must remain independent of:

- provider packages and generated provider schemas;
- Next.js, React, and other presentation code;
- Cloudflare Workers and Durable Objects;
- storage, transport, and other infrastructure implementations.

Provider adapters may depend on this package to produce normalized FieldView values. The domain package must never import provider implementations.

The package currently establishes the workspace and compilation boundary only. Canonical models will be added in small, reviewed slices; do not move legacy provider-shaped types here wholesale.
