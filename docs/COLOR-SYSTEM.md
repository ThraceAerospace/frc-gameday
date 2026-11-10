# FieldView Color System

> Status: Proposed design direction — documented for future implementation, not implemented in the application.
>
> The palette is a working baseline, not a finalized design-system contract. Revisit exact values after testing in light and dark themes, chart contexts, and accessibility/contrast checks.

## Semantic color roles

FieldView uses separate color systems for product identity, FRC alliance identity, team identity, metric performance, and review attention. These roles must not be conflated.

### Brand identity

| Role | Color | Hex | Usage |
|---|---|---:|---|
| Primary brand | Purple | `#7656C9` | FieldView identity, primary brand accents, active navigation and selected states |

Purple is the current leading brand direction, but remains provisional. It must not be used to represent metric performance or alliance identity.

### Alliance identity

| Role | Color | Hex | Usage |
|---|---|---:|---|
| Red alliance | Red | `#C74747` | Identify the red alliance in match context |
| Blue alliance | Blue | `#397BC5` | Identify the blue alliance in match context |

Red and blue are reserved for FRC alliance identification. Do not use either as FieldView's brand color or as general-purpose metric-performance colors.

### Metric performance

Metric colors represent percentile standing within the relevant comparison cohort. The typical range is intentionally uncolored to reduce visual noise.

| Tier | Percentile | Color | Hex |
|---|---:|---|---:|
| Below typical | 0th–25th | Muted gold | `#C29A38` |
| Typical | 25th–75th | Neutral / no accent | — |
| Above typical | 75th–90th | Sage green | `#79A65A` |
| Exceptional | 90th–100th | Forest green | `#287A4B` |

Notes:

- The two green tiers both indicate above-typical performance; the darker forest green indicates the strongest tier.
- Typical values should retain the normal text/surface styling rather than receive a metric accent.
- Percentile direction must account for metric meaning. For example, lower error can represent better performance, while higher EPA can represent better performance.
- Percentiles must be calculated against an explicitly appropriate cohort. Event-relative and season/global percentiles are not interchangeable.
- Missing or insufficient data should use a neutral missing-data treatment, not the below-typical color.
- Do not imply that a metric's raw sign (positive/negative) determines its color.

### Review indicators

| Role | Color | Hex | Usage |
|---|---|---:|---|
| Needs review | Orange | `#E58B35` | Flags an anomaly, unexpected result, or item worth human investigation |

Orange indicates attention, not poor performance. Prefer a restrained icon, outline, border, or small indicator rather than a large filled surface. Review flags are prompts for human investigation and must not be presented as causal conclusions.

### Team identity

Individual team colors are dynamic team metadata, sourced from the FRC Colors service when available. They are not part of the fixed FieldView brand palette.

- Use team colors to distinguish teams in team-specific contexts, charts, and contribution visualizations.
- Use red/blue alliance colors to identify alliance membership in match context; do not substitute team colors for alliance identity.
- Team colors may require contrast-aware adaptation when used with text, icons, or surfaces.
- Missing team colors should fall back to a neutral treatment.

## Precedence and separation rules

1. Alliance red/blue identifies match sides.
2. Team colors identify individual teams.
3. Metric gold/green communicates percentile performance.
4. Orange communicates a review prompt.
5. Purple communicates FieldView product identity.
6. Neutral styling communicates typical values, missing data, and ordinary interface structure.

A component may show multiple roles together (for example, a team-colored marker beside a percentile-colored metric), but each color must have a clear, separate visual target. Avoid using a single colored background to encode multiple meanings.

## Implementation guidance (future work only)

This document records design intent; it does not authorize implementation in this change.

When the palette is implemented later:

- Centralize semantic tokens rather than scattering raw hex values through components.
- Define light- and dark-theme variants and accessible foreground/surface pairings.
- Check text, icon, chart, badge, and focus-indicator contrast.
- Use semantic role names (for example, brand, alliance-red, alliance-blue, metric-below, metric-above, metric-exceptional, review) rather than names based only on hue.
- Keep charts and tables legible without relying on color alone; include labels, values, shapes, or other cues where useful.
- Verify metric-color behavior for metrics where lower is better, higher is better, or no simple direction is inherently better.
- Keep the typical percentile band uncolored.
- Treat these hex values as provisional until visual and accessibility testing is complete.

## Current status

**Documentation only.** No application components, CSS variables, Tailwind configuration, chart palettes, or existing colors are changed by this proposal.
