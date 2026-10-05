# TBA API typing

The Blue Alliance OpenAPI document is the source of truth for raw TBA API types.

## Generate

From the repository root:

```bash
npm install
npm run generate:tba-types
```

The command fetches the current TBA OpenAPI 3.1 document and writes:

```
src/lib/tba/generated.ts
```

The generated file is machine-produced. **Do not hand-edit it.**

## Application aliases

`src/lib/tba/types.ts` is the application-facing layer. Keep it small and intentional.

It currently provides:

- event and simple-event aliases;
- team and simple-team aliases;
- team event status;
- full and simple matches;
- playoff alliances;
- district, advancement, and district-ranking types;
- webcasts;
- event rankings and OPRs;
- composed event-with-teams and event-with-matches types;
- application-friendly maps such as `TBAEventTeamStatuses`.

When application code needs a TBA schema, add a named alias here rather than importing the generated schema directly throughout the UI.

Do not add aliases merely because a schema exists in the OpenAPI document. Unused TBA endpoints and schemas should remain available in `generated.ts` without being mirrored in the application alias layer.

## Generated schema vs. application types

The generated file may contain many endpoints and schemas that FieldView does not currently use. That is expected.

For example, removing a retired integration does **not** mean deleting the corresponding raw TBA schema from `generated.ts`. The generated file must continue to represent the upstream OpenAPI document accurately.

If an upstream TBA schema changes, regenerate the file and then update `src/lib/tba/types.ts` or application code only where the changed schema is actually used.

## Workflow

After changing the TBA schema dependency or when TBA publishes schema changes:

```bash
npm run generate:tba-types
npm run lint
npm run build
```

The repository's `predev` and `prebuild` hooks also regenerate the types automatically.
