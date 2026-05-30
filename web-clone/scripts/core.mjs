import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

const DEFAULT_VIEWPORTS = {
  desktop: [1440, 1200],
  tablet: [768, 1024],
  mobile: [390, 844]
};

export const DEFAULT_VIEWPORT_THRESHOLDS = {
  desktop: { first: 0.12, full: 0.18 },
  tablet: { first: 0.16, full: 0.22 },
  mobile: { first: 0.18, full: 0.24 }
};

const SKIP_URL_PREFIXES = ["data:", "javascript:", "mailto:", "tel:", "#", "{", "$", "about:", "blob:"];
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
const SKIP_TAGS_FOR_COMPONENTS = new Set(["script", "noscript", "iframe"]);

export function parseArgs(argv, positionalNames = []) {
  const args = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const key = token.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) {
      args[key] = token.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  positionalNames.forEach((name, index) => {
    if (positionals[index] !== undefined) args[name] = positionals[index];
  });
  args._ = positionals;
  return args;
}

export function requiredArg(args, name) {
  if (!args[name]) throw new Error(`Missing required argument --${name}`);
  return String(args[name]);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function writeText(file, content) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, "utf8");
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function writeJson(file, data) {
  await writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function copyDir(source, target) {
  if (!existsSync(source)) return;
  await ensureDir(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
}

function snakeCase(value, fallback = "section") {
  const clean = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return clean || fallback;
}

function pascalCase(value, fallback = "Section") {
  const parts = String(value || "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  let name = parts.map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  if (!name) name = fallback;
  if (/^\d/.test(name)) name = `${fallback}${name}`;
  return name;
}

export function safePackageName(name) {
  return String(name || "cloned-website").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "cloned-website";
}

export function parseViewports(value) {
  if (!value || value === "all") return { ...DEFAULT_VIEWPORTS };
  const result = {};
  for (const item of String(value).split(",")) {
    const part = item.trim();
    if (!part) continue;
    const [rawName, rawSize] = part.includes("=") ? part.split("=", 2) : [`viewport${Object.keys(result).length + 1}`, part];
    const [width, height] = rawSize.toLowerCase().split("x").map((piece) => Number.parseInt(piece, 10));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Invalid viewport: ${part}`);
    result[snakeCase(rawName, "viewport")] = [width, height];
  }
  if (!Object.keys(result).length) throw new Error("No viewports parsed");
  return result;
}

function normalizeUrlValue(value, baseUrl) {
  if (!value) return value;
  const stripped = String(value).trim();
  if (stripped.startsWith("/assets/")) return stripped;
  if (SKIP_URL_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return value;
  if (stripped.startsWith("//")) {
    const parsed = new URL(baseUrl || "https://target.invalid/");
    return `${parsed.protocol}${stripped}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(stripped)) return stripped;
  try {
    return new URL(stripped, baseUrl).toString();
  } catch {
    return value;
  }
}

function normalizeSrcset(value, baseUrl) {
  return String(value || "")
    .split(",")
    .map((item) => {
      const tokens = item.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return "";
      const url = normalizeUrlValue(tokens[0], baseUrl);
      return [url, ...tokens.slice(1)].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function collectSrcsetUrls(value, baseUrl) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((url) => normalizeUrlValue(url, baseUrl))
    .filter(isMirrorableUrl);
}

export function normalizeHtmlUrls(html, baseUrl) {
  let result = String(html || "");
  for (const attr of ["src", "href", "poster", "data-src"]) {
    const pattern = new RegExp(`(${attr}=["'])([^"']+)(["'])`, "gi");
    result = result.replace(pattern, (_, prefix, url, suffix) => `${prefix}${normalizeUrlValue(url, baseUrl)}${suffix}`);
  }
  result = result.replace(/(srcset=["'])([^"']+)(["'])/gi, (_, prefix, srcset, suffix) => `${prefix}${normalizeSrcset(srcset, baseUrl)}${suffix}`);
  result = result.replace(/(data-srcset=["'])([^"']+)(["'])/gi, (_, prefix, srcset, suffix) => `${prefix}${normalizeSrcset(srcset, baseUrl)}${suffix}`);
  result = result.replace(/(url\(["']?)([^"')\s]+)(["']?\))/gi, (_, prefix, url, suffix) => `${prefix}${normalizeUrlValue(url, baseUrl)}${suffix}`);
  return result;
}

function isMirrorableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function extensionForUrl(url, contentType = "") {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext && ext.length <= 8) return ext;
  const type = contentType.split(";")[0].trim().toLowerCase();
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "application/font-woff2": ".woff2",
    "application/json": ".json",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "text/css": ".css"
  };
  return map[type] || ".bin";
}

function collectCssUrls(content, baseUrl) {
  const urls = [];
  for (const match of String(content || "").matchAll(/url\(["']?([^"')\s]+)["']?\)/gi)) {
    const url = normalizeUrlValue(match[1], baseUrl);
    if (isMirrorableUrl(url)) urls.push(url);
  }
  return urls;
}

function extractFaviconFromHtml(html, baseUrl) {
  const $ = cheerio.load(html || "");
  const icons = [];
  $("link").each((_, element) => {
    const rel = String($(element).attr("rel") || "").toLowerCase();
    const href = $(element).attr("href");
    if (!href) return;
    if (rel.includes("icon") || rel.includes("mask-icon") || rel.includes("manifest")) {
      icons.push({
        rel: rel || "icon",
        href: normalizeUrlValue(href, baseUrl),
        sizes: $(element).attr("sizes") || null,
        type: $(element).attr("type") || null,
        color: $(element).attr("color") || null
      });
    }
  });
  return {
    icons,
    theme_color: $('meta[name="theme-color"]').attr("content") || null,
    application_name: $('meta[name="application-name"]').attr("content") || null
  };
}

function collectAssetCandidates(source) {
  const baseUrl = source.url || source.metadata?.url || "";
  const candidates = [];
  const add = (url, kind, required = false) => {
    const normalized = normalizeUrlValue(url, baseUrl);
    if (isMirrorableUrl(normalized)) candidates.push({ url: normalized, kind, required });
  };

  for (const image of source.assets?.images || []) {
    add(image.url || image.src, "image", true);
    for (const url of collectSrcsetUrls(image.srcset || image.srcSet || "", baseUrl)) add(url, "image", true);
  }
  for (const font of source.assets?.fonts || []) add(font.url, "font", false);
  for (const sheet of source.css_data?.stylesheets || []) {
    const sheetBase = /^https?:\/\//i.test(sheet.url || "") ? sheet.url : baseUrl;
    for (const url of collectCssUrls(sheet.content || "", sheetBase)) {
      add(url, /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(new URL(url).pathname) ? "font" : "css-url", false);
    }
  }
  const favicon = source.favicon || extractFaviconFromHtml(source.raw_html || "", baseUrl);
  for (const icon of favicon.icons || []) add(icon.href, "favicon", true);

  const $ = cheerio.load(source.raw_html || "");
  $("img,source,video,audio,track,embed,object").each((_, element) => {
    const tag = element.tagName?.toLowerCase();
    for (const attr of ["src", "data-src", "poster"]) add($(element).attr(attr), "image", tag === "img" || tag === "source");
    for (const attr of ["srcset", "data-srcset"]) {
      for (const url of collectSrcsetUrls($(element).attr(attr) || "", baseUrl)) add(url, "image", tag === "img" || tag === "source");
    }
  });
  $("link").each((_, element) => {
    const rel = String($(element).attr("rel") || "").toLowerCase();
    const asType = String($(element).attr("as") || "").toLowerCase();
    const href = $(element).attr("href");
    if (!href) return;
    if (rel.includes("icon") || rel.includes("manifest") || rel.includes("preload") || rel.includes("prefetch")) {
      add(href, asType === "font" ? "font" : rel.includes("icon") ? "favicon" : "asset", rel.includes("icon"));
    }
  });
  $("[data-src],[data-lottie-src]").each((_, element) => {
    for (const attr of ["data-src", "data-lottie-src"]) {
      const value = $(element).attr(attr);
      if (value && /\.(json|lottie)(\?|$)/i.test(new URL(normalizeUrlValue(value, baseUrl)).pathname)) add(value, "asset", false);
    }
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

export async function mirrorAssets(sources, runDir, maxBytes = 12_000_000) {
  const assetsDir = path.join(runDir, "public", "assets");
  await ensureDir(assetsDir);
  const byCandidate = new Map();
  for (const source of Object.values(sources)) {
    for (const candidate of collectAssetCandidates(source)) {
      const existing = byCandidate.get(candidate.url);
      if (existing) existing.required = existing.required || candidate.required;
      else byCandidate.set(candidate.url, { ...candidate });
    }
  }

  const assets = [];
  const byUrl = {};
  const failures = [];
  for (const [url, candidate] of byCandidate) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; web-clone/1.0)",
          accept: "*/*"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number.parseInt(response.headers.get("content-length") || "0", 10);
      if (length > maxBytes) throw new Error(`asset exceeds ${maxBytes} bytes`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error(`asset exceeds ${maxBytes} bytes`);
      const digest = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
      const kind = snakeCase(candidate.kind || "asset", "asset").replaceAll("_", "-");
      const filename = `${kind}-${digest}${extensionForUrl(url, response.headers.get("content-type") || "")}`;
      const file = path.join(assetsDir, filename);
      await fs.writeFile(file, buffer);
      const localPath = `/assets/${filename}`;
      byUrl[url] = localPath;
      assets.push({
        url,
        kind: candidate.kind,
        required: Boolean(candidate.required),
        status: "mirrored",
        local_path: localPath,
        file: path.relative(runDir, file),
        content_type: response.headers.get("content-type") || "",
        bytes: buffer.length
      });
    } catch (error) {
      const failure = {
        url,
        kind: candidate.kind,
        required: Boolean(candidate.required),
        status: "fallback",
        error: error instanceof Error ? error.message : String(error)
      };
      failures.push(failure);
      assets.push(failure);
    }
  }
  return { assets, by_url: byUrl, failures, base_dir: assetsDir };
}

function assetMapFromSource(source) {
  return { ...(source.asset_mirror?.by_url || {}) };
}

export function rewriteUrlsWithAssetMap(content, assetMap, baseUrl = "") {
  let result = String(content || "");
  const entries = Object.entries(assetMap || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [original, local] of entries) result = result.split(original).join(local);
  if (baseUrl) {
    result = result.replace(/url\(["']?([^"')\s]+)["']?\)/gi, (match, rawUrl) => {
      const normalized = normalizeUrlValue(rawUrl, baseUrl);
      return assetMap[normalized] ? `url("${assetMap[normalized]}")` : match;
    });
  }
  return result;
}

function buildOriginalCss(source) {
  const assetMap = assetMapFromSource(source);
  const parts = [];
  for (const sheet of source.css_data?.stylesheets || []) {
    const base = /^https?:\/\//i.test(sheet.url || "") ? sheet.url : source.url;
    const content = rewriteUrlsWithAssetMap(sheet.content || "", assetMap, base);
    if (content.trim()) {
      parts.push(`/* Source: ${sheet.url || "inline"} */`);
      parts.push(content);
    }
  }
  for (const style of source.css_data?.inline_styles || []) {
    const content = rewriteUrlsWithAssetMap(style.content || "", assetMap, source.url);
    if (content.trim()) parts.push(content);
  }
  return balanceCssBraces(`${parts.join("\n\n")}\n`);
}

function balanceCssBraces(css) {
  let balance = 0;
  for (const char of css) {
    if (char === "{") balance += 1;
    else if (char === "}") balance -= 1;
  }
  if (balance > 0) return `${css}\n${"}".repeat(balance)}\n`;
  return css;
}

const FIDELITY_LAYOUT_PROPS = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "maxWidth",
  "minWidth",
  "minHeight",
  "margin",
  "padding",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "backgroundImage",
  "backgroundSize",
  "backgroundPosition",
  "backgroundRepeat",
  "backgroundAttachment",
  "border",
  "borderColor",
  "borderWidth",
  "borderStyle",
  "borderRadius",
  "boxShadow",
  "overflow",
  "overflowX",
  "overflowY",
  "flexDirection",
  "flexWrap",
  "justifyContent",
  "alignItems",
  "alignContent",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gap",
  "rowGap",
  "columnGap",
  "textAlign",
  "textTransform",
  "whiteSpace",
  "filter",
  "clipPath"
];

const FIDELITY_IMAGE_PROPS = ["width", "height", "maxWidth", "maxHeight", "aspectRatio", "objectFit", "objectPosition", "display"];
const MOTION_STYLE_PROPS = ["opacity", "transform", "filter", "clipPath", "visibility", "display", "backgroundColor", "color", "borderColor", "boxShadow"];

function pickProps(styles = {}, props = FIDELITY_LAYOUT_PROPS) {
  const output = {};
  for (const prop of props) {
    const value = styles[prop];
    if (value === undefined || value === null || value === "" || value === "normal" || value === "none 0s ease 0s") continue;
    output[prop] = value;
  }
  return output;
}

function createElementIndex(root) {
  const byId = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.element_id) byId.set(node.element_id, node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return byId;
}

function idsForSection($, element) {
  const ids = new Set();
  const rootId = $(element).attr("data-web-clone-id");
  if (rootId) ids.add(rootId);
  $("[data-web-clone-id]", element).each((_, child) => ids.add($(child).attr("data-web-clone-id")));
  return ids;
}

function compactRect(rect) {
  if (!rect) return null;
  return {
    x: Number(rect.x || 0),
    y: Number(rect.y || 0),
    width: Number(rect.width || 0),
    height: Number(rect.height || 0),
    top: Number(rect.top ?? rect.y ?? 0),
    left: Number(rect.left ?? rect.x ?? 0),
    bottom: Number(rect.bottom ?? 0),
    right: Number(rect.right ?? 0)
  };
}

function createLayoutContract(section, ids, elementIndex) {
  const important = [];
  for (const id of ids) {
    const node = elementIndex.get(id);
    if (!node) continue;
    const tag = node.tag || "";
    const className = node.className || "";
    const isImportant =
      id === section.element_id ||
      /^(header|nav|main|section|article|aside|footer|h1|h2|h3|a|button|img|picture|svg)$/i.test(tag) ||
      /(hero|header|footer|nav|button|btn|cta|card|image|media|grid|layout|section)/i.test(className || "");
    if (!isImportant) continue;
    important.push({
      element_id: id,
      tag,
      className,
      id_attr: node.id || "",
      text: node.text || "",
      rect: compactRect(node.rect),
      styles: pickProps(node.styles || {})
    });
  }
  return {
    root_element_id: section.element_id || null,
    element_ids: Array.from(ids),
    viewport: section.viewport || null,
    important_elements: important.slice(0, 160)
  };
}

function createImageContract(source, ids) {
  const assetMap = assetMapFromSource(source);
  return {
    images: (source.image_metrics || [])
      .filter((image) => ids.has(image.element_id))
      .slice(0, 80)
      .map((image) => ({
        ...image,
        local_src: assetMap[normalizeUrlValue(image.currentSrc || image.src || "", source.url)] || null,
        styles: pickProps(image.styles || {}, FIDELITY_IMAGE_PROPS)
      }))
  };
}

function createBackgroundContract(source, ids) {
  const assetMap = assetMapFromSource(source);
  return {
    backgrounds: (source.background_metrics || [])
      .filter((item) => ids.has(item.element_id))
      .slice(0, 120)
      .map((item) => ({
        ...item,
        local_urls: (item.urls || []).map((url) => assetMap[normalizeUrlValue(url, source.url)] || null).filter(Boolean),
        styles: pickProps(item, ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundAttachment"])
      }))
  };
}

function createPseudoContract(source, ids) {
  return {
    pseudo_elements: (source.pseudo_elements || [])
      .filter((item) => ids.has(item.element_id))
      .slice(0, 80)
      .map((item) => ({
        element_id: item.element_id,
        pseudo: item.pseudo,
        rect: compactRect(item.rect),
        styles: pickProps(item.styles || {}, ["content", ...FIDELITY_LAYOUT_PROPS])
      }))
  };
}

function sampleMap(frame) {
  return new Map((frame?.samples || []).filter((sample) => sample.element_id).map((sample) => [sample.element_id, sample]));
}

function styleDiff(before = {}, after = {}, props = MOTION_STYLE_PROPS) {
  const diff = {};
  for (const prop of props) {
    if (before[prop] !== after[prop] && after[prop] !== undefined && after[prop] !== null) diff[prop] = after[prop];
  }
  return diff;
}

function sampleChanged(before, after) {
  if (!before || !after) return false;
  if (before.className !== after.className) return true;
  return Object.keys(styleDiff(before.styles || before, after.styles || after)).length > 0;
}

function createMotionManifest(source) {
  const motion = source.motion_data || {};
  const candidates = new Map();
  for (const candidate of motion.candidates || []) {
    if (!candidate.element_id) continue;
    candidates.set(candidate.element_id, {
      element_id: candidate.element_id,
      tag: candidate.tag || "",
      className: candidate.className || "",
      attrs: candidate.attrs || {},
      rect: compactRect(candidate.rect),
      triggers: []
    });
  }

  const loadFrames = motion.load_samples || [];
  if (loadFrames.length >= 2) {
    const first = sampleMap(loadFrames[0]);
    const last = sampleMap(loadFrames.at(-1));
    for (const [id, before] of first) {
      const after = last.get(id);
      if (!after || !sampleChanged(before, after)) continue;
      const item = candidates.get(id) || { element_id: id, triggers: [] };
      item.triggers.push({
        type: "load",
        delay_ms: 120,
        initial_styles: pickProps(before, MOTION_STYLE_PROPS),
        final_styles: pickProps(after, MOTION_STYLE_PROPS),
        initial_class: before.className || "",
        final_class: after.className || ""
      });
      candidates.set(id, item);
    }
  }

  const scrollFrames = motion.scroll_samples || [];
  if (scrollFrames.length >= 2) {
    const first = sampleMap(scrollFrames[0]);
    for (const frame of scrollFrames.slice(1)) {
      const current = sampleMap(frame);
      for (const [id, before] of first) {
        const after = current.get(id);
        if (!after || !sampleChanged(before, after)) continue;
        const item = candidates.get(id) || { element_id: id, triggers: [] };
        if (item.triggers.some((trigger) => trigger.type === "scroll")) continue;
        const triggerY = Number(frame.scrollY || 0);
        item.triggers.push({
          type: "scroll",
          trigger_scroll_y: triggerY,
          root_margin: triggerY > 0 ? "0px 0px -12% 0px" : "0px",
          threshold: triggerY > 0 ? 0.08 : 0.01,
          initial_styles: pickProps(before, MOTION_STYLE_PROPS),
          final_styles: pickProps(after, MOTION_STYLE_PROPS),
          initial_class: before.className || "",
          final_class: after.className || ""
        });
        candidates.set(id, item);
      }
    }
  }

  for (const [type, samples] of Object.entries(motion.interaction_samples || {})) {
    for (const sample of samples || []) {
      if (!sample?.candidate?.element_id || !sampleChanged(sample.before, sample.after)) continue;
      const id = sample.candidate.element_id;
      const item = candidates.get(id) || { element_id: id, triggers: [] };
      item.triggers.push({
        type,
        initial_styles: pickProps(sample.before?.styles || {}, MOTION_STYLE_PROPS),
        final_styles: pickProps(sample.after?.styles || {}, MOTION_STYLE_PROPS),
        initial_class: sample.before?.className || "",
        final_class: sample.after?.className || "",
        attrs: sample.after?.attrs || {}
      });
      candidates.set(id, item);
    }
  }

  for (const [id, item] of candidates) {
    const className = item.className || "";
    const attrs = item.attrs || {};
    if (!item.triggers.length && /animate-word|animate-space/i.test(className)) {
      item.triggers.push({
        type: "load",
        delay_ms: 120,
        initial_styles: { opacity: "0", transform: "translateY(0.7em)" },
        final_styles: { opacity: "1", transform: "translateY(0)" }
      });
    }
    if (!item.triggers.length && (attrs["data-scroll"] !== undefined || attrs["data-w-id"] !== undefined || /reveal|motion|animate/i.test(className))) {
      item.triggers.push({
        type: "scroll",
        root_margin: "0px 0px -12% 0px",
        threshold: 0.08,
        initial_styles: { opacity: "0", transform: "translateY(18px)" },
        final_styles: { opacity: "1", transform: "translateY(0)" }
      });
    }
    candidates.set(id, item);
  }

  return {
    items: Array.from(candidates.values()).filter((item) => item.triggers?.length).slice(0, 120),
    markers: motion.markers || {}
  };
}

function createMotionContract(source, ids = null) {
  const motion = source.motion_data || {};
  const css = source.css_data || {};
  const markers = motion.markers || {};
  const filterByIds = (items) => (ids ? (items || []).filter((item) => !item.element_id || ids.has(item.element_id)) : items || []);
  return {
    has_motion: Boolean((motion.candidates || []).length || (css.keyframes || []).length || Object.values(markers).some(Boolean)),
    markers: Object.entries(markers).filter(([, value]) => Boolean(value)).map(([key]) => key),
    candidates: filterByIds(motion.candidates).slice(0, 80),
    load_samples: motion.load_samples || [],
    scroll_samples: motion.scroll_samples || [],
    interaction_samples: motion.interaction_samples || {},
    keyframes: css.keyframes || [],
    transitions: filterByIds(css.transitions).slice(0, 160),
    acceptance: [
      "Preserve source motion markers where practical.",
      "Visible nav/dropdown, hover/focus, word stagger, and scroll reveal behavior must be represented.",
      "Verification with --motion must observe runtime readiness and class/style changes when source motion exists."
    ]
  };
}

function elementText($, element) {
  return $(element).text().replace(/\s+/g, " ").trim();
}

function hasClassLike($, element, pattern) {
  const className = String($(element).attr("class") || "");
  return pattern.test(className);
}

function domOrder(root, node) {
  let order = 0;
  let found = -1;
  const visit = (current) => {
    if (found !== -1 || !current) return;
    if (current === node) {
      found = order;
      return;
    }
    order += 1;
    for (const child of current.children || []) visit(child);
  };
  visit(root);
  return found === -1 ? Number.MAX_SAFE_INTEGER : found;
}

function isDescendant(parent, child) {
  let current = child?.parent;
  while (current) {
    if (current === parent) return true;
    current = current.parent;
  }
  return false;
}

function nodeType($, element) {
  const tag = element.tagName?.toLowerCase() || "section";
  const className = String($(element).attr("class") || "").toLowerCase();
  if (tag === "nav" || className.includes("nav_") || className.includes("nav-") || className.includes("nav ")) return "navigation";
  if (tag === "header" || className.includes("header") || className.includes("hero")) return $("h1", element).length ? "header" : "navigation";
  if (tag === "footer" || className.includes("footer")) return "footer";
  if (className.includes("cta")) return "cta";
  return "section";
}

function analyzeSections(source, maxSections = 12) {
  const $ = cheerio.load(source.raw_html || "", { decodeEntities: false });
  $("script,noscript,iframe").remove();
  const body = $("body").get(0) || $.root().get(0);
  const selected = [];
  const topmost = (selector, preferLast = false) => {
    const nodes = $(selector).get().filter((element) => {
      const text = elementText($, element);
      if (text.length < 2 && !$("img,svg,picture", element).length) return false;
      let current = element.parent;
      while (current && current.type === "tag") {
        if ($(current).is(selector)) return false;
        current = current.parent;
      }
      return true;
    });
    return preferLast ? nodes.at(-1) : nodes[0];
  };

  const add = (element, typeHint = null) => {
    if (!element || element.type !== "tag") return;
    const tag = element.tagName?.toLowerCase();
    if (!tag || ["html", "head", "body", "script", "style", "meta", "link"].includes(tag)) return;
    const text = elementText($, element);
    if (text.length < 2 && !$("img,svg,picture", element).length) return;
    if (selected.some((item) => item.element === element)) return;
    const protectedType = ["navigation", "header", "footer"].includes(typeHint || nodeType($, element));
    if (!protectedType && selected.some((item) => isDescendant(item.element, element))) return;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (isDescendant(element, selected[index].element) && protectedType) selected.splice(index, 1);
    }
    selected.push({ element, type: typeHint || nodeType($, element) });
  };

  const navRoot = topmost("nav,[class*='nav_component'],[class*='nav-'],[class*='nav_']");
  const footerRoot = topmost("footer,[class*='footer']", true);
  add(navRoot, "navigation");
  const firstH1 = $("h1").first();
  if (firstH1.length) {
    const hero = firstH1.closest("header,section").get(0) || firstH1.closest("[class*='hero'],[class*='header'],body > div").get(0);
    add(hero || firstH1.parent().get(0), "header");
  }
  $("main section, body > section, body > main > section, [class*='section'], [class*='cta']").each((_, element) => {
    if (selected.length >= maxSections - 1) return;
    if ((navRoot && (element === navRoot || isDescendant(navRoot, element))) || (footerRoot && (element === footerRoot || isDescendant(footerRoot, element)))) return;
    add(element);
  });
  add(footerRoot, "footer");

  if (selected.length < 3) {
    const roots = $("main").children().length ? $("main").children() : $("body").children();
    roots.each((_, element) => {
      if (selected.length >= maxSections) return;
      add(element);
    });
  }

  const root = $.root().get(0);
  selected.sort((left, right) => domOrder(root, left.element) - domOrder(root, right.element));

  return selected.slice(0, maxSections).map((item, index) => {
    const namespace = `${item.type}_${index + 1}`;
    const html = $.html(item.element);
    const elementId = $(item.element).attr("data-web-clone-id") || null;
    return {
      id: namespace,
      order: index,
      type: item.type,
      namespace,
      component_name: pascalCase(namespace, "Section"),
      element_id: elementId,
      element_ids: Array.from(idsForSection($, item.element)),
      viewport: source.viewport || null,
      outer_html: html,
      text: elementText($, item.element).slice(0, 2000),
      images: $("img", item.element).map((_, img) => ({
        src: normalizeUrlValue($(img).attr("src") || "", source.url),
        alt: $(img).attr("alt") || ""
      })).get(),
      links: $("a[href]", item.element).map((_, link) => ({
        href: normalizeUrlValue($(link).attr("href") || "", source.url),
        text: elementText($, link).slice(0, 180)
      })).get()
    };
  });
}

export async function createContractBundle(source, outDir, maxTokens = 10_000, viewportSources = null) {
  await removeDir(outDir);
  await ensureDir(path.join(outDir, "contracts"));
  await ensureDir(path.join(outDir, "prompts"));
  const sections = analyzeSections(source);
  const assetMap = assetMapFromSource(source);
  const elementIndex = createElementIndex(source.dom_tree);
  const sourceViewports = viewportSources && Object.keys(viewportSources).length ? viewportSources : { [source.viewport?.name || "desktop"]: source };
  const favicon = source.favicon || extractFaviconFromHtml(source.raw_html || "", source.url);
  const motionManifest = createMotionManifest(source);
  const shared = {
    source_url: source.url,
    title: source.metadata?.title || "",
    original_css: buildOriginalCss(source),
    assets: source.assets || {},
    asset_mirror: source.asset_mirror || {},
    favicon,
    document_state: source.document_state || {},
    viewport_profiles: source.viewport_profiles || {},
    motion_contract: createMotionContract(source),
    motion_manifest: motionManifest,
    visual_contract: {
      images: source.image_metrics || [],
      backgrounds: source.background_metrics || [],
      pseudo_elements: source.pseudo_elements || [],
      components: source.components || []
    }
  };
  await writeJson(path.join(outDir, "shared.json"), shared);

  const contracts = [];
  for (const section of sections) {
    const componentName = section.component_name;
    const ids = new Set(section.element_ids || []);
    const layoutContract = createLayoutContract(section, ids, elementIndex);
    const imageContract = createImageContract(source, ids);
    const backgroundContract = createBackgroundContract(source, ids);
    const pseudoContract = createPseudoContract(source, ids);
    const viewportContracts = {};
    for (const [viewportName, viewportSource] of Object.entries(sourceViewports)) {
      const viewportSection = { ...section, viewport: viewportSource.viewport || section.viewport };
      const viewportIndex = createElementIndex(viewportSource.dom_tree);
      viewportContracts[viewportName] = {
        viewport: viewportSource.viewport || null,
        layout_contract: createLayoutContract(viewportSection, ids, viewportIndex),
        image_contract: createImageContract(viewportSource, ids),
        background_contract: createBackgroundContract(viewportSource, ids),
        pseudo_contract: createPseudoContract(viewportSource, ids)
      };
    }
    const contract = {
      id: section.id,
      order: section.order,
      type: section.type,
      namespace: section.namespace,
      component_name: componentName,
      element_id: section.element_id,
      source: {
        raw_html: rewriteUrlsWithAssetMap(normalizeHtmlUrls(section.outer_html, source.url), assetMap, source.url),
        text: section.text,
        images: section.images,
        links: section.links,
        motion_contract: createMotionContract(source, ids)
      },
      layout_contract: layoutContract,
      image_contract: imageContract,
      background_contract: backgroundContract,
      pseudo_contract: pseudoContract,
      viewport_contracts: viewportContracts,
      motion_contract: createMotionContract(source, ids),
      constraints: {
        max_tokens: maxTokens,
        preserve_wrapper: true,
        no_dangerously_set_inner_html: true,
        local_assets_default: true,
        preserve_data_web_clone_id: true
      },
      acceptance_criteria: [
        "Preserve the source root wrapper, class names, asset URLs, links, and text.",
        "Render explicit JSX with no dangerouslySetInnerHTML.",
        "Keep header/nav/footer wrappers intact.",
        "Preserve motion markers and interaction state where visible.",
        "Respect layout, image, background, pseudo-element, and motion contracts unless visual verification shows a better correction."
      ],
      deliverables: [
        {
          path: `src/components/sections/${section.namespace}/${componentName}.jsx`,
          export: componentName
        },
        {
          path: `src/components/sections/${section.namespace}/${section.namespace}.css`
        }
      ],
      fidelity_css: ""
    };
    contract.fidelity_css = generateSectionFidelityCss(contract, assetMap, source.url);
    contracts.push(contract);
    await writeJson(path.join(outDir, "contracts", `${section.namespace}.json`), contract);
    await writeText(
      path.join(outDir, "prompts", `${section.namespace}.md`),
      `Generate ${componentName} from contracts/${section.namespace}.json. Use explicit JSX and preserve local assets.\n`
    );
  }

  const integration = {
    source_url: source.url,
    framework: "vite-react-tailwind",
    components: contracts.map((contract) => ({
      id: contract.id,
      namespace: contract.namespace,
      component_name: contract.component_name,
      import_path: `./components/sections/${contract.namespace}/${contract.component_name}.jsx`
    })),
    viewports: source.viewport_profiles || DEFAULT_VIEWPORTS,
    viewport_thresholds: DEFAULT_VIEWPORT_THRESHOLDS,
    motion_required_when_source_has_motion: true
  };
  await writeJson(path.join(outDir, "integration_plan.json"), integration);
  await writeJson(path.join(outDir, "layout.json"), {
    source_url: source.url,
    sections: sections.map(({ outer_html, ...rest }) => rest)
  });
  return { contracts, integration, shared };
}

function cssEscapeString(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function cssPropName(prop) {
  return String(prop).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function cssDecls(styles = {}, assetMap = {}, baseUrl = "", options = {}) {
  const lines = [];
  for (const [prop, rawValue] of Object.entries(styles || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    if (!options.allowContent && prop === "content") continue;
    let value = String(rawValue);
    if (value === "normal" || value === "none 0s ease 0s") continue;
    if (/^(width|height|min-width|max-width|min-height|max-height)$/i.test(cssPropName(prop)) && value === "auto") continue;
    value = rewriteUrlsWithAssetMap(value, assetMap, baseUrl);
    lines.push(`  ${cssPropName(prop)}: ${value};`);
  }
  return lines;
}

function selectorForCloneId(id) {
  return `:where([data-web-clone-id="${cssEscapeString(id)}"])`;
}

function generateSectionFidelityCss(contract, assetMap = {}, baseUrl = "") {
  const renderObservedCss = (observed) => {
    const blocks = [];
    const addBlock = (selector, styles, options = {}) => {
      if (!selector || selector.includes('""')) return;
      const decls = cssDecls(styles, assetMap, baseUrl, options);
      if (!decls.length) return;
      blocks.push(`${selector} {\n${decls.join("\n")}\n}`);
    };

    for (const item of observed.layout_contract?.important_elements || []) {
      const props = { ...(item.styles || {}) };
      if (!["fixed", "sticky"].includes(props.position)) {
        delete props.top;
        delete props.right;
        delete props.bottom;
        delete props.left;
        delete props.zIndex;
      }
      if (!["img", "video", "canvas", "svg"].includes(item.tag)) {
        delete props.width;
        delete props.height;
        delete props.maxHeight;
        delete props.aspectRatio;
        delete props.objectFit;
        delete props.objectPosition;
      }
      addBlock(selectorForCloneId(item.element_id), props);
    }

    for (const image of observed.image_contract?.images || []) {
      addBlock(selectorForCloneId(image.element_id), {
        ...(image.styles || {}),
        aspectRatio: image.rendered_aspect_ratio ? `${Number(image.rendered_aspect_ratio).toFixed(5)} / 1` : image.styles?.aspectRatio
      });
    }

    for (const background of observed.background_contract?.backgrounds || []) {
      const styles = {
        backgroundColor: background.backgroundColor,
        backgroundImage: background.backgroundImage,
        backgroundSize: background.backgroundSize,
        backgroundPosition: background.backgroundPosition,
        backgroundRepeat: background.backgroundRepeat,
        backgroundAttachment: background.backgroundAttachment
      };
      addBlock(selectorForCloneId(background.element_id), styles);
    }

    for (const pseudo of observed.pseudo_contract?.pseudo_elements || []) {
      const styles = { ...(pseudo.styles || {}) };
      if (styles.content && !/^["'].*["']$/.test(styles.content) && styles.content !== "none") {
        styles.content = JSON.stringify(styles.content);
      }
      addBlock(`${selectorForCloneId(pseudo.element_id)}${pseudo.pseudo}`, styles, { allowContent: true });
    }
    return blocks;
  };

  const blocks = renderObservedCss(contract);
  const viewportEntries = Object.entries(contract.viewport_contracts || {})
    .filter(([, observed]) => observed?.viewport?.width)
    .sort(([, left], [, right]) => Number(right.viewport.width) - Number(left.viewport.width));
  for (const [name, observed] of viewportEntries) {
    if (name === "desktop") continue;
    const viewportBlocks = renderObservedCss(observed);
    if (!viewportBlocks.length) continue;
    blocks.push(`@media (max-width: ${Number(observed.viewport.width)}px) {\n${viewportBlocks.map((block) => indentCssBlock(block)).join("\n\n")}\n}`);
  }

  if (!blocks.length) return `/* No observed fidelity corrections for ${contract.component_name}. */\n`;
  return `/* Generated from browser-observed layout, media, background, and pseudo-element contracts. */\n${blocks.join("\n\n")}\n`;
}

function indentCssBlock(block) {
  return String(block)
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

export function generateFidelityCss(shared, contracts) {
  const documentStyles = [];
  const htmlStyles = pickProps(shared.document_state?.html?.styles || {}, ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "color"]);
  const bodyStyles = pickProps(shared.document_state?.body?.styles || {}, ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight"]);
  const assetMap = shared.asset_mirror?.by_url || {};
  if (Object.keys(htmlStyles).length) documentStyles.push(`html {\n${cssDecls(htmlStyles, assetMap, shared.source_url).join("\n")}\n}`);
  if (Object.keys(bodyStyles).length) documentStyles.push(`body {\n${cssDecls(bodyStyles, assetMap, shared.source_url).join("\n")}\n}`);
  const sectionCss = (contracts || []).map((contract) => contract.fidelity_css || "").filter(Boolean).join("\n");
  return `${documentStyles.join("\n\n")}\n\n${sectionCss}`.trimEnd() + "\n";
}

function escapeJsString(value) {
  return JSON.stringify(String(value));
}

function styleObjectLiteral(style) {
  const entries = [];
  for (const part of String(style || "").split(";")) {
    const [rawKey, ...valueParts] = part.split(":");
    if (!rawKey || !valueParts.length) continue;
    const value = valueParts.join(":").trim();
    if (!value) continue;
    const key = rawKey.trim().replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (/^--/.test(rawKey.trim())) entries.push(`${JSON.stringify(rawKey.trim())}: ${escapeJsString(value)}`);
    else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) entries.push(`${key}: ${escapeJsString(value)}`);
  }
  return `{{ ${entries.join(", ")} }}`;
}

function jsxAttrName(name) {
  const map = {
    class: "className",
    for: "htmlFor",
    srcset: "srcSet",
    tabindex: "tabIndex",
    readonly: "readOnly",
    maxlength: "maxLength",
    minlength: "minLength",
    colspan: "colSpan",
    rowspan: "rowSpan",
    crossorigin: "crossOrigin",
    referrerpolicy: "referrerPolicy",
    autocomplete: "autoComplete",
    autoplay: "autoPlay",
    playsinline: "playsInline",
    "stroke-width": "strokeWidth",
    "stroke-linecap": "strokeLinecap",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-miterlimit": "strokeMiterlimit",
    "fill-opacity": "fillOpacity",
    "stroke-opacity": "strokeOpacity",
    "stop-opacity": "stopOpacity",
    "vector-effect": "vectorEffect",
    "fill-rule": "fillRule",
    "clip-rule": "clipRule",
    "clip-path": "clipPath",
    "viewbox": "viewBox",
    "preserveaspectratio": "preserveAspectRatio",
    "aria-preserveaspectratio": null
  };
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower];
  if (lower.startsWith("on")) return null;
  return name;
}

function jsxText(value) {
  if (!value) return "";
  return `{${escapeJsString(value)}}`;
}

export function htmlToJsx(html, assetMap = {}, baseUrl = "") {
  const $ = cheerio.load(`<web-clone-root>${html || ""}</web-clone-root>`, {
    decodeEntities: false,
    xmlMode: false
  });

  const renderNode = (node) => {
    if (!node) return "";
    if (node.type === "text") return jsxText(node.data || "");
    if (node.type === "comment" || node.type === "directive") return "";
    if (node.type !== "tag") return "";
    const tag = node.tagName?.toLowerCase();
    if (!tag || tag === "web-clone-root") return (node.children || []).map(renderNode).join("");
    if (SKIP_TAGS_FOR_COMPONENTS.has(tag)) return "";
    const attrs = [];
    for (const [rawName, rawValue] of Object.entries(node.attribs || {})) {
      const attrName = jsxAttrName(rawName);
      if (!attrName) continue;
      let value = rawValue ?? "";
      if (["src", "href", "poster", "data-src"].includes(rawName.toLowerCase())) {
        const normalized = normalizeUrlValue(value, baseUrl);
        value = assetMap[normalized] || normalized;
      } else if (["srcset", "data-srcset"].includes(rawName.toLowerCase())) {
        value = normalizeSrcset(value, baseUrl);
        value = rewriteUrlsWithAssetMap(value, assetMap, baseUrl);
      } else {
        value = rewriteUrlsWithAssetMap(value, assetMap, baseUrl);
      }
      if (attrName === "style") attrs.push(`style=${styleObjectLiteral(value)}`);
      else if (value === "" && ["disabled", "checked", "selected", "muted", "loop", "controls"].includes(attrName)) attrs.push(attrName);
      else attrs.push(`${attrName}={${escapeJsString(value)}}`);
    }
    const open = `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
    if (VOID_TAGS.has(tag)) return `${open} />`;
    const children = (node.children || []).map(renderNode).join("");
    return `${open}>${children}</${tag}>`;
  };

  return $("web-clone-root").get(0).children.map(renderNode).join("\n");
}

export function generateRuntimeSource() {
  return `export function initCloneRuntime(motionManifest = {}) {
  injectCloneMotionStyles();
  initManifestMotion(motionManifest);
  initWebflowDropdowns();
  initWebflowNav();
  initGenericToggles();
  if (!motionManifest?.items?.length) initFallbackMotion();
  document.documentElement.dataset.cloneMotionRuntime = 'ready';
}

function byCloneId(id) {
  if (!id || !window.CSS?.escape) return null;
  return document.querySelector(\`[data-web-clone-id="\${CSS.escape(id)}"]\`);
}

function setStyles(element, styles = {}) {
  for (const [key, value] of Object.entries(styles || {})) {
    if (value === undefined || value === null || value === '') continue;
    element.style[key] = String(value);
  }
}

function setClassSnapshot(element, className) {
  if (typeof className !== 'string' || !className.trim()) return;
  const preserved = Array.from(element.classList).filter((name) => name.startsWith('clone-'));
  element.className = className;
  preserved.forEach((name) => element.classList.add(name));
}

function injectCloneMotionStyles() {
  if (document.getElementById('clone-motion-styles')) return;
  const style = document.createElement('style');
  style.id = 'clone-motion-styles';
  style.textContent = \`
    @media (prefers-reduced-motion: no-preference) {
      [data-web-clone-motion] {
        transition-property: opacity, transform, filter, clip-path, color, background-color, border-color, box-shadow;
        transition-duration: var(--clone-motion-duration, 650ms);
        transition-timing-function: cubic-bezier(.16,1,.3,1);
      }
      .clone-motion-hoverable {
        transition-property: color, background-color, border-color, box-shadow, opacity, transform;
        transition-duration: 180ms;
        transition-timing-function: ease;
      }
      .clone-state-open {
        opacity: 1;
        visibility: visible;
      }
    }
  \`;
  document.head.appendChild(style);
}

function initManifestMotion(manifest) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  items.forEach((item, index) => {
    const element = byCloneId(item.element_id);
    if (!element || element.dataset.cloneManifestBound) return;
    element.dataset.cloneManifestBound = 'true';
    element.dataset.webCloneMotion = 'true';
    element.setAttribute('data-web-clone-motion', 'true');

    (item.triggers || []).forEach((trigger) => {
      if (trigger.initial_styles) setStyles(element, trigger.initial_styles);
      if (trigger.initial_class) setClassSnapshot(element, trigger.initial_class);

      if (trigger.type === 'load') {
        window.setTimeout(() => {
          if (trigger.final_class) setClassSnapshot(element, trigger.final_class);
          setStyles(element, trigger.final_styles || {});
          element.dataset.cloneMotionState = 'load-final';
        }, Number(trigger.delay_ms || 120) + Math.min(index * 35, 420));
      } else if (trigger.type === 'scroll') {
        bindScrollTrigger(element, trigger);
      } else if (trigger.type === 'hover') {
        element.classList.add('clone-motion-hoverable');
        element.addEventListener('mouseenter', () => {
          if (trigger.final_class) setClassSnapshot(element, trigger.final_class);
          setStyles(element, trigger.final_styles || {});
          element.dataset.cloneMotionState = 'hover-final';
        });
        element.addEventListener('mouseleave', () => {
          if (trigger.initial_class) setClassSnapshot(element, trigger.initial_class);
          setStyles(element, trigger.initial_styles || {});
          element.dataset.cloneMotionState = 'hover-initial';
        });
      } else if (trigger.type === 'focus') {
        element.addEventListener('focus', () => {
          if (trigger.final_class) setClassSnapshot(element, trigger.final_class);
          setStyles(element, trigger.final_styles || {});
          element.dataset.cloneMotionState = 'focus-final';
        });
        element.addEventListener('blur', () => {
          if (trigger.initial_class) setClassSnapshot(element, trigger.initial_class);
          setStyles(element, trigger.initial_styles || {});
          element.dataset.cloneMotionState = 'focus-initial';
        });
      } else if (trigger.type === 'click') {
        element.addEventListener('click', (event) => {
          if (element.matches('a[href]')) event.preventDefault();
          const open = element.dataset.cloneClickOpen !== 'true';
          element.dataset.cloneClickOpen = String(open);
          if (open) {
            if (trigger.final_class) setClassSnapshot(element, trigger.final_class);
            setStyles(element, trigger.final_styles || {});
            element.dataset.cloneMotionState = 'click-final';
          } else {
            if (trigger.initial_class) setClassSnapshot(element, trigger.initial_class);
            setStyles(element, trigger.initial_styles || {});
            element.dataset.cloneMotionState = 'click-initial';
          }
        });
      }
    });
  });
}

function bindScrollTrigger(element, trigger) {
  const reveal = () => {
    if (trigger.final_class) setClassSnapshot(element, trigger.final_class);
    setStyles(element, trigger.final_styles || {});
    element.dataset.cloneMotionState = 'scroll-final';
  };
  if (!('IntersectionObserver' in window)) {
    reveal();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      reveal();
      observer.unobserve(entry.target);
    });
  }, {
    threshold: Number(trigger.threshold ?? 0.08),
    rootMargin: trigger.root_margin || '0px 0px -12% 0px'
  });
  observer.observe(element);
}

function initWebflowDropdowns() {
  Array.from(document.querySelectorAll('.w-dropdown')).forEach((dropdown) => {
    if (dropdown.dataset.cloneDropdownBound) return;
    const toggle = dropdown.querySelector('.w-dropdown-toggle');
    const list = dropdown.querySelector('.w-dropdown-list');
    if (!toggle || !list) return;
    dropdown.dataset.cloneDropdownBound = 'true';
    const open = () => {
      dropdown.classList.add('w--open');
      toggle.classList.add('w--open');
      list.classList.add('w--open');
      toggle.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      dropdown.classList.remove('w--open');
      toggle.classList.remove('w--open');
      list.classList.remove('w--open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    dropdown.addEventListener('mouseenter', open);
    dropdown.addEventListener('mouseleave', close);
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      if (dropdown.classList.contains('w--open')) close();
      else open();
    });
  });
}

function initWebflowNav() {
  Array.from(document.querySelectorAll('.w-nav-button')).forEach((button) => {
    if (button.dataset.cloneNavBound) return;
    button.dataset.cloneNavBound = 'true';
    button.addEventListener('click', () => {
      const root = button.closest('.w-nav, .nav_component, header, nav') || document;
      const menu = root.querySelector('.w-nav-menu, .nav_menu_wrap, [class*="nav_menu"]');
      const isOpen = button.classList.toggle('w--open');
      if (menu) {
        menu.classList.toggle('w--nav-menu-open', isOpen);
        menu.classList.toggle('w--open', isOpen);
        menu.setAttribute('aria-hidden', String(!isOpen));
      }
      document.documentElement.classList.toggle('clone-nav-open', isOpen);
      button.setAttribute('aria-expanded', String(isOpen));
    });
  });
}

function initGenericToggles() {
  Array.from(document.querySelectorAll('[data-toggle], [aria-controls], .accordion, .tabs, [class*="accordion"], [class*="tab"], [class*="modal"], [class*="carousel"]')).forEach((toggle) => {
    if (toggle.dataset.cloneToggleBound) return;
    toggle.dataset.cloneToggleBound = 'true';
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('clone-state-open');
      const controls = toggle.getAttribute('aria-controls');
      if (controls) document.getElementById(controls)?.classList.toggle('clone-state-open');
    });
  });
}

function initFallbackMotion() {
  Array.from(document.querySelectorAll('.animate-word')).forEach((word, index) => {
    if (word.dataset.cloneFallbackBound) return;
    word.dataset.cloneFallbackBound = 'word';
    word.setAttribute('data-web-clone-motion', 'true');
    word.style.opacity = '0';
    word.style.transform = 'translateY(0.7em)';
    window.setTimeout(() => {
      word.style.opacity = '1';
      word.style.transform = 'translateY(0)';
      word.dataset.cloneMotionState = 'fallback-word-final';
    }, 120 + Math.min(index * 55, 650));
  });

  const candidates = Array.from(document.querySelectorAll('[data-scroll], .article-card, .article-list-item, .btn_main_wrap, [class*="cta"] img'))
    .filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().height > 0);
  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          entry.target.dataset.cloneMotionState = 'fallback-scroll-final';
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
    : null;
  candidates.forEach((element, index) => {
    if (element.dataset.cloneFallbackBound) return;
    element.dataset.cloneFallbackBound = 'reveal';
    element.setAttribute('data-web-clone-motion', 'true');
    element.style.opacity = '0';
    element.style.transform = 'translateY(18px)';
    element.style.transitionDelay = element.style.transitionDelay || \`\${Math.min(index * 35, 260)}ms\`;
    if (observer) observer.observe(element);
    else {
      element.style.opacity = '1';
      element.style.transform = 'translateY(0)';
    }
  });
}
`;
}
