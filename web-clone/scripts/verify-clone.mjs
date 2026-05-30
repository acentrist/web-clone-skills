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
      const candidates = Array.from(document.querySelectorAll(".animate-word,[data-scroll],.clone-motion-reveal,.w-dropdown,.w-nav-button,.btn_main_wrap,a,button")).slice(0, 40);
      function selectorFor(element, index) {
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
  const firstBySelector = new Map(trace[0].samples.map((sample) => [sample.selector, sample]));
  for (const frame of trace.slice(1)) {
    for (const sample of frame.samples) {
      const first = firstBySelector.get(sample.selector);
      if (!first) continue;
      if (first.opacity !== sample.opacity || first.transform !== sample.transform || first.className !== sample.className) {
        changed = true;
        break;
      }
    }
    if (changed) break;
  }
  return {
    runtime_ready: trace.some((frame) => frame.runtime === "ready"),
    changed,
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
      dangerous: document.body.innerHTML.includes("dangerouslySetInnerHTML")
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
  const motionRequired = Boolean(args.motion && hasMotionSource(source));
  const motionPass = !motionRequired || Boolean(appReport.motion_trace.runtime_ready && appReport.motion_trace.changed);
  const faviconPass = dom.faviconLinks > 0;
  const passed = Boolean(requiredDomPass && visualPass && cleanRuntime && fontsPass && assets.passed && faviconPass && motionPass);
  return {
    passed,
    viewport: { name, width: viewport[0], height: viewport[1] },
    source: sourcePath,
    thresholds: { first_viewport: firstThreshold, full_page: fullThreshold },
    visual,
    runtime: appReport,
    assets,
    checks: {
      required_dom_pass: requiredDomPass,
      visual_pass: visualPass,
      clean_runtime: cleanRuntime,
      fonts_pass: fontsPass,
      favicon_pass: faviconPass,
      motion_required: motionRequired,
      motion_pass: motionPass
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
