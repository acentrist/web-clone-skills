---
name: web-clone
description: Use when a user asks to clone, mirror, replicate, rebuild, copy, or convert a single public webpage URL into local frontend code; when extracting webpage layout/assets/styles/interactions with Playwright; or when generating a Vite React Tailwind page clone with local verification.
---

# Web Clone

Clone one public webpage into a local Vite + React + Tailwind app. Do not use external LLM API keys; the active coding agent handles component generation from extracted contracts. The completion gate is build plus desktop/tablet/mobile visual, runtime, asset, favicon, and motion verification.

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
   TARGET_URL="URL"
   RUN_DIR="${WEB_CLONE_RUN_DIR:-$HOME/web-clone-runs/page}"
   PROJECT_NAME="${WEB_CLONE_PROJECT_NAME:-web-clone-output}"

   node "$SKILL_DIR/scripts/prepare-clone.mjs" \
     "$TARGET_URL" \
     --run-dir "$RUN_DIR" \
     --viewports desktop=1440x1200,tablet=768x1024,mobile=390x844 \
     --wait 4000
   ```
   This writes `run_manifest.json`, `sources/<viewport>/source.json`, desktop-compatible `source.json`, screenshots, DOM, computed styles, CSS, assets, favicon data, motion samples, and mirrored local assets in `public/assets`.

3. Create section contracts:
   ```bash
   node "$SKILL_DIR/scripts/create-contracts.mjs" \
     --source "$RUN_DIR/source.json" \
     --out "$RUN_DIR/contracts"
   ```

4. Assemble the Vite app:
   ```bash
   node "$SKILL_DIR/scripts/assemble-vite-app.mjs" \
     --run-dir "$RUN_DIR" \
     --output "$RUN_DIR/app" \
     --project-name "$PROJECT_NAME"
   ```

5. Quality pass with the active coding agent:
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
- Verification must also check header/nav/hero/footer presence, button styling, image visibility, horizontal overflow, mobile nav usability, local favicons/assets/fonts, console errors, network failures, practical motion, and absence of `dangerouslySetInnerHTML`.
- Keep clone outputs outside this skill folder and outside the distribution repo.

## Resources

- `scripts/prepare-clone.mjs`: multi-viewport Playwright extraction and asset/favicon/font mirroring.
- `scripts/create-contracts.mjs`: layout analysis, section contracts, prompts, shared data, and integration plan.
- `scripts/assemble-vite-app.mjs`: Vite + React + Tailwind scaffold, local URL rewrite, favicon head tags, original CSS, and motion runtime.
- `scripts/verify-clone.mjs`: desktop/tablet/mobile screenshot diff plus DOM/runtime/asset/motion checks.
- `references/code-generation.md`: fidelity and section-generation rules.
