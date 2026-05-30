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

function createMotionContract(source) {
  const motion = source.motion_data || {};
  const css = source.css_data || {};
  const markers = motion.markers || {};
  return {
    has_motion: Boolean((motion.candidates || []).length || (css.animations || []).length || Object.values(markers).some(Boolean)),
    markers: Object.entries(markers).filter(([, value]) => Boolean(value)).map(([key]) => key),
    candidates: (motion.candidates || []).slice(0, 80),
    load_samples: motion.load_samples || [],
    scroll_samples: motion.scroll_samples || [],
    keyframes: css.keyframes || [],
    transitions: css.transitions || [],
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
    return {
      id: namespace,
      order: index,
      type: item.type,
      namespace,
      component_name: pascalCase(namespace, "Section"),
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

export async function createContractBundle(source, outDir, maxTokens = 10_000) {
  await removeDir(outDir);
  await ensureDir(path.join(outDir, "contracts"));
  await ensureDir(path.join(outDir, "prompts"));
  const sections = analyzeSections(source);
  const assetMap = assetMapFromSource(source);
  const favicon = source.favicon || extractFaviconFromHtml(source.raw_html || "", source.url);
  const shared = {
    source_url: source.url,
    title: source.metadata?.title || "",
    original_css: buildOriginalCss(source),
    assets: source.assets || {},
    asset_mirror: source.asset_mirror || {},
    favicon,
    viewport_profiles: source.viewport_profiles || {},
    motion_contract: createMotionContract(source)
  };
  await writeJson(path.join(outDir, "shared.json"), shared);

  const contracts = [];
  for (const section of sections) {
    const componentName = section.component_name;
    const contract = {
      id: section.id,
      order: section.order,
      type: section.type,
      namespace: section.namespace,
      component_name: componentName,
      source: {
        raw_html: rewriteUrlsWithAssetMap(normalizeHtmlUrls(section.outer_html, source.url), assetMap, source.url),
        text: section.text,
        images: section.images,
        links: section.links,
        motion_contract: shared.motion_contract
      },
      constraints: {
        max_tokens: maxTokens,
        preserve_wrapper: true,
        no_dangerously_set_inner_html: true,
        local_assets_default: true
      },
      acceptance_criteria: [
        "Preserve the source root wrapper, class names, asset URLs, links, and text.",
        "Render explicit JSX with no dangerouslySetInnerHTML.",
        "Keep header/nav/footer wrappers intact.",
        "Preserve motion markers and interaction state where visible."
      ],
      deliverables: [
        {
          path: `src/components/sections/${section.namespace}/${componentName}.jsx`,
          export: componentName
        },
        {
          path: `src/components/sections/${section.namespace}/${section.namespace}.css`
        }
      ]
    };
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
  return `export function initCloneRuntime() {
  injectCloneMotionStyles();
  initWordStagger();
  initScrollReveal();
  initGenericInteractions();

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

  document.documentElement.dataset.cloneMotionRuntime = 'ready';
}

function injectCloneMotionStyles() {
  if (document.getElementById('clone-motion-styles')) return;
  const style = document.createElement('style');
  style.id = 'clone-motion-styles';
  style.textContent = \`
    @media (prefers-reduced-motion: no-preference) {
      .clone-motion-word {
        opacity: 0;
        transform: translateY(0.7em);
        transition: opacity 520ms cubic-bezier(.16,1,.3,1), transform 520ms cubic-bezier(.16,1,.3,1);
      }
      .clone-motion-word.clone-motion-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .clone-motion-reveal {
        opacity: 0;
        transform: translateY(18px);
        transition: opacity 650ms cubic-bezier(.16,1,.3,1), transform 650ms cubic-bezier(.16,1,.3,1);
      }
      .clone-motion-reveal.clone-motion-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .clone-motion-hoverable {
        transition-property: color, background-color, border-color, box-shadow, opacity, transform;
        transition-duration: 180ms;
        transition-timing-function: ease;
      }
      .clone-motion-hoverable:hover {
        transform: translateY(-1px);
      }
    }
  \`;
  document.head.appendChild(style);
}

function initWordStagger() {
  Array.from(document.querySelectorAll('.animate-word')).forEach((word, index) => {
    if (word.dataset.cloneMotionBound) return;
    word.dataset.cloneMotionBound = 'word';
    word.classList.add('clone-motion-word');
    word.style.opacity = '0';
    word.style.transform = 'translateY(0.7em)';
    window.setTimeout(() => {
      word.classList.add('clone-motion-visible');
      word.style.opacity = '';
      word.style.transform = '';
    }, 120 + Math.min(index * 55, 650));
  });
}

function initScrollReveal() {
  const selector = ['[data-scroll]', '.article-card', '.article-list-item', '.btn_main_wrap', '[class*="cta"] img'].join(',');
  const candidates = Array.from(document.querySelectorAll(selector))
    .filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().height > 0);
  if (!candidates.length) return;
  const reveal = (element) => {
    element.classList.add('clone-motion-visible');
    element.dataset.cloneMotionVisible = 'true';
  };
  if (!('IntersectionObserver' in window)) {
    candidates.forEach(reveal);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      reveal(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  candidates.forEach((element, index) => {
    if (element.dataset.cloneMotionBound) return;
    element.dataset.cloneMotionBound = 'reveal';
    element.classList.add('clone-motion-reveal');
    element.style.transitionDelay = element.style.transitionDelay || \`\${Math.min(index * 35, 260)}ms\`;
    observer.observe(element);
  });
}

function initGenericInteractions() {
  Array.from(document.querySelectorAll('a, button, [role="button"], .btn_main_wrap, .button, [class*="button"], [class*="btn"]')).forEach((element) => {
    element.classList.add('clone-motion-hoverable');
  });
  Array.from(document.querySelectorAll('[data-toggle], [aria-controls], .accordion, .tabs, [class*="accordion"], [class*="tab"]')).forEach((toggle) => {
    if (toggle.dataset.cloneToggleBound) return;
    toggle.dataset.cloneToggleBound = 'true';
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('clone-state-open');
      const controls = toggle.getAttribute('aria-controls');
      if (controls) document.getElementById(controls)?.classList.toggle('clone-state-open');
    });
  });
}
`;
}
