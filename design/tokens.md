# Token sheet

Deliverable 2 of `DESIGN-BRIEF.md`. Every colour, type style, spacing step, radius, shadow
and duration used by the prototypes, with semantic names. Values are lifted verbatim from
`prototypes/signal-2a.html`; that file's `:root` is the reference implementation.

## The two-layer rule

There are exactly two layers, and **hex appears only in the first**.

1. **Brand layer** — the Cunning Corp Brand Handbook palette verbatim. Nothing outside
   layer 2 may reference these.
2. **Semantic layer** — what components actually use.

A palette change is therefore a one-line edit in layer 1. If you find yourself writing a
hex anywhere else, the token is missing — add it rather than inline it.

JS reads the platform hues back out of the tokens (`getComputedStyle` on
`--data-<platform>`) so Chart.js and CSS cannot drift apart. Keep that; don't re-declare
the hexes in script.

---

## Layer 1 · Brand palette

| Token | Value | Handbook role |
|---|---|---|
| `--brand-plum` | `#241B30` | Base · night |
| `--brand-plum-deep` | `#191220` | Gradient floor |
| `--brand-plum-lift` | `#2C2239` | Raised plum |
| `--brand-plum-sunk` | `#140E1B` | Below the base |
| `--brand-gold` | `#C8A24C` | The light |
| `--brand-gold-soft` | `#E3C57E` | Highlight |
| `--brand-peri` | `#8E8BD8` | Accent · play |
| `--brand-paper` | `#FAF6EE` | Light ground |
| `--brand-terracotta` | `#C0593B` | Division accent — Aubrey North |
| `--brand-line` | `#372C47` | Rule |
| `--brand-line-soft` | `#2A2036` | Rule, quieter |
| `--brand-line-strong` | `#4A3C5E` | Rule, selected |
| `--brand-mute` | `#B7AEC2` | Secondary content |
| `--brand-dim` | `#7D7290` | Tertiary content |
| `--plat-youtube` | `#FF4E45` | Platform encoding |
| `--plat-instagram` | `#E1477E` | Platform encoding |
| `--plat-facebook` | `#4A8CFF` | Platform encoding |
| `--plat-tiktok` | `#25E5D0` | Platform encoding |

Slate `#2C3E5D` and Teal `#1F5F5B` are in the Handbook but unused here — Signal has no
Publications or Productions surface.

## Layer 2 · Semantic

### Surface — four depths
| Token | → | Use |
|---|---|---|
| `--surface-base` | plum-deep | The page |
| `--surface-raised` | plum | A panel, the rail, the scope bar |
| `--surface-overlay` | plum-lift | A control, a nested card, menu hover |
| `--surface-sunken` | plum-sunk | A well: inputs, the range switch track |

### Border — three weights
| Token | → | Use |
|---|---|---|
| `--border-subtle` | line-soft | Divides inside a panel |
| `--border-default` | line | Outlines a panel or control |
| `--border-strong` | line-strong | A selected or hovered edge |

### Text
| Token | → | Use |
|---|---|---|
| `--text-primary` | paper | Figures, headings, the answer |
| `--text-secondary` | mute | Body, supporting values |
| `--text-tertiary` | dim | Labels, captions, "no basis" |
| `--text-on-accent` | plum-deep | Only on the periwinkle action |

### State — borrowed, never invented
| Token | → | Meaning |
|---|---|---|
| `--state-positive` | gold | Up. Gold is the light, so gold is up. |
| `--state-negative` | terracotta | Down, or a genuine fault |
| `--state-progress` | periwinkle | In progress; the primary action |
| `--state-neutral` | dim | Skipped, indeterminate |

**One glow per layout** is held by reserving periwinkle for the primary action alone.

### Data encoding
`--data-youtube` · `--data-instagram` · `--data-facebook` · `--data-tiktok`

Confined to chart strokes, platform pills and the 3px account rule. **Never a surface,
never a button.** This is the first standing exception in `README.md`: four muted house
tones on one axis would be indistinguishable, so platform colour is data, not brand.

### Availability — the R4 family
| Token | → | Glyph | Means |
|---|---|---|---|
| `--avail-live` | gold | filled dot | Daily |
| `--avail-lagged` | gold-soft | half-filled ring | Daily, lags 2–3 days |
| `--avail-rolling` | periwinkle | solid dot | 28-day rolling total |
| `--avail-rolling` | periwinkle | dashed ring | Derived by differencing snapshots |
| `--avail-absent` | line-strong | **hollow dashed ring** | Not provided by this API |
| `--avail-error` | terracotta | filled dot | Failing |
| — | line-strong | flat dash | Platform not connected |

The hollow-ring-versus-terracotta distinction is the whole of R4: missing-by-design must
never look like missing-because-broken. Do not collapse them.

## Type

| Token | Stack | Role |
|---|---|---|
| `--font-display` | Glamour Absolute Extended → Glamour Absolute → Recoleta → Georgia | Wordmark only |
| `--font-head` | Recoleta 300 → Georgia | Headings and every figure |
| `--font-body` | Graphik 400/600 → system sans | Body and UI |

All five faces are committed under `fonts/`: `GlamourAbsoluteExtended-400`,
`GlamourAbsolute-400`, `Graphik-400`, `Graphik-600`, `Recoleta-300`.
(`DESIGN-BRIEF.md` §R6 still says Recoleta is the only one — that line is stale.)

| Size token | Value | Use |
|---|---|---|
| `--text-micro` | 11px | Labels, captions, chips |
| `--text-label` | 12px | Hints, table body, menu subtitles |
| `--text-body` | 14px | Body default |
| `--text-lead` | 16px | The lede's second paragraph |
| `--figure-sm` | 20px | Panel headings, small figures |
| `--figure-md` | 28px | Mid figures |
| `--figure-lg` | 40px | KPI figures, the idle countdown |

Tracking: `--track-label` `.12em` for uppercase labels, `--track-display` `.03em` for the
wordmark. **Every figure uses `--font-head` at `font-variant-numeric: tabular-nums`** so
columns align and numbers don't jitter as they update.

## Scale, shape, motion

`--space-1` … `--space-7` = 4 · 8 · 12 · 16 · 24 · 32 · 48 px. 4px base.

`--radius-sm` 4px (chips, thumbnails) · `--radius-md` 8px (controls, cards) ·
`--radius-lg` 12px (panels) · `--radius-pill` 999px (badges, progress bars).
Radius climbs with the size of the thing.

`--shadow-panel` `0 1px 2px rgba(0,0,0,.3)` — a panel resting on the page.
`--shadow-overlay` `0 18px 50px rgba(0,0,0,.55)` — modals and menus only.

`--dur-fast` 120ms (hover, colour) · `--dur-base` 200ms (state change) ·
`--ease-out` `cubic-bezier(.2,.7,.2,1)`. Short: this is a tool, not a show.

`--rail-w` 248px — the scope rail.

## Not tokenised, deliberately

Chart geometry (tension, bar radius, point sizes) lives with the Chart.js config, and the
`rgba()` glow ring on sync LEDs is written inline because it needs per-state alpha. Both
are decorative; see `handoff.md` §3.
