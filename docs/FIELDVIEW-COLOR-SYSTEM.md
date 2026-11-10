# FieldView Color System

> **Status: design direction / provisional palette.** This document records the current visual direction for future implementation. It does not authorize or describe an implementation change. Exact values may be tuned after light-theme, dark-theme, chart, and accessibility testing.

## Color roles

FieldView uses separate semantic color systems. A color should retain the same meaning wherever it appears; these systems should not be blended just because a component can display a color.

| Role | Color | Hex | Meaning |
|---|---|---:|---|
| Brand | Purple | `#7656C9` | FieldView identity, primary brand accent, active navigation and selected states |
| Alliance identity | Red | `#C74747`* | Red alliance in match context only |
| Alliance identity | Blue | `#397BC5`* | Blue alliance in match context only |
| Metric percentile | Muted gold | `#C29A38` | Below typical: 0th–25th percentile |
| Metric percentile | Neutral / uncolored | Theme neutral | Typical: 25th–75th percentile |
| Metric percentile | Sage green | `#79A65A` | Above typical: 75th–90th percentile |
| Metric percentile | Forest green | `#287A4B` | Exceptional: 90th–100th percentile |
| Review indicator | Orange | `#E58B35` | A finding or match worth human review; not a performance grade |
| Team identity | Team-provided colors | Dynamic | Individual FRC team identity, sourced from FRC Colors where available |

\* The red and blue hex values are illustrative values used in the design mockup, not a finalized alliance color specification. Alliance identity must remain clearly distinguishable and must not be repurposed for generic metric performance.

## Metric percentile scale

The current proposal intentionally uses **four colored tiers and one uncolored middle range**:

| Percentile | Label | Treatment |
|---|---|---|
| 0–25 | Below typical | Muted gold (`#C29A38`) |
| 25–75 | Typical | No metric accent; use the surrounding theme's neutral text/surface |
| 75–90 | Above typical | Sage green (`#79A65A`) |
| 90–100 | Exceptional | Forest green (`#287A4B`) |

The percentile color represents relative standing in the relevant comparison cohort, not the raw metric's sign or magnitude. Metric direction must be accounted for before assigning a percentile (for example, lower error can represent better performance). A neutral metric should remain visually neutral rather than receiving a fifth color.

Percentile thresholds and cohort must be communicated in the UI where users need them. The current event-analytics prototype uses event-relative percentiles; do not imply that event-relative values are global season rankings.

## Semantic separation

- **Purple is the FieldView brand**, not an analytics grade.
- **Red and blue identify alliances** in match context. Do not use them as generic low/high metric colors.
- **Gold and greens communicate metric percentile tiers** only.
- **Orange communicates a review prompt**, not necessarily poor performance. Review flags are leads for a human to investigate, not causal conclusions.
- **Team colors identify teams**, not alliances or performance. Team colors are dynamic and may vary significantly in brightness and contrast.
- **Neutral grays and theme surfaces** handle typical values, secondary information, missing data, and ordinary interface structure.

## Usage guidance

1. Keep metric colors localized to values, small indicators, chart marks, or restrained accents. Avoid filling entire tables or large cards with percentile colors.
2. Do not rely on color alone. Pair important states with labels, values, icons, or other distinguishable cues.
3. Check text and UI contrast in both light and dark themes. Team colors may need a neutral container, outline, or contrast treatment before being used behind text.
4. Keep review orange visually distinct from the metric gold. The orange review indicator should be a small icon, outline, or restrained accent rather than a large performance-style fill.
5. Missing or unavailable values should remain neutral and must not be treated as zero or assigned a percentile color.
6. For metrics where higher is worse, reverse the percentile interpretation so that the semantic color still reflects performance quality. Metrics without an inherently good/bad direction should not be assigned an evaluative color without an explicit interpretation.

## Implementation status

This is documentation only. No theme tokens, CSS variables, Tailwind configuration, components, charts, or existing UI colors are being changed by recording this palette. The values above are a working proposal and should be validated before implementation.
