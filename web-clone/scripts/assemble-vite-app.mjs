#!/usr/bin/env node
import path from "node:path";
import {
  copyDir,
  ensureDir,
  generateRuntimeSource,
  htmlToJsx,
  parseArgs,
  readJson,
  removeDir,
  requiredArg,
  rewriteUrlsWithAssetMap,
  safePackageName,
  writeJson,
  writeText
} from "./core.mjs";

function usage() {
  return "Usage: node scripts/assemble-vite-app.mjs --run-dir DIR --output DIR/app [--project-name cloned-website]";
}

async function assembleViteApp(runDir, outputDir, projectName) {
  const contractsDir = path.join(runDir, "contracts");
  const integration = await readJson(path.join(contractsDir, "integration_plan.json"));
  const shared = await readJson(path.join(contractsDir, "shared.json"));
  const assetMap = shared.asset_mirror?.by_url || {};

  await removeDir(outputDir);
  await ensureDir(outputDir);
  await copyDir(path.join(runDir, "public"), path.join(outputDir, "public"));

  const imports = [];
  const renders = [];
  for (const component of integration.components) {
    const contract = await readJson(path.join(contractsDir, "contracts", `${component.namespace}.json`));
    const componentName = contract.component_name;
    const componentDir = path.join(outputDir, "src", "components", "sections", contract.namespace);
    await ensureDir(componentDir);
    const jsx = htmlToJsx(contract.source.raw_html, assetMap, integration.source_url);
    const cssFile = `${contract.namespace}.css`;
    await writeText(
      path.join(componentDir, `${componentName}.jsx`),
      `import "./${cssFile}";\n\nexport default function ${componentName}() {\n  return (\n    <>\n${indent(jsx, 6)}\n    </>\n  );\n}\n`
    );
    await writeText(path.join(componentDir, cssFile), `/* Section-specific refinements for ${componentName}. Keep source classes intact. */\n`);
    imports.push(`import ${componentName} from "${component.import_path}";`);
    renders.push(`      <${componentName} />`);
  }

  await writeText(
    path.join(outputDir, "src", "App.jsx"),
    `${imports.join("\n")}\n\nexport default function App() {\n  return (\n    <main className="clone-page" data-source-url={${JSON.stringify(integration.source_url)}}>\n${renders.join("\n")}\n    </main>\n  );\n}\n`
  );
  await writeText(
    path.join(outputDir, "src", "main.jsx"),
    `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./index.css";\nimport "./styles/original.css";\nimport { initCloneRuntime } from "./runtime/cloneRuntime.js";\n\ncreateRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n\nrequestAnimationFrame(() => {\n  initCloneRuntime();\n  window.setTimeout(initCloneRuntime, 250);\n});\n`
  );
  await writeText(path.join(outputDir, "src", "runtime", "cloneRuntime.js"), generateRuntimeSource());
  await writeText(
    path.join(outputDir, "src", "index.css"),
    `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  color-scheme: light;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nhtml,\nbody,\n#root {\n  margin: 0;\n  min-height: 100%;\n}\n\nbody {\n  overflow-x: clip;\n}\n\nimg,\nsvg,\nvideo,\ncanvas {\n  max-width: 100%;\n}\n\n.clone-page {\n  min-height: 100vh;\n}\n`
  );
  await writeText(
    path.join(outputDir, "src", "styles", "original.css"),
    `${shared.original_css || ""}\n/* web-clone fidelity defaults */\n.clone-page h1 a {\n  text-decoration-line: underline;\n  text-decoration-thickness: 0.08em;\n  text-underline-offset: 0.1em;\n}\n`
  );

  const faviconHead = buildFaviconHead(shared, assetMap, integration.source_url);
  await writeText(
    path.join(outputDir, "index.html"),
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${escapeHtml(shared.title || "Cloned Website")}</title>\n${faviconHead}\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`
  );
  await writeJson(path.join(outputDir, "package.json"), {
    name: safePackageName(projectName),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview"
    },
    dependencies: {
      "@vitejs/plugin-react": "^5.1.2",
      vite: "^7.3.3",
      typescript: "^5.9.3",
      react: "^19.2.3",
      "react-dom": "^19.2.3",
      tailwindcss: "^3.4.19",
      postcss: "^8.5.6",
      autoprefixer: "^10.4.22"
    },
    devDependencies: {}
  });
  await writeText(path.join(outputDir, "vite.config.js"), `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`);
  await writeText(path.join(outputDir, "postcss.config.js"), `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`);
  await writeText(path.join(outputDir, "tailwind.config.js"), `export default {\n  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],\n  theme: {\n    extend: {},\n  },\n  plugins: [],\n};\n`);
  await writeText(path.join(outputDir, ".gitignore"), "node_modules\ndist\n.env*\n*.log\n");
  return { sections: integration.components.length };
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return String(value || "")
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function buildFaviconHead(shared, assetMap, baseUrl) {
  const lines = [];
  for (const icon of shared.favicon?.icons || []) {
    const href = rewriteUrlsWithAssetMap(icon.href || "", assetMap, baseUrl);
    if (!href) continue;
    const attrs = [
      `rel="${escapeHtml(icon.rel || "icon")}"`,
      `href="${escapeHtml(href)}"`,
      icon.type ? `type="${escapeHtml(icon.type)}"` : "",
      icon.sizes ? `sizes="${escapeHtml(icon.sizes)}"` : "",
      icon.color ? `color="${escapeHtml(icon.color)}"` : ""
    ].filter(Boolean);
    lines.push(`    <link ${attrs.join(" ")} />`);
  }
  if (shared.favicon?.theme_color) lines.push(`    <meta name="theme-color" content="${escapeHtml(shared.favicon.theme_color)}" />`);
  if (shared.favicon?.application_name) lines.push(`    <meta name="application-name" content="${escapeHtml(shared.favicon.application_name)}" />`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["run-dir"] || !args.output) {
    console.error(usage());
    process.exit(2);
  }
  const runDir = path.resolve(requiredArg(args, "run-dir"));
  const outputDir = path.resolve(requiredArg(args, "output"));
  const projectName = String(args["project-name"] || "cloned-website");
  const result = await assembleViteApp(runDir, outputDir, projectName);
  console.log(`Assembled ${result.sections} sections at ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
