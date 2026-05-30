#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createContractBundle,
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
      raw_html: `<!doctype html><html><head><link rel="shortcut icon" href="https://target.invalid/favicon.png"></head><body>
        <nav class="nav_component"><a href="/">Brand</a><button class="w-nav-button">Menu</button></nav>
        <header class="hero"><h1><span class="animate-word">Hello</span> world</h1><a class="btn_main_wrap" href="/start">Start</a><img src="https://cdn.target.invalid/hero.webp"></header>
        <section class="content" data-scroll="true"><h2>Content</h2><p>Body</p></section>
        <footer class="footer"><a href="/legal">Legal</a></footer>
      </body></html>`,
      css_data: {
        stylesheets: [{ url: "https://target.invalid/style.css", content: ".hero{background:url(https://cdn.target.invalid/hero.webp)}" }],
        inline_styles: []
      },
      assets: { images: [{ url: "https://cdn.target.invalid/hero.webp" }], fonts: [], stylesheets: [], scripts: [], links: [] },
      favicon: { icons: [{ rel: "shortcut icon", href: "https://target.invalid/favicon.png" }] },
      motion_data: { candidates: [{ className: "animate-word" }], markers: { "animate-word": true } },
      asset_mirror: { by_url: { "https://cdn.target.invalid/hero.webp": "/assets/hero.webp", "https://target.invalid/favicon.png": "/assets/favicon.png" }, assets: [] },
      viewport_profiles: { desktop: { width: 1440, height: 1200 } }
    };
    const out = path.join(dir, "contracts");
    const result = await createContractBundle(source, out);
    assert.ok(result.contracts.length >= 3);
    const shared = await readJson(path.join(out, "shared.json"));
    assert.equal(shared.motion_contract.has_motion, true);
    assert.match(shared.original_css, /\/assets\/hero\.webp/);
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
