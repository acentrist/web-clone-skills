# Code Generation Guide

Use this reference after `contracts/shared.json`, `contracts/integration_plan.json`, and `contracts/contracts/*.json` exist.

## Contract Rules

- Generate only paths listed in each contract `deliverables`.
- Keep work inside `src/components/sections/<namespace>/`.
- Preserve source root wrappers. Header, nav, hero, and footer must not be split into loose text or list fragments.
- Preserve text, images, links, class names, semantic order, CTA/button styling, and local `/assets/...` URLs.
- Preserve `data-scroll`, `animate-*`, `w-dropdown`, `w-nav-button`, `w-nav-menu`, `data-w-id`, and related interaction markers unless replacing them with explicit equivalent behavior.
- Use explicit JSX. Do not use `dangerouslySetInnerHTML`.

## JSX And CSS

- Convert `class` to `className`, `for` to `htmlFor`, and inline style strings to React style objects.
- Keep source classes when `src/styles/original.css` contains useful rules.
- Rewrite image, `srcSet`, CSS `url(...)`, favicon, manifest, and font URLs to local `/assets/...` when available.
- Remove scripts and inline event handlers; recreate visible behavior with React state or `src/runtime/cloneRuntime.js`.
- Do not add motion libraries. Practical motion is vanilla JS/CSS via the runtime plus section CSS where needed.

## Fidelity Checklist

- Render order follows `integration_plan.json`.
- Header/nav appears in the first viewport with original grouping and dropdown/hover behavior.
- Hero headline, CTA/button styling, and primary visual are visible.
- Footer renders as grouped grid/list columns, not a left-edge text dump.
- Animations, hover states, focus states, dropdown states, word stagger, and scroll reveal are reproduced or visibly equivalent when source motion candidates exist.
- Desktop, tablet, and mobile have no incoherent overlap or horizontal overflow.
- Mobile nav is usable: tapping the visible nav button must change open state or reveal menu content.
- Local favicon/icon links exist in `index.html`.

## Verification

Run build, launch a local preview, then run `verify-clone.mjs --run-dir RUN_DIR --viewports all --motion`. Treat any of these as unfinished:

- build failure
- React runtime error
- CSS MIME error, missing required local asset, missing favicon, font load failure, or network failure
- missing header/nav/hero/footer/button/image checks
- horizontal overflow or unusable mobile nav
- source motion exists but no runtime/class/style change is detected
- desktop first/full mismatch above `12%` / `18%`
- tablet first/full mismatch above `16%` / `22%`
- mobile first/full mismatch above `18%` / `24%`
- any generated component containing `dangerouslySetInnerHTML`

