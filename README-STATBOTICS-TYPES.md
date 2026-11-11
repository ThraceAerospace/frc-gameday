# Statbotics API typing

The generator fetches the live official OpenAPI document at `https://api.statbotics.io/openapi.json` every time it runs.

```bash
npm run generate:statbotics-types
```

It writes `src/lib/statbotics/generated.ts` and the application-facing aliases in `src/lib/statbotics/types.ts`. Never hand-edit either file. The generator runs during `predev` and `prebuild`, so upstream schema changes are picked up on the next development or production build.

## Incomplete response schemas

Several Statbotics FastAPI handlers currently annotate serialized responses as generic dictionaries. The generator adds FieldView fallback schemas for the response shapes currently consumed by the application. These fallbacks are based on serialized `to_dict()` payloads rather than database models alone.

Fallback response types are attached only when the corresponding upstream response schema is absent or generic. If Statbotics publishes a concrete response schema, the generator automatically points the stable FieldView aliases at that upstream schema (including concrete inline schemas). At that point, the now-redundant fallback can be removed from `scripts/generate-statbotics-types.mjs`.

EPA breakdowns remain string-keyed numeric-or-null maps because their component names and availability vary by game year.

## Application aliases

Import named types from `src/lib/statbotics/types.ts` rather than coupling application code to generated schema names.
