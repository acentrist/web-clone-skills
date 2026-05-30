---
name: web-clone
description: Use when a user asks to clone, mirror, replicate, rebuild, copy, or convert a single public webpage URL into local frontend code; when extracting webpage layout/assets/styles/interactions with Playwright; or when generating a Vite React Tailwind page clone with local verification.
---

# Web Clone

Clone one public webpage into a local Vite + React + Tailwind app. Use extracted contracts to generate and refine components. The completion gate is build plus desktop/tablet/mobile visual, runtime, asset, favicon, and motion verification.

Scope is single public page only. Do not crawl multiple pages, recreate backend/auth/CMS behavior, or publish captured source content unless the user owns or is authorized to reproduce it.

## Workflow

1. Install Node dependencies when needed:
   ```bash
   cd /path/to/installed/web-clone
   sh setup.sh
   ```

2. Prepare source extraction:
   ```bash
   cd /path/to/installed/web-clone
   SKILL_DIR="$(pwd)"
   TARGET_URL="https://www.example.com/"
   TARGET_HOST="$(node -e 'const raw = process.argv[1]; const value = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`; const host = new URL(value).hostname.toLowerCase().replace(/^www\./, ""); console.log(host || "page");' "$TARGET_URL")"
   RUN_DIR="${WEB_CLONE_RUN_DIR:-$HOME/web-clone-runs/$TARGET_HOST}"
   PROJECT_NAME="${WEB_CLONE_PROJECT_NAME:-$TARGET_HOST}"

   node "$SKILL_DIR/scripts/prepare-clone.mjs" \
     "$TARGET_URL" \
     --run-dir "$RUN_DIR" \
     --viewports desktop=1440x1200,tablet=768x1024,mobile=390x844 \
     --wait 4000
   ```
   This writes `run_manifest.json`, `sources/<viewport>/source.json`, desktop-compatible `source.json`, screenshots, annotated DOM, computed styles, image/background/pseudo-element metrics, CSS, assets, favicon data, motion samples, and mirrored local assets in `public/assets`.
   By default, output goes under a host-named run directory such as `$HOME/web-clone-runs/<hostname>`.

3. Create section contracts:
   ```bash
   node "$SKILL_DIR/scripts/create-contracts.mjs" \
     --source "$RUN_DIR/source.json" \
     --out "$RUN_DIR/contracts"
   ```
   When `source.json` includes a `source_set`, contracts include desktop/tablet/mobile layout, image, background, and pseudo-element observations so generated fidelity CSS can use viewport-specific media queries.

4. Assemble the Vite app:
   ```bash
   node "$SKILL_DIR/scripts/assemble-vite-app.mjs" \
     --run-dir "$RUN_DIR" \
     --output "$RUN_DIR/app" \
     --project-name "$PROJECT_NAME"
   ```

5. Component refinement:
   - Read `references/code-generation.md`, `contracts/integration_plan.json`, and relevant `contracts/contracts/*.json`.
   - Improve generated `src/components/sections/<namespace>/*.jsx` and `.css` only when verification shows fidelity gaps.
   - Keep mirrored `/assets/...` paths, source class names, wrappers, section order, button styling, and motion markers.

6. Build and verify:
   ```bash
   cd "$RUN_DIR/app"
   npm install
   npm run build
   npm run dev -- --host 127.0.0.1 --port 3230
   ```

   Then run:
   ```bash
   node "$SKILL_DIR/scripts/verify-clone.mjs" \
     --run-dir "$RUN_DIR" \
     --app-url http://127.0.0.1:3230 \
     --out "$RUN_DIR/verification" \
     --viewports all \
     --motion
   ```

## Completion Rules

- Do not claim completion from `npm run build` alone.
- Verification must pass for desktop, tablet, and mobile.
- Default visual thresholds:
  - desktop: first viewport `<= 12%`, full page `<= 18%`
  - tablet: first viewport `<= 16%`, full page `<= 22%`
  - mobile: first viewport `<= 18%`, full page `<= 24%`
- Verification must also check header/nav/hero/footer presence, button styling, image visibility and aspect ratio, important background colors/images, horizontal overflow, mobile nav usability, local favicons/assets/fonts, console errors, network failures, practical motion, and absence of `dangerouslySetInnerHTML`.
- Keep clone outputs outside this skill folder and outside the distribution repo.

## Resources

- `scripts/prepare-clone.mjs`: multi-viewport Playwright extraction, stable element ids, visual metrics, motion sampling, and asset/favicon/font mirroring.
- `scripts/create-contracts.mjs`: layout analysis, section contracts, prompts, shared data, motion manifest, and integration plan.
- `scripts/assemble-vite-app.mjs`: Vite + React + Tailwind scaffold, local URL rewrite, favicon head tags, original CSS, fidelity CSS, and motion runtime.
- `scripts/verify-clone.mjs`: desktop/tablet/mobile screenshot diff plus DOM/runtime/asset/image/background/region/motion checks.
- `references/code-generation.md`: fidelity and section-generation rules.
