#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  ensureDir,
  mirrorAssets,
  normalizeHtmlUrls,
  parseArgs,
  parseViewports,
  requiredArg,
  writeJson
} from "./core.mjs";

function usage() {
  return `Usage: node scripts/prepare-clone.mjs URL --run-dir DIR [--viewports desktop=1440x1200,tablet=768x1024,mobile=390x844] [--wait 4000]`;
}

async function lazyLoad(page, waitMs) {
  await page.waitForTimeout(waitMs);
  await page.evaluate(async () => {
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const step = Math.max(320, Math.floor(window.innerHeight * 0.75));
    for (let y = 0; y < height; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(350);
}

async function motionSnapshot(page, label) {
  return page.evaluate((snapshotLabel) => {
    const candidates = Array.from(
      document.querySelectorAll(
        ".animate-word,.animate-space,[data-scroll],[data-w-id],.w-dropdown,.w-nav-button,.w-nav-menu,[class*='motion'],[class*='animate'],[class*='marquee']"
      )
    ).slice(0, 80);
    return {
      label: snapshotLabel,
      scrollY: window.scrollY,
      samples: candidates.map((element, index) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          id: element.id || "",
          text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
          opacity: style.opacity,
          transform: style.transform,
          transition: style.transition,
          animation: style.animation,
          display: style.display,
          visibility: style.visibility,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      })
    };
  }, label);
}

async function extractPage(browser, url, viewportName, viewport, options) {
  const [width, height] = viewport;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await lazyLoad(page, options.wait);

  const loadSamples = [];
  for (const delay of [0, 120, 360, 900]) {
    if (delay) await page.waitForTimeout(delay);
    loadSamples.push(await motionSnapshot(page, `load_${delay}`));
  }

  const scrollSamples = [];
  for (const y of [0, Math.floor(height * 0.65), Math.floor(height * 1.25)]) {
    await page.evaluate((targetY) => window.scrollTo(0, targetY), y);
    await page.waitForTimeout(180);
    scrollSamples.push(await motionSnapshot(page, `scroll_${y}`));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);

  const viewportBuffer = await page.screenshot({ fullPage: false });
  const fullBuffer = await page.screenshot({ fullPage: true });

  const extracted = await page.evaluate(
    async ({ maxDepth }) => {
      const importantStyles = [
        "display",
        "position",
        "inset",
        "top",
        "right",
        "bottom",
        "left",
        "zIndex",
        "width",
        "height",
        "maxWidth",
        "minHeight",
        "margin",
        "padding",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "color",
        "background",
        "backgroundColor",
        "backgroundImage",
        "border",
        "borderRadius",
        "boxShadow",
        "opacity",
        "transform",
        "transition",
        "animation",
        "overflow",
        "flexDirection",
        "justifyContent",
        "alignItems",
        "gridTemplateColumns",
        "gap"
      ];

      function stylesFor(element) {
        const style = getComputedStyle(element);
        const output = {};
        for (const key of importantStyles) output[key] = style[key] || style.getPropertyValue(key);
        return output;
      }

      function rectFor(element) {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom,
          right: rect.right
        };
      }

      function walk(element, depth = 0) {
        if (!element || depth > maxDepth || element.nodeType !== Node.ELEMENT_NODE) return null;
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          className: typeof element.className === "string" ? element.className : "",
          text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 220),
          attrs: Object.fromEntries(Array.from(element.attributes || []).map((attr) => [attr.name, attr.value])),
          rect: rectFor(element),
          styles: stylesFor(element),
          children: Array.from(element.children || []).slice(0, 80).map((child) => walk(child, depth + 1)).filter(Boolean)
        };
      }

      const assets = { images: [], scripts: [], stylesheets: [], fonts: [], links: [] };
      const pushImage = (url, extra = {}) => {
        if (!url) return;
        assets.images.push({
          url,
          src: url,
          alt: extra.alt || "",
          width: extra.width || null,
          height: extra.height || null,
          type: extra.type || "image",
          srcset: extra.srcset || ""
        });
      };
      document.querySelectorAll("img").forEach((img) => {
        pushImage(img.currentSrc || img.src, {
          alt: img.alt || "",
          width: img.naturalWidth || null,
          height: img.naturalHeight || null,
          type: "image",
          srcset: img.getAttribute("srcset") || img.srcset || ""
        });
        (img.getAttribute("srcset") || "").split(",").forEach((item) => pushImage(item.trim().split(/\s+/)[0], { type: "image-srcset" }));
        pushImage(img.getAttribute("data-src"), { alt: img.alt || "", type: "data-src" });
      });
      document.querySelectorAll("source[srcset]").forEach((source) => {
        (source.getAttribute("srcset") || "").split(",").forEach((item) => pushImage(item.trim().split(/\s+/)[0], { type: "source-srcset" }));
      });
      document.querySelectorAll("[data-src]").forEach((element) => {
        const dataSrc = element.getAttribute("data-src");
        if (dataSrc && /\.(json|lottie|png|jpe?g|webp|gif|svg)(\?|$)/i.test(dataSrc)) pushImage(dataSrc, { type: "data-src" });
      });
      document.querySelectorAll("*").forEach((element) => {
        const bg = getComputedStyle(element).backgroundImage;
        const match = bg && bg !== "none" ? bg.match(/url\(["']?([^"')]+)["']?\)/) : null;
        if (match?.[1]) pushImage(match[1], { type: "background-image" });
      });
      document.querySelectorAll("script[src]").forEach((script) => assets.scripts.push({ url: script.src, type: "script" }));
      document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => assets.stylesheets.push({ url: link.href, type: "stylesheet" }));
      document.querySelectorAll("a[href]").forEach((a) => assets.links.push({ href: a.href, text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 180) }));

      const cssData = { stylesheets: [], inline_styles: [], css_variables: {}, keyframes: [], transitions: [] };
      document.querySelectorAll("style").forEach((style, index) => cssData.inline_styles.push({ index, content: style.textContent || "" }));
      const rootStyles = getComputedStyle(document.documentElement);
      for (const name of rootStyles) {
        if (name.startsWith("--")) cssData.css_variables[name] = rootStyles.getPropertyValue(name).trim();
      }
      for (const sheet of Array.from(document.styleSheets)) {
        const item = { url: sheet.href || null, content: "", accessible: true };
        try {
          const rules = Array.from(sheet.cssRules || []);
          item.content = rules.map((rule) => rule.cssText).join("\n");
          for (const rule of rules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) cssData.keyframes.push(rule.cssText);
            if (rule instanceof CSSFontFaceRule) {
              const src = rule.style.getPropertyValue("src");
              const match = src.match(/url\(["']?([^"')]+)["']?\)/);
              if (match?.[1]) assets.fonts.push({ url: match[1], type: "font" });
            }
          }
        } catch (error) {
          item.accessible = false;
          item.error = String(error);
        }
        cssData.stylesheets.push(item);
      }

      const transitionCandidates = Array.from(document.querySelectorAll("*")).slice(0, 2500);
      transitionCandidates.forEach((element) => {
        const style = getComputedStyle(element);
        if ((style.transition && style.transition !== "all 0s ease 0s") || (style.animation && style.animation !== "none 0s ease 0s 1 normal none running")) {
          cssData.transitions.push({
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            transition: style.transition,
            animation: style.animation,
            rect: rectFor(element)
          });
        }
      });

      const icons = [];
      document.querySelectorAll("link[rel]").forEach((link) => {
        const rel = (link.getAttribute("rel") || "").toLowerCase();
        if (rel.includes("icon") || rel.includes("mask-icon") || rel.includes("manifest")) {
          icons.push({
            rel,
            href: link.href || link.getAttribute("href"),
            sizes: link.getAttribute("sizes"),
            type: link.getAttribute("type"),
            color: link.getAttribute("color")
          });
        }
      });

      const motionCandidates = Array.from(
        document.querySelectorAll(
          ".animate-word,.animate-space,[data-scroll],[data-w-id],.w-dropdown,.w-nav-button,.w-nav-menu,[class*='motion'],[class*='animate'],[class*='marquee']"
        )
      ).slice(0, 100);

      const components = Array.from(document.querySelectorAll("header,nav,main,section,article,aside,footer,[class*='nav'],[class*='footer'],[class*='hero'],[class*='cta']")).slice(0, 160).map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        id: element.id || "",
        text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 220),
        rect: rectFor(element)
      }));

      return {
        metadata: {
          url: location.href,
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
          language: document.documentElement.lang || ""
        },
        dom_tree: walk(document.body || document.documentElement),
        raw_html: document.documentElement.outerHTML,
        css_data: cssData,
        assets,
        favicon: {
          icons,
          theme_color: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || null,
          application_name: document.querySelector('meta[name="application-name"]')?.getAttribute("content") || null
        },
        motion_data: {
          candidates: motionCandidates.map((element, index) => ({
            index,
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            id: element.id || "",
            text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
            attrs: Object.fromEntries(Array.from(element.attributes || []).map((attr) => [attr.name, attr.value])),
            rect: rectFor(element),
            styles: stylesFor(element)
          })),
          markers: {
            "animate-word": Boolean(document.querySelector(".animate-word")),
            "animate-space": Boolean(document.querySelector(".animate-space")),
            "data-scroll": Boolean(document.querySelector("[data-scroll]")),
            "w-dropdown": Boolean(document.querySelector(".w-dropdown")),
            "w-nav-button": Boolean(document.querySelector(".w-nav-button")),
            "w-nav-menu": Boolean(document.querySelector(".w-nav-menu")),
            "webflow-ix": Boolean(document.querySelector("[data-w-id], [data-animation-type]"))
          }
        },
        components,
        page_metrics: {
          width: window.innerWidth,
          height: window.innerHeight,
          scroll_width: document.documentElement.scrollWidth,
          scroll_height: document.documentElement.scrollHeight
        }
      };
    },
    { maxDepth: options.maxDepth }
  );

  for (const sheet of extracted.css_data.stylesheets) {
    if (options.noFetchCss || sheet.content || !sheet.url) continue;
    try {
      const response = await fetch(sheet.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; web-clone/1.0)" } });
      if (response.ok) sheet.content = await response.text();
    } catch (error) {
      sheet.fetch_error = error instanceof Error ? error.message : String(error);
    }
  }

  const source = {
    url,
    viewport: { name: viewportName, width, height },
    metadata: extracted.metadata,
    dom_tree: extracted.dom_tree,
    raw_html: normalizeHtmlUrls(extracted.raw_html, url),
    css_data: extracted.css_data,
    assets: dedupeAssets(extracted.assets, url),
    favicon: extracted.favicon,
    motion_data: {
      ...extracted.motion_data,
      load_samples: loadSamples,
      scroll_samples: scrollSamples
    },
    components: extracted.components,
    page_metrics: extracted.page_metrics,
    screenshot: viewportBuffer.toString("base64"),
    full_page_screenshot: fullBuffer.toString("base64")
  };

  await page.close();
  return { source, viewportBuffer, fullBuffer };
}

function dedupeAssets(assets, baseUrl) {
  const normalize = (value) => {
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return value;
    }
  };
  const dedupe = (items, key) => {
    const seen = new Set();
    return (items || []).map((item) => {
      const normalized = normalize(item[key] || item.url || item.src || item.href);
      return { ...item, [key]: normalized, ...(item.url ? { url: normalized } : {}), ...(item.src ? { src: normalized } : {}) };
    }).filter((item) => {
      const value = item[key] || item.url || item.src || item.href;
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  };
  return {
    images: dedupe(assets.images, "url"),
    scripts: dedupe(assets.scripts, "url"),
    stylesheets: dedupe(assets.stylesheets, "url"),
    fonts: dedupe(assets.fonts, "url"),
    links: dedupe(assets.links, "href")
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["url"]);
  if (!args.url || !args["run-dir"]) {
    console.error(usage());
    process.exit(2);
  }
  const url = String(args.url);
  const runDir = path.resolve(requiredArg(args, "run-dir"));
  const viewports = parseViewports(args.viewports || "all");
  const options = {
    wait: Number.parseInt(args.wait || "4000", 10),
    maxDepth: Number.parseInt(args["max-depth"] || "30", 10),
    noFetchCss: Boolean(args["no-fetch-css"]),
    mirrorAssets: !args["no-mirror-assets"]
  };

  await ensureDir(runDir);
  await ensureDir(path.join(runDir, "screenshots"));
  await ensureDir(path.join(runDir, "sources"));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const sources = {};
  try {
    for (const [name, viewport] of Object.entries(viewports)) {
      console.log(`Extracting ${name} viewport: ${viewport[0]}x${viewport[1]}`);
      const { source, viewportBuffer, fullBuffer } = await extractPage(browser, url, name, viewport, options);
      sources[name] = source;
      const sourceDir = path.join(runDir, "sources", name);
      await ensureDir(sourceDir);
      await fs.writeFile(path.join(runDir, "screenshots", `${name}_viewport.png`), viewportBuffer);
      await fs.writeFile(path.join(runDir, "screenshots", `${name}_full.png`), fullBuffer);
      await writeJson(path.join(sourceDir, "source.json"), source);
    }
  } finally {
    await browser.close();
  }

  const assetMirror = options.mirrorAssets ? await mirrorAssets(sources, runDir) : { assets: [], by_url: {}, failures: [], disabled: true };
  const viewportProfiles = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { width: source.viewport.width, height: source.viewport.height, page_height: source.page_metrics?.scroll_height || 0 }]));
  const sourceSet = Object.fromEntries(Object.keys(sources).map((name) => [name, `sources/${name}/source.json`]));
  for (const [name, source] of Object.entries(sources)) {
    source.asset_mirror = assetMirror;
    source.viewport_profiles = viewportProfiles;
    source.source_set = sourceSet;
    await writeJson(path.join(runDir, "sources", name, "source.json"), source);
  }

  const desktopName = sources.desktop ? "desktop" : Object.keys(sources)[0];
  await writeJson(path.join(runDir, "source.json"), sources[desktopName]);
  await fs.copyFile(path.join(runDir, "screenshots", `${desktopName}_viewport.png`), path.join(runDir, "screenshots", "source_viewport.png"));
  await fs.copyFile(path.join(runDir, "screenshots", `${desktopName}_full.png`), path.join(runDir, "screenshots", "source_full.png"));
  await writeJson(path.join(runDir, "assets.json"), assetMirror);
  await writeJson(path.join(runDir, "run_manifest.json"), {
    url,
    prepared_at: new Date().toISOString(),
    viewports: viewportProfiles,
    source_set: sourceSet,
    desktop_alias: desktopName,
    asset_mirror: {
      mirrored_count: assetMirror.assets.filter((item) => item.status === "mirrored").length,
      fallback_count: assetMirror.failures.length
    }
  });
  console.log(`Prepared ${Object.keys(sources).length} viewports at ${runDir}`);
  console.log(`Mirrored assets: ${assetMirror.assets.filter((item) => item.status === "mirrored").length}, fallbacks: ${assetMirror.failures.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
