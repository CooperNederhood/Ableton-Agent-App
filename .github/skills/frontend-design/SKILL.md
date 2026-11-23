---
name: frontend-design
description: Follow the Ableton Agent desktop design system (Style A, Live 11 light theme) for any renderer UI change — tokens, color meanings, icons, copy, accessibility, and a visual check.
---

# Frontend design

The desktop app should feel like a panel of Ableton Live 11: flat, dense,
light grey, and readable at a glance. A new user should find things by
**color and icon first, words second**.

## Tokens, never hex

- All colors live as role tokens in `:root` of
  `apps/desktop/src/renderer/styles.css` (`--surface*`, `--text*`,
  `--accent`, `--selection`, `--status-*`, `--mode-plan-*`, `--scope-*`,
  `--focus`). Components use `var(--role)`; no hex literals in `.tsx` or new CSS
  rules. Agent and Live track colors are data and arrive through custom
  properties (`--agent-color`, `--row-color`, `--tag-color`,
  `--event-track-color`).
- Radius is `--radius` (2px). Panels animate with `--motion-panel`.

## One color, one meaning

| Color family             | Meaning                                  | Where it appears                                       |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------ |
| Orange `--accent`        | The one primary action, Interactive mode | Filled primary button, composer edge                   |
| Blue `--mode-plan-*`     | Plan mode: nothing in Live will change   | Composer, plan banner                                  |
| Light blue `--selection` | What is selected                         | Selected rows, tiles, tabs                             |
| Scope `--scope-*`        | Where an item lives (System → Session)   | Scope chips, row strips, memory tiles, Profiles ladder |
| Agent color (data)       | Which agent did it                       | Agent rows, sub-agent lanes, delegation chips, "via X" |
| Track color (from Live)  | Which Live track                         | Track list, context chips, event and output rows       |

- Never reuse a hue for a second meaning; keep new hues at least ~15° apart
  from existing ones.
- Color is never the only cue: pair it with a label, icon, `aria-label`, or
  `title` (for example, LEDs say "Active agent").
- Bright fills hold dark text (`--text`). Never put a bright color as text or
  an icon on grey; use an ink token (`--accent-ink`, `--status-*`).

## Layout and wording

- Icons over text: the left rail uses line icons from `Icon.tsx` with a short
  label. Reuse `Icon` before adding SVG.
- Library tabs (Agents, Skills, Memory) share one shape from
  `scope-library.tsx`: a bar with scope filter chips, a list on the left, a
  reader on the right, and `ScopeChip` plus `ScopeActions` (Move ▾ or
  Duplicate to Profile) in the header.
- Plain labels ("Can edit", "Tools it can use"). Put jargon, YAML, patterns,
  and hashes under an **Advanced** `<details>`.
- Buttons start with a verb. Toggles describe the ON state. Use sentence case
  and "…", not "...".
- Empty states say what the place is and offer one next action.
- Keep every working behavior when restyling (sidebar hide and resize,
  Inspector drag and split, ⇧Tab mode toggle).

## Accessibility and type

- Text contrast ≥ 4.5:1; UI parts that carry meaning (LEDs, borders) ≥ 3:1.
- Body text ≥ 12px (`1rem`); 11px only for uppercase labels with letter
  spacing. Use `rem` and unitless line-height; `tabular-nums` on counts and
  timers; long names truncate with a `title`.
- Interactive things are real `<button>`s with names that say the action
  ("Hide left sidebar"), a visible `:focus-visible` ring, and a hit area of at
  least 24×24 (grow it with padding or a pseudo-element, not visual size).
- Resize handles are `role="separator"` with `aria-valuenow` and arrow keys.
- Hover styles go inside `@media (hover: hover)`. Animate only what changes and
  respect `prefers-reduced-motion`.

## Visual check

Before opening a PR for UI work, compare a screenshot of the changed view with
the approved mockup or the surrounding app. Look for stray hex colors, bright
text on grey, a second filled primary button, and missing labels.

These principles adapt guidance from
[jakubkrehel/skills](https://github.com/jakubkrehel/skills) (accessibility,
color, layout, typography, writing, motion) to this app.
