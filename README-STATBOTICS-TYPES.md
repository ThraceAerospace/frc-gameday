# Statbotics API typing

The type generator fetches the live official OpenAPI document at `https://api.statbotics.io/openapi.json` every time it runs.

```bash
npm run generate:statbotics-types
```

It writes `src/lib/statbotics/generated.ts`. Never hand-edit that generated file. The generator runs during `predev` and `prebuild`, so upstream schema changes are picked up on the next development or production build.

## Incomplete response schemas

Several Statbotics FastAPI handlers currently annotate serialized responses as generic dictionaries. The generator adds FieldView fallback schemas for the response shapes currently consumed by the application. These fallback schemas are based on the API's serialized `to_dict()` payloads rather than database models alone.

Fallback response types are attached only when the corresponding upstream response schema is absent or generic. If Statbotics later publishes a concrete response schema, the generator preserves and uses that upstream schema automatically. At that point, the now-redundant fallback can be removed from `scripts/generate-statbotics-types.mjs`.

EPA breakdowns remain string-keyed numeric maps because their component names vary by game year.

## Application aliases

`src/lib/statbotics/types.ts` is the application-facing alias layer. Import these named types rather than coupling application code to generated schema names.
