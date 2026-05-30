#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createContractBundle,
  generateFidelityCss,
  htmlToJsx,
  normalizeHtmlUrls,
  parseViewports,
  readJson,
  rewriteUrlsWithAssetMap
} from "./core.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-clone-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testUrlAndViewportParsing() {
  assert.deepEqual(parseViewports("desktop=1440x1200,mobile=390x844"), {
    desktop: [1440, 1200],
    mobile: [390, 844]
  });
  const html = normalizeHtmlUrls('<img src="/hero.png" srcset="/a.png 500w, https://x.test/b.png 900w"><a href="/about">About</a>', "https://target.invalid/base/");
  assert.match(html, /https:\/\/target\.invalid\/hero\.png/);
  assert.match(html, /https:\/\/target\.invalid\/a\.png 500w/);
  assert.match(html, /https:\/\/target\.invalid\/about/);
}

async function testContractAndJsxGeneration() {
  await withTempDir(async (dir) => {
    const source = {
      url: "https://target.invalid/",
      metadata: { title: "Example" },
      raw_html: `<!doctype html><html data-web-clone-id="wc-html"><head><link rel="shortcut icon" href="https://target.invalid/favicon.png"></head><body data-web-clone-id="wc-body">
        <nav class="nav_component" data-web-clone-id="wc-nav"><a data-web-clone-id="wc-nav-a" href="/">Brand</a><button class="w-nav-button" data-web-clone-id="wc-nav-button">Menu</button></nav>
        <header class="hero" data-web-clone-id="wc-hero"><h1 data-web-clone-id="wc-h1"><span class="animate-word" data-web-clone-id="wc-word">Hello</span> world</h1><a class="btn_main_wrap" data-web-clone-id="wc-cta" href="/start">Start</a><img data-web-clone-id="wc-img" src="https://cdn.target.invalid/hero.webp"></header>
        <section class="content" data-scroll="true" data-web-clone-id="wc-content"><h2>Content</h2><p>Body</p></section>
        <footer class="footer" data-web-clone-id="wc-footer"><a href="/legal">Legal</a></footer>
      </body></html>`,
      dom_tree: {
        element_id: "wc-body",
        tag: "body",
        children: [
          { element_id: "wc-nav", tag: "nav", className: "nav_component", rect: { width: 1440, height: 80 }, styles: { display: "flex", backgroundColor: "rgb(255, 255, 255)" }, children: [] },
          {
            element_id: "wc-hero",
            tag: "header",
            className: "hero",
            rect: { width: 1440, height: 640 },
            styles: { display: "grid", backgroundColor: "rgb(250, 246, 238)", padding: "80px" },
            children: [
              { element_id: "wc-h1", tag: "h1", rect: { width: 600, height: 120 }, styles: { fontSize: "72px", lineHeight: "78px" }, children: [] },
              { element_id: "wc-img", tag: "img", rect: { width: 560, height: 420 }, styles: { objectFit: "cover", objectPosition: "50% 50%" }, children: [] }
            ]
          },
          { element_id: "wc-content", tag: "section", className: "content", rect: { width: 1440, height: 400 }, styles: { backgroundColor: "rgb(255, 255, 255)" }, children: [] },
          { element_id: "wc-footer", tag: "footer", className: "footer", rect: { width: 1440, height: 300 }, styles: { display: "grid", backgroundColor: "rgb(24, 24, 24)", color: "rgb(255, 255, 255)" }, children: [] }
        ]
      },
      document_state: {
        html: { attrs: { lang: "en", "data-web-clone-id": "wc-html" }, lang: "en", className: "", styles: { backgroundColor: "rgb(250, 246, 238)" } },
        body: { attrs: { "data-web-clone-id": "wc-body" }, className: "", styles: { backgroundColor: "rgb(250, 246, 238)", fontFamily: "Arial" } }
      },
      css_data: {
        stylesheets: [{ url: "https://target.invalid/style.css", content: ".hero{background:url(https://cdn.target.invalid/hero.webp)}" }],
        inline_styles: []
      },
      assets: { images: [{ url: "https://cdn.target.invalid/hero.webp" }], fonts: [], stylesheets: [], scripts: [], links: [] },
      favicon: { icons: [{ rel: "shortcut icon", href: "https://target.invalid/favicon.png" }] },
      image_metrics: [
        {
          element_id: "wc-img",
          currentSrc: "https://cdn.target.invalid/hero.webp",
          rendered_rect: { width: 560, height: 420 },
          rendered_aspect_ratio: 1.33333,
          styles: { objectFit: "cover", objectPosition: "50% 50%", width: "560px", height: "420px" }
        }
      ],
      background_metrics: [{ element_id: "wc-hero", backgroundImage: "url(https://cdn.target.invalid/hero.webp)", backgroundColor: "rgb(250, 246, 238)", backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat", urls: ["https://cdn.target.invalid/hero.webp"], rect: { width: 1440, height: 640 } }],
      pseudo_elements: [{ element_id: "wc-cta", pseudo: "::after", styles: { content: "\"after\"", display: "inline-block" } }],
      motion_data: {
        candidates: [{ element_id: "wc-word", className: "animate-word", attrs: {}, styles: { opacity: "0", transform: "translateY(12px)" } }],
        markers: { "animate-word": true },
        load_samples: [
          { samples: [{ element_id: "wc-word", className: "animate-word", opacity: "0", transform: "translateY(12px)" }] },
          { samples: [{ element_id: "wc-word", className: "animate-word", opacity: "1", transform: "none" }] }
        ]
      },
      asset_mirror: { by_url: { "https://cdn.target.invalid/hero.webp": "/assets/hero.webp", "https://target.invalid/favicon.png": "/assets/favicon.png" }, assets: [] },
      viewport_profiles: { desktop: { width: 1440, height: 1200 } }
    };
    const out = path.join(dir, "contracts");
    const result = await createContractBundle(source, out);
    assert.ok(result.contracts.length >= 3);
    const shared = await readJson(path.join(out, "shared.json"));
    assert.equal(shared.motion_contract.has_motion, true);
    assert.ok(shared.motion_manifest.items.length > 0);
    assert.match(shared.original_css, /\/assets\/hero\.webp/);
    assert.match(generateFidelityCss(shared, result.contracts), /data-web-clone-id="wc-hero"/);
    assert.ok(result.contracts.some((contract) => contract.layout_contract?.important_elements?.length));
    assert.ok(result.contracts.some((contract) => contract.image_contract?.images?.length));
    assert.ok(result.contracts.some((contract) => contract.background_contract?.backgrounds?.length));
    assert.ok(result.contracts.some((contract) => contract.pseudo_contract?.pseudo_elements?.length));
    const jsx = htmlToJsx('<img class="hero-img" src="https://cdn.target.invalid/hero.webp" style="opacity: 1; background-color: red">', source.asset_mirror.by_url, source.url);
    assert.match(jsx, /className=\{"hero-img"\}/);
    assert.match(jsx, /src=\{"\/assets\/hero\.webp"\}/);
    assert.match(jsx, /style=\{\{ opacity: "1", backgroundColor: "red" \}\}/);
    assert.equal(rewriteUrlsWithAssetMap("url(https://cdn.target.invalid/hero.webp)", source.asset_mirror.by_url), "url(/assets/hero.webp)");
  });
}

async function main() {
  const tests = [testUrlAndViewportParsing, testContractAndJsxGeneration];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
