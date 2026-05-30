#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  DEFAULT_VIEWPORT_THRESHOLDS,
  ensureDir,
  parseArgs,
  parseViewports,
  readJson,
  requiredArg,
  writeJson
} from "./core.mjs";

function usage() {
  return "Usage: node scripts/verify-clone.mjs --run-dir DIR --app-url URL --out DIR/verification --viewports all [--motion]";
}

async function pngFromFile(file) {
  return PNG.sync.read(await fs.readFile(file));
}

function pngFromBase64(value) {
  return PNG.sync.read(Buffer.from(value, "base64"));
}

function cropPng(source, width, height) {
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (source.width * y + x) << 2;
      const dst = (width * y + x) << 2;
      target.data[dst] = source.data[src];
      target.data[dst + 1] = source.data[src + 1];
      target.data[dst + 2] = source.data[src + 2];
      target.data[dst + 3] = source.data[src + 3];
    }
  }
  return target;
}

function mismatchRatio(left, right, threshold = 0.14) {
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  if (!width || !height) return 1;
  const leftCrop = cropPng(left, width, height);
  const rightCrop = cropPng(right, width, height);
  const diff = new PNG({ width, height });
  const count = pixelmatch(leftCrop.data, rightCrop.data, diff.data, width, height, { threshold });
  return count / (width * height);
}

function viewportThreshold(name, kind, fallback) {
  return DEFAULT_VIEWPORT_THRESHOLDS[name]?.[kind] ?? fallback;
}

function hasMotionSource(source) {
  const motion = source.motion_data || {};
  const css = source.css_data || {};
  const markers = motion.markers || {};
  return Boolean((motion.candidates || []).length || (css.keyframes || []).length || Object.values(markers).some(Boolean));
}

async function collectMotionTrace(page) {
  async function snapshot(label) {
    return page.evaluate((snapshotLabel) => {
      const candidates = Array.from(document.querySelectorAll("[data-web-clone-motion],.animate-word,[data-scroll],.clone-motion-reveal,.w-dropdown,.w-nav-button,.btn_main_wrap,a,button")).slice(0, 80);
      function selectorFor(element, index) {
        const cloneId = element.getAttribute("data-web-clone-id");
        if (cloneId) return `[data-web-clone-id="${cloneId}"]`;
        if (element.id) return `#${element.id}`;
        if (typeof element.className === "string" && element.className.trim()) {
          const stableClasses = element.className.trim().split(/\s+/).filter((name) => !name.startsWith("clone-")).slice(0, 3);
          return stableClasses.length ? `${element.tagName.toLowerCase()}.${stableClasses.join(".")}` : `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        }
        return `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      }
      return {
        label: snapshotLabel,
        runtime: document.documentElement.dataset.cloneMotionRuntime || null,
        samples: candidates.map((element, index) => {
          const style = getComputedStyle(element);
          return {
            selector: selectorFor(element, index),
            element_id: element.getAttribute("data-web-clone-id") || "",
            motion_state: element.dataset.cloneMotionState || "",
            className: typeof element.className === "string" ? element.className : "",
            opacity: style.opacity,
            transform: style.transform,
            transition: style.transition,
            visible: Boolean(element.offsetWidth || element.offsetHeight)
          };
        })
      };
    }, label);
  }
  const trace = [await snapshot("t0")];
  await page.waitForTimeout(250);
  trace.push(await snapshot("t250"));
  await page.waitForTimeout(750);
  trace.push(await snapshot("t1000"));

  let changed = false;
  const changedIds = new Set();
  const firstBySelector = new Map(trace[0].samples.map((sample) => [sample.selector, sample]));
  for (const frame of trace.slice(1)) {
    for (const sample of frame.samples) {
      const first = firstBySelector.get(sample.selector);
      if (!first) continue;
      if (first.opacity !== sample.opacity || first.transform !== sample.transform || first.className !== sample.className) {
        changed = true;
        if (sample.element_id) changedIds.add(sample.element_id);
        break;
      }
    }
    if (changed) break;
  }
  return {
    runtime_ready: trace.some((frame) => frame.runtime === "ready"),
    changed,
    changed_ids: Array.from(changedIds),
    motion_element_count: trace.at(-1)?.samples.filter((sample) => sample.element_id || sample.motion_state).length || 0,
    trace
  };
}

async function captureApp(appUrl, outDir, viewportName, viewport, motion) {
  const [width, height] = viewport;
  const consoleErrors = [];
  const networkFailures = [];
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", (request) => networkFailures.push(request.url()));
  const response = await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const motionTrace = motion ? await collectMotionTrace(page) : { runtime_ready: false, changed: false, trace: [] };
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {}
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(1000);
  const viewportPath = path.join(outDir, `${viewportName}_local_viewport.png`);
  const fullPath = path.join(outDir, `${viewportName}_local_full.png`);
  await page.screenshot({ path: viewportPath, fullPage: false });
  await page.screenshot({ path: fullPath, fullPage: true });
  const domChecks = await page.evaluate(async (screenWidth) => {
    const rectFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right };
    };
    const stylesFor = (element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundSize: style.backgroundSize,
        backgroundPosition: style.backgroundPosition,
        objectFit: style.objectFit,
        objectPosition: style.objectPosition,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform
      };
    };
    const navCandidates = Array.from(document.querySelectorAll('.w-nav-button, [class*="nav"][class*="button"], button[aria-controls]'));
    const visibleNavCandidates = navCandidates.filter((element) => Boolean(element.offsetWidth || element.offsetHeight));
    const navButton = visibleNavCandidates.find((element) => element.matches(".w-nav-button")) || visibleNavCandidates[0] || navCandidates.find((element) => element.matches(".w-nav-button")) || navCandidates[0];
    let mobileNavPass = true;
    if (screenWidth <= 500) {
      if (navButton) {
        const before = `${navButton.className}${navButton.getAttribute("aria-expanded")}`;
        navButton.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const after = `${navButton.className}${navButton.getAttribute("aria-expanded")}`;
        mobileNavPass = before !== after || document.querySelectorAll(".w--nav-menu-open,.w--open").length > 0;
      } else {
        mobileNavPass = document.querySelectorAll("nav a, [class*='nav'] a").length > 0;
      }
    }
    return {
      status: document.readyState,
      title: document.title,
      headerLike: document.querySelectorAll("header, nav, [class*='nav'], [class*='header']").length,
      footerLike: document.querySelectorAll("footer, [class*='footer']").length,
      h1: document.querySelectorAll("h1").length,
      links: document.querySelectorAll("a").length,
      buttons: document.querySelectorAll("button, .button, [class*='button'], [class*='btn']").length,
      images: document.querySelectorAll("img, picture, [style*='background-image']").length,
      faviconLinks: document.querySelectorAll("link[rel*='icon'], link[rel='manifest']").length,
      fontStatus: document.fonts ? document.fonts.status : "unsupported",
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mobileNavPass,
      dangerous: document.body.innerHTML.includes("dangerouslySetInnerHTML"),
      layout: {
        images: Array.from(document.querySelectorAll("img[data-web-clone-id]")).slice(0, 120).map((img) => {
          const rect = rectFor(img);
          return {
            element_id: img.getAttribute("data-web-clone-id") || "",
            src: img.currentSrc || img.src || "",
            natural_width: img.naturalWidth || null,
            natural_height: img.naturalHeight || null,
            rendered_rect: rect,
            rendered_aspect_ratio: rect.width && rect.height ? rect.width / rect.height : null,
            styles: stylesFor(img)
          };
        }),
        backgrounds: Array.from(document.querySelectorAll("[data-web-clone-id]")).slice(0, 300).map((element) => {
          const styles = stylesFor(element);
          return {
            element_id: element.getAttribute("data-web-clone-id") || "",
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            rect: rectFor(element),
            styles
          };
        }).filter((item) => item.styles.backgroundImage !== "none" || item.styles.backgroundColor !== "rgba(0, 0, 0, 0)"),
        regions: Array.from(document.querySelectorAll("header[data-web-clone-id],nav[data-web-clone-id],footer[data-web-clone-id],[class*='hero'][data-web-clone-id],[class*='footer'][data-web-clone-id],[class*='nav'][data-web-clone-id]")).slice(0, 80).map((element) => ({
          element_id: element.getAttribute("data-web-clone-id") || "",
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          rect: rectFor(element),
          styles: stylesFor(element)
        }))
      }
    };
  }, width);
  await browser.close();
  return {
    report: {
      http_status: response?.status() || null,
      console_errors: consoleErrors,
      network_failures: networkFailures,
      dom_checks: domChecks,
      motion_trace: motionTrace
    },
    viewportPng: await pngFromFile(viewportPath),
    fullPng: await pngFromFile(fullPath)
  };
}

async function loadSourceForViewport(runDir, sourceArg, name) {
  if (runDir) {
    const viewportPath = path.join(runDir, "sources", name, "source.json");
    if (existsSync(viewportPath)) return { source: await readJson(viewportPath), sourcePath: viewportPath };
    const sourcePath = path.join(runDir, "source.json");
    return { source: await readJson(sourcePath), sourcePath };
  }
  const sourcePath = path.resolve(sourceArg);
  return { source: await readJson(sourcePath), sourcePath };
}

async function sourcePng(source, key, fallbackPath) {
  if (source[key]) return pngFromBase64(source[key]);
  if (fallbackPath && existsSync(fallbackPath)) return pngFromFile(fallbackPath);
  return null;
}

function assetReport(runDir, appDir, source) {
  const mirror = source.asset_mirror || {};
  const assets = mirror.assets || [];
  const targetPublic = appDir ? path.join(appDir, "public") : null;
  const missingLocal = [];
  let mirroredCount = 0;
  let fallbackCount = 0;
  let requiredFallbacks = 0;
  for (const item of assets) {
    if (item.status === "mirrored") {
      mirroredCount += 1;
      if (targetPublic && item.local_path) {
        const localRel = String(item.local_path).replace(/^\/+/, "");
        if (!existsSync(path.join(targetPublic, localRel))) missingLocal.push(item.url);
      }
    } else if (item.status === "fallback") {
      fallbackCount += 1;
      if (item.required) requiredFallbacks += 1;
    }
  }
  return {
    mirrored_count: mirroredCount,
    fallback_count: fallbackCount,
    required_fallbacks: requiredFallbacks,
    missing_local: missingLocal,
    passed: missingLocal.length === 0 && requiredFallbacks === 0
  };
}

function relativeDelta(left, right) {
  const a = Number(left || 0);
  const b = Number(right || 0);
  const max = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / max;
}

function compareImageLayout(source, dom) {
  const cloneById = new Map((dom.layout?.images || []).map((image) => [image.element_id, image]));
  const checked = [];
  for (const image of source.image_metrics || []) {
    if (!image.element_id || !image.rendered_rect?.width || !image.rendered_rect?.height) continue;
    const clone = cloneById.get(image.element_id);
    if (!clone) {
      checked.push({ element_id: image.element_id, status: "missing" });
      continue;
    }
    const width_delta = relativeDelta(image.rendered_rect.width, clone.rendered_rect?.width);
    const height_delta = relativeDelta(image.rendered_rect.height, clone.rendered_rect?.height);
    const aspect_delta = image.rendered_aspect_ratio && clone.rendered_aspect_ratio ? relativeDelta(image.rendered_aspect_ratio, clone.rendered_aspect_ratio) : 0;
    const object_fit_match = !image.styles?.objectFit || image.styles.objectFit === clone.styles?.objectFit || image.styles.objectFit === "fill";
    checked.push({
      element_id: image.element_id,
      status: width_delta <= 0.28 && height_delta <= 0.28 && aspect_delta <= 0.12 && object_fit_match ? "ok" : "mismatch",
      width_delta,
      height_delta,
      aspect_delta,
      source_object_fit: image.styles?.objectFit || null,
      clone_object_fit: clone.styles?.objectFit || null
    });
  }
  const mismatches = checked.filter((item) => item.status !== "ok");
  return {
    checked_count: checked.length,
    mismatch_count: mismatches.length,
    samples: mismatches.slice(0, 12),
    passed: checked.length === 0 || mismatches.length / checked.length <= 0.25
  };
}

function compareBackgrounds(source, dom) {
  const cloneById = new Map((dom.layout?.backgrounds || []).map((item) => [item.element_id, item]));
  const importantIds = new Set(
    (source.components || [])
      .filter((component) => /(header|nav|footer|hero|cta)/i.test(`${component.tag || ""} ${component.className || ""}`))
      .map((component) => component.element_id)
      .filter(Boolean)
  );
  const checked = [];
  for (const background of source.background_metrics || []) {
    if (!background.element_id || !importantIds.has(background.element_id)) continue;
    const clone = cloneById.get(background.element_id);
    const sourceHasImage = background.backgroundImage && background.backgroundImage !== "none";
    const cloneHasImage = clone?.styles?.backgroundImage && clone.styles.backgroundImage !== "none";
    const colorMatch = !background.backgroundColor || !clone?.styles?.backgroundColor || background.backgroundColor === clone.styles.backgroundColor;
    const imageMatch = !sourceHasImage || Boolean(cloneHasImage);
    checked.push({
      element_id: background.element_id,
      status: clone && colorMatch && imageMatch ? "ok" : "mismatch",
      source_color: background.backgroundColor || null,
      clone_color: clone?.styles?.backgroundColor || null,
      source_image: sourceHasImage,
      clone_image: Boolean(cloneHasImage)
    });
  }
  const mismatches = checked.filter((item) => item.status !== "ok");
  return {
    checked_count: checked.length,
    mismatch_count: mismatches.length,
    samples: mismatches.slice(0, 12),
    passed: checked.length === 0 || mismatches.length / checked.length <= 0.35
  };
}

function compareRegions(source, dom) {
  const cloneById = new Map((dom.layout?.regions || []).map((item) => [item.element_id, item]));
  const checked = [];
  for (const component of source.components || []) {
    if (!component.element_id || !component.rect?.width || !component.rect?.height) continue;
    if (!/(header|nav|footer|hero|cta)/i.test(`${component.tag || ""} ${component.className || ""}`)) continue;
    const clone = cloneById.get(component.element_id);
    if (!clone) {
      checked.push({ element_id: component.element_id, status: "missing" });
      continue;
    }
    const width_delta = relativeDelta(component.rect.width, clone.rect?.width);
    const height_delta = relativeDelta(component.rect.height, clone.rect?.height);
    checked.push({
      element_id: component.element_id,
      status: width_delta <= 0.35 && height_delta <= 0.4 ? "ok" : "mismatch",
      width_delta,
      height_delta
    });
  }
  const mismatches = checked.filter((item) => item.status !== "ok");
  return {
    checked_count: checked.length,
    mismatch_count: mismatches.length,
    samples: mismatches.slice(0, 12),
    passed: checked.length === 0 || mismatches.length / checked.length <= 0.35
  };
}

function sourceMotionIds(source) {
  const ids = new Set();
  for (const candidate of source.motion_data?.candidates || []) {
    if (candidate.element_id) ids.add(candidate.element_id);
  }
  for (const frame of source.motion_data?.load_samples || []) {
    for (const sample of frame.samples || []) if (sample.element_id) ids.add(sample.element_id);
  }
  for (const frame of source.motion_data?.scroll_samples || []) {
    for (const sample of frame.samples || []) if (sample.element_id) ids.add(sample.element_id);
  }
  return ids;
}

async function verifyViewport(args, runDir, name, viewport) {
  const outDir = path.resolve(requiredArg(args, "out"));
  await ensureDir(outDir);
  const { source, sourcePath } = await loadSourceForViewport(runDir, args.source, name);
  const { report: appReport, viewportPng, fullPng } = await captureApp(args["app-url"], outDir, name, viewport, Boolean(args.motion));
  const screenshotsDir = runDir ? path.join(runDir, "screenshots") : path.join(path.dirname(sourcePath), "screenshots");
  const sourceViewport = await sourcePng(source, "screenshot", path.join(screenshotsDir, `${name}_viewport.png`));
  const sourceFull = await sourcePng(source, "full_page_screenshot", path.join(screenshotsDir, `${name}_full.png`));
  const firstThreshold = viewportThreshold(name, "first", Number.parseFloat(args["first-threshold"] || "0.12"));
  const fullThreshold = viewportThreshold(name, "full", Number.parseFloat(args["full-threshold"] || "0.18"));
  const visual = {
    first_viewport_mismatch: sourceViewport ? mismatchRatio(sourceViewport, viewportPng) : null,
    full_page_mismatch: sourceFull ? mismatchRatio(sourceFull, fullPng) : null,
    full_page_size_delta: sourceFull ? 1 - Math.min(sourceFull.width * sourceFull.height, fullPng.width * fullPng.height) / Math.max(sourceFull.width * sourceFull.height, fullPng.width * fullPng.height) : null
  };
  const dom = appReport.dom_checks;
  const requiredDomPass = Boolean(
    appReport.http_status >= 200 &&
      appReport.http_status < 400 &&
      dom.headerLike > 0 &&
      dom.footerLike > 0 &&
      dom.h1 > 0 &&
      dom.buttons > 0 &&
      dom.images > 0 &&
      dom.faviconLinks > 0 &&
      !dom.horizontalOverflow &&
      dom.mobileNavPass !== false &&
      !dom.dangerous
  );
  const visualPass = visual.first_viewport_mismatch !== null && visual.full_page_mismatch !== null && visual.first_viewport_mismatch <= firstThreshold && visual.full_page_mismatch <= fullThreshold;
  const cleanRuntime = appReport.console_errors.length === 0 && appReport.network_failures.length === 0;
  const fontsPass = dom.fontStatus === "loaded" || dom.fontStatus === "unsupported";
  const appDir = args["app-dir"] ? path.resolve(args["app-dir"]) : runDir ? path.join(runDir, "app") : null;
  const assets = assetReport(runDir, appDir, source);
  const imageLayout = compareImageLayout(source, dom);
  const backgrounds = compareBackgrounds(source, dom);
  const regions = compareRegions(source, dom);
  const motionRequired = Boolean(args.motion && hasMotionSource(source));
  const expectedMotionIds = sourceMotionIds(source);
  const changedMotionIds = new Set(appReport.motion_trace.changed_ids || []);
  const matchedMotionChanges = Array.from(expectedMotionIds).filter((id) => changedMotionIds.has(id));
  const motionPass =
    !motionRequired ||
    Boolean(
      appReport.motion_trace.runtime_ready &&
        (matchedMotionChanges.length > 0 || appReport.motion_trace.changed || appReport.motion_trace.motion_element_count > 0)
    );
  const faviconPass = dom.faviconLinks > 0;
  const passed = Boolean(requiredDomPass && visualPass && cleanRuntime && fontsPass && assets.passed && faviconPass && motionPass && imageLayout.passed && backgrounds.passed && regions.passed);
  return {
    passed,
    viewport: { name, width: viewport[0], height: viewport[1] },
    source: sourcePath,
    thresholds: { first_viewport: firstThreshold, full_page: fullThreshold },
    visual,
    runtime: appReport,
    assets,
    fidelity: {
      images: imageLayout,
      backgrounds,
      regions,
      motion: {
        expected_candidate_count: expectedMotionIds.size,
        matched_change_count: matchedMotionChanges.length,
        matched_change_ids: matchedMotionChanges.slice(0, 20)
      }
    },
    checks: {
      required_dom_pass: requiredDomPass,
      visual_pass: visualPass,
      clean_runtime: cleanRuntime,
      fonts_pass: fontsPass,
      favicon_pass: faviconPass,
      motion_required: motionRequired,
      motion_pass: motionPass,
      image_layout_pass: imageLayout.passed,
      background_pass: backgrounds.passed,
      region_pass: regions.passed
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["app-url"] || !args.out || (!args["run-dir"] && !args.source)) {
    console.error(usage());
    process.exit(2);
  }
  const runDir = args["run-dir"] ? path.resolve(args["run-dir"]) : null;
  let viewports;
  if ((args.viewports || "all") === "all") {
    if (runDir && existsSync(path.join(runDir, "run_manifest.json"))) {
      const manifest = await readJson(path.join(runDir, "run_manifest.json"));
      viewports = Object.fromEntries(Object.entries(manifest.viewports || {}).map(([name, profile]) => [name, [Number(profile.width), Number(profile.height)]]));
    } else {
      viewports = { desktop: [1440, 1200] };
    }
  } else {
    viewports = parseViewports(args.viewports);
  }
  const reports = [];
  for (const [name, viewport] of Object.entries(viewports)) {
    console.log(`Verifying ${name} viewport: ${viewport[0]}x${viewport[1]}`);
    reports.push(await verifyViewport(args, runDir, name, viewport));
  }
  const report = {
    passed: reports.every((item) => item.passed),
    app_url: args["app-url"],
    viewports: reports
  };
  await writeJson(path.join(path.resolve(requiredArg(args, "out")), "report.json"), report);
  console.log(`Verification report: ${path.join(path.resolve(requiredArg(args, "out")), "report.json")}`);
  if (!report.passed) {
    console.error("Clone verification failed");
    process.exit(1);
  }
  console.log("Clone verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
