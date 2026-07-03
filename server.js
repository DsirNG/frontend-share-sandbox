import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3020);

const storageRoot = path.join(__dirname, "storage");
const uploadsDir = path.join(storageRoot, "uploads");
const projectsDir = path.join(storageRoot, "projects");
const previewsDir = path.join(storageRoot, "previews");
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 250);
const ignoredArchiveDirs = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: maxUploadMb * 1024 * 1024
  }
});

const projects = new Map();

app.use(express.json());
app.use(servePreviewHost);
app.use("/", express.static(path.join(__dirname, "public")));

app.get("/api/projects", (_req, res) => {
  res.json({
    projects: [...projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  });
});

app.get("/api/projects/:id", (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ project });
});

app.post("/api/projects/upload", uploadProject, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Please upload a zip file." });
    return;
  }

  const projectId = createProjectId();
  const originalName = req.file.originalname || "project.zip";
  const projectDir = path.join(projectsDir, projectId);
  const previewDir = path.join(previewsDir, projectId);
  const uploadPath = req.file.path;

  const record = {
    id: projectId,
    name: originalName.replace(/\.zip$/i, ""),
    status: "queued",
    createdAt: new Date().toISOString(),
    previewUrl: null,
    scripts: {},
    dependencies: {},
    framework: "unknown",
    rootFiles: [],
    logs: []
  };

  projects.set(projectId, record);
  res.status(202).json({ project: record });

  buildUploadedProject({ projectId, uploadPath, projectDir, previewDir }).catch((error) => {
    record.status = "failed";
    record.logs.push(`Fatal error: ${error.message}`);
  });
});

app.post("/api/components/vue/upload", uploadVueComponent, async (req, res) => {
  const componentFile = req.files?.component?.[0];
  const demoFile = req.files?.demo?.[0];

  if (!componentFile) {
    res.status(400).json({ error: "Please upload a .vue component file." });
    return;
  }

  const projectId = createProjectId();
  const componentName = toPascalCase(path.basename(componentFile.originalname, ".vue")) || "SharedComponent";
  const projectDir = path.join(projectsDir, projectId);
  const previewDir = path.join(previewsDir, projectId);

  const record = {
    id: projectId,
    name: componentName,
    status: "queued",
    createdAt: new Date().toISOString(),
    previewUrl: null,
    scripts: {},
    dependencies: {},
    framework: "Vue Component",
    rootFiles: [],
    logs: []
  };

  projects.set(projectId, record);
  res.status(202).json({ project: record });

  buildVueComponentSandbox({
    projectId,
    componentName,
    componentPath: componentFile.path,
    demoPath: demoFile?.path,
    externalCss: req.body.externalCss,
    projectDir,
    previewDir
  }).catch((error) => {
    record.status = "failed";
    record.logs.push(`Fatal error: ${error.message}`);
  });
});

function uploadProject(req, res, next) {
  upload.single("project")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `Zip is too large. Current limit is ${maxUploadMb} MB.` });
      return;
    }

    next(error);
  });
}

function uploadVueComponent(req, res, next) {
  upload.fields([
    { name: "component", maxCount: 1 },
    { name: "demo", maxCount: 1 }
  ])(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `File is too large. Current limit is ${maxUploadMb} MB.` });
      return;
    }

    next(error);
  });
}

app.use("/preview/:projectId", async (req, res, next) => {
  const project = findProject(req.params.projectId);
  const storedProjectId = project?.id || await findStoredPreviewId(req.params.projectId);
  if ((project && project.status !== "ready") || !storedProjectId) {
    res.status(404).send("Preview is not ready.");
    return;
  }

  const staticRoot = path.join(previewsDir, storedProjectId);
  express.static(staticRoot, {
    fallthrough: true,
    maxAge: "5m"
  })(req, res, () => {
    res.sendFile(path.join(staticRoot, "index.html"));
  });
});

app.listen(port, async () => {
  await ensureStorage();
  console.log(`Frontend share sandbox is running at http://localhost:${port}`);
});

async function buildUploadedProject({ projectId, uploadPath, projectDir, previewDir }) {
  const record = projects.get(projectId);
  record.status = "extracting";

  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(previewDir, { recursive: true, force: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  await extractZipSafely(uploadPath, projectDir, record);
  await fs.rm(uploadPath, { force: true });

  const sourceDir = await findProjectRoot(projectDir);
  record.rootFiles = await listRootFiles(sourceDir);

  const packageJsonPath = path.join(sourceDir, "package.json");
  const hasPackageJson = await pathExists(packageJsonPath);

  if (!hasPackageJson) {
    record.status = "publishing";
    record.framework = "static";
    await copyStaticProject(sourceDir, previewDir);
    record.previewUrl = getPreviewUrl(projectId);
    record.status = "ready";
    record.logs.push("No package.json found. Published files as a static site.");
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  record.name = packageJson.name || record.name;
  record.scripts = packageJson.scripts || {};
  record.dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  record.framework = detectFramework(packageJson);

  if (!record.scripts.build) {
    record.status = "failed";
    record.logs.push("package.json does not contain a build script.");
    return;
  }

  record.status = "installing";
  await runCommand(getNpmCommand(), ["install"], sourceDir, record);

  record.status = "building";
  await runCommand(getNpmCommand(), getBuildArgs(record, projectId), sourceDir, record);

  const distDir = await findBuildOutput(sourceDir);
  if (!distDir) {
    record.status = "failed";
    record.logs.push("Build finished, but no dist/build/public output folder was found.");
    return;
  }

  record.status = "publishing";
  await copyDirectory(distDir, previewDir);
  await ensureSpaFallback(previewDir);

  record.previewUrl = getPreviewUrl(projectId);
  record.status = "ready";
  record.logs.push(`Published preview from ${path.relative(sourceDir, distDir) || "."}.`);
}

async function buildVueComponentSandbox({ projectId, componentName, componentPath, demoPath, externalCss, projectDir, previewDir }) {
  const record = projects.get(projectId);
  record.status = "preparing";
  const componentSource = await fs.readFile(componentPath, "utf8");
  const demoSource = demoPath ? await fs.readFile(demoPath, "utf8") : "";
  const sandboxOptions = analyzeVueSandbox(componentSource, demoSource, externalCss);

  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(previewDir, { recursive: true, force: true });
  await fs.mkdir(path.join(projectDir, "src", "components"), { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  await fs.copyFile(componentPath, path.join(projectDir, "src", "components", "SharedComponent.vue"));
  await fs.rm(componentPath, { force: true });

  if (demoPath) {
    await fs.copyFile(demoPath, path.join(projectDir, "src", "App.vue"));
    await fs.rm(demoPath, { force: true });
    record.logs.push("Using uploaded App.vue as the component demo.");
  } else {
    await fs.writeFile(path.join(projectDir, "src", "App.vue"), createDefaultVueDemo(componentName, componentSource), "utf8");
    record.logs.push("Generated a default Vue demo wrapper.");
  }

  if (sandboxOptions.detectedDependencies.length) {
    record.logs.push(`Detected component dependencies: ${sandboxOptions.detectedDependencies.join(", ")}`);
  }

  if (sandboxOptions.externalCss.length) {
    record.logs.push(`Injected external CSS: ${sandboxOptions.externalCss.join(", ")}`);
  }

  await fs.writeFile(path.join(projectDir, "package.json"), createVuePackageJson(componentName, sandboxOptions.dependencies), "utf8");
  await fs.writeFile(path.join(projectDir, "index.html"), createVueIndexHtml(componentName, sandboxOptions), "utf8");
  await fs.writeFile(path.join(projectDir, "src", "main.ts"), createVueMainTs(sandboxOptions), "utf8");
  await fs.writeFile(path.join(projectDir, "src", "style.css"), createVuePreviewCss(), "utf8");
  await fs.writeFile(path.join(projectDir, "vite.config.ts"), createVueViteConfig(), "utf8");
  await fs.writeFile(path.join(projectDir, "tsconfig.json"), createVueTsConfig(), "utf8");

  record.rootFiles = await listRootFiles(projectDir);
  record.scripts = { build: "vite build" };
  record.dependencies = {
    ...sandboxOptions.dependencies
  };

  record.status = "installing";
  await runCommand(getNpmCommand(), ["install"], projectDir, record);

  record.status = "building";
  await runCommand(getNpmCommand(), ["run", "build", "--", "--base", "/"], projectDir, record);

  const distDir = await findBuildOutput(projectDir);
  if (!distDir) {
    record.status = "failed";
    record.logs.push("Build finished, but no dist output folder was found.");
    return;
  }

  record.status = "publishing";
  await copyDirectory(distDir, previewDir);
  await ensureSpaFallback(previewDir);

  record.previewUrl = getPreviewUrl(projectId);
  record.status = "ready";
  record.logs.push("Published Vue component sandbox from dist.");
}

async function servePreviewHost(req, res, next) {
  const host = req.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9_-]+)\.localhost$/);
  if (!match) {
    next();
    return;
  }

  const project = findProject(match[1]);
  const storedProjectId = project?.id || await findStoredPreviewId(match[1]);
  if ((project && project.status !== "ready") || !storedProjectId) {
    res.status(404).send("Preview is not ready.");
    return;
  }

  const staticRoot = path.join(previewsDir, storedProjectId);
  express.static(staticRoot, {
    fallthrough: true,
    maxAge: "5m"
  })(req, res, () => {
    res.sendFile(path.join(staticRoot, "index.html"));
  });
}

function findProject(id) {
  return projects.get(id) || [...projects.values()].find((project) => project.id.toLowerCase() === id.toLowerCase());
}

function createProjectId() {
  let suffix = "";
  while (suffix.length < 10) {
    suffix += nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  return `p${suffix.slice(0, 10)}`;
}

async function findStoredPreviewId(id) {
  const directPath = path.join(previewsDir, id);
  if (await pathExists(directPath)) {
    return id;
  }

  const entries = await fs.readdir(previewsDir, { withFileTypes: true }).catch(() => []);
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === id.toLowerCase());
  return match?.name || null;
}

async function ensureStorage() {
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(previewsDir, { recursive: true });
}

async function extractZipSafely(zipPath, destination, record) {
  const directory = await unzipper.Open.file(zipPath);
  const skippedDirs = new Set();

  for (const entry of directory.files) {
    const normalizedPath = path.normalize(entry.path).replace(/^(\.\.(\/|\\|$))+/, "");
    const segments = normalizedPath.split(/[\\/]+/);
    const ignoredSegment = segments.find((segment) => ignoredArchiveDirs.has(segment));
    if (ignoredSegment) {
      skippedDirs.add(ignoredSegment);
      continue;
    }

    const outputPath = path.join(destination, normalizedPath);
    const relative = path.relative(destination, outputPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      record.logs.push(`Skipped suspicious zip entry: ${entry.path}`);
      continue;
    }

    if (entry.type === "Directory") {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(createWriteStream(outputPath))
        .on("finish", resolve)
        .on("error", reject);
    });
  }

  if (skippedDirs.size) {
    record.logs.push(`Skipped archive directories: ${[...skippedDirs].sort().join(", ")}`);
  }
}

async function findProjectRoot(projectDir) {
  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const usefulEntries = entries.filter((entry) => !entry.name.startsWith("__MACOSX"));

  if (await pathExists(path.join(projectDir, "package.json")) || usefulEntries.length !== 1 || !usefulEntries[0].isDirectory()) {
    return projectDir;
  }

  const nested = path.join(projectDir, usefulEntries[0].name);
  if (await pathExists(path.join(nested, "package.json")) || await pathExists(path.join(nested, "index.html"))) {
    return nested;
  }

  return projectDir;
}

async function listRootFiles(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => !ignoredArchiveDirs.has(entry.name))
    .slice(0, 80)
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file"
    }));
}

function detectFramework(packageJson) {
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };

  if (deps.next) return "Next.js";
  if (deps["@vitejs/plugin-vue"] || deps.vue) return "Vue";
  if (deps["@vitejs/plugin-react"] || deps.react) return "React";
  if (deps.svelte) return "Svelte";
  if (deps.astro) return "Astro";
  if (deps.vite) return "Vite";
  return "JavaScript";
}

async function runCommand(command, args, cwd, record) {
  record.logs.push(`$ ${command} ${args.join(" ")}`);
  const spawnSpec = getSpawnSpec(command, args);

  await new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        CI: "true",
        npm_config_fund: "false",
        npm_config_audit: "false"
      }
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Command timed out after 180 seconds."));
    }, 180_000);

    child.stdout.on("data", (chunk) => pushLog(record, chunk));
    child.stderr.on("data", (chunk) => pushLog(record, chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code}.`));
    });
  });
}

function pushLog(record, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) record.logs.push(line);
  }
  record.logs = record.logs.slice(-600);
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getSpawnSpec(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args]
  };
}

function getBuildArgs(record, projectId) {
  if (record.dependencies?.vite) {
    return ["run", "build", "--", "--base", "/"];
  }

  return ["run", "build"];
}

function getPreviewUrl(projectId) {
  return `http://${projectId.toLowerCase()}.localhost:${port}/`;
}

function toPascalCase(value) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function analyzeVueSandbox(componentSource, demoSource, externalCssInput = "") {
  const source = `${componentSource}\n${demoSource}`;
  const dependencies = {
    "@vitejs/plugin-vue": "^5.2.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.8",
    "vue": "^3.5.13"
  };
  const knownDependencyVersions = {
    "@vueuse/core": "^12.0.0",
    "gsap": "^3.12.5",
    "lucide-vue-next": "^0.468.0",
    "pinia": "^2.3.0",
    "vue-router": "^4.5.0"
  };

  for (const dependency of extractBareImports(source)) {
    if (knownDependencyVersions[dependency]) {
      dependencies[dependency] = knownDependencyVersions[dependency];
    }
  }

  const externalCss = normalizeExternalCss(externalCssInput);
  const autoCss = [];
  if (usesFontAwesome(source)) {
    autoCss.push("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css");
  }

  for (const href of autoCss) {
    if (!externalCss.includes(href)) {
      externalCss.unshift(href);
    }
  }

  return {
    dependencies,
    detectedDependencies: Object.keys(dependencies).filter((dependency) => !["@vitejs/plugin-vue", "typescript", "vite", "vue"].includes(dependency)),
    needsRouter: Boolean(dependencies["vue-router"]),
    externalCss
  };
}

function normalizeExternalCss(input) {
  return String(input || "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol);
      } catch {
        return false;
      }
    })
    .slice(0, 8);
}

function usesFontAwesome(source) {
  return /\b(?:fa|fas|far|fab|fal|fad|fa-solid|fa-regular|fa-brands)\b/.test(source);
}

function extractBareImports(source) {
  const imports = new Set();
  const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;

  while ((match = importPattern.exec(source))) {
    const specifier = match[1] || match[2];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/")) continue;

    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    imports.add(packageName);
  }

  return imports;
}

function createVuePackageJson(componentName, dependencies) {
  return `${JSON.stringify({
    name: `${componentName.replace(/[A-Z]/g, (letter, index) => `${index ? "-" : ""}${letter.toLowerCase()}`)}-sandbox`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "vite build"
    },
    dependencies
  }, null, 2)}\n`;
}

function createVueIndexHtml(componentName, options) {
  const cssLinks = options.externalCss
    .map((href) => `    <link rel="stylesheet" href="${escapeHtml(href)}" />`)
    .join("\n");
  const maybeCssLinks = cssLinks ? `${cssLinks}\n` : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(componentName)} Sandbox</title>
${maybeCssLinks}  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function createVueMainTs(options) {
  if (options.needsRouter) {
    return `import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import SharedComponent from './components/SharedComponent.vue'
import './style.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: { template: '<span />' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

createApp(App)
  .component('SharedComponent', SharedComponent)
  .use(router)
  .mount('#app')
`;
  }

  return `import { createApp } from 'vue'
import App from './App.vue'
import SharedComponent from './components/SharedComponent.vue'
import './style.css'

createApp(App)
  .component('SharedComponent', SharedComponent)
  .mount('#app')
`;
}

function createDefaultVueDemo(componentName, componentSource) {
  const componentProps = createDefaultVueComponentProps(componentSource);
  const componentAttrs = componentProps.length
    ? `\n          ${componentProps.join("\n          ")}\n        `
    : " ";

  return `<script setup lang="ts">
import SharedComponent from './components/SharedComponent.vue'
</script>

<template>
  <main class="preview-page">
    <section class="preview-surface">
      <p class="preview-kicker">Vue Component Sandbox</p>
      <h1>${escapeHtml(componentName)}</h1>
      <div class="component-stage">
        <SharedComponent${componentAttrs}/>
      </div>
    </section>
  </main>
</template>

<style scoped>
.preview-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 48px;
  color: #111827;
  background: #f5f7fb;
}

.preview-surface {
  width: min(720px, calc(100vw - 32px));
  padding: 32px;
  border: 1px solid #dce3ec;
  border-radius: 8px;
  background: #ffffff;
}

.preview-kicker {
  margin: 0 0 8px;
  color: #0f766e;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 28px;
  font-size: 28px;
}

.component-stage {
  min-height: 180px;
  display: grid;
  place-items: center;
  padding: 32px;
  border: 1px dashed #b8c3d1;
  border-radius: 8px;
  background: #fbfcfe;
}
</style>
`;
}

function createDefaultVueComponentProps(componentSource) {
  const props = [];

  if (hasRequiredProp(componentSource, "title")) {
    props.push('title="Preview Action"');
  } else if (hasRequiredProp(componentSource, "label")) {
    props.push('label="Preview Action"');
  } else if (hasProp(componentSource, "text")) {
    props.push('text="Preview Action"');
  }

  if (hasProp(componentSource, "desc")) {
    props.push('desc="Generated by the component sandbox"');
  }

  if (hasProp(componentSource, "to") && /['"]vue-router['"]/.test(componentSource)) {
    props.push(':to="{ path: \'/\' }"');
  }

  if (hasProp(componentSource, "variant")) {
    props.push('variant="dark"');
  }

  return props;
}

function hasProp(source, propName) {
  return new RegExp(`\\b${propName}\\s*:`, "m").test(source);
}

function hasRequiredProp(source, propName) {
  return new RegExp(`\\b${propName}\\s*:\\s*\\{[\\s\\S]*?required\\s*:\\s*true`, "m").test(source);
}

function createVuePreviewCss() {
  return `:root {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background: #f5f7fb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}
`;
}

function createVueViteConfig() {
  return `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()]
})
`;
}

function createVueTsConfig() {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      module: "ESNext",
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      skipLibCheck: true,
      moduleResolution: "Bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "preserve",
      strict: true
    },
    include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
  }, null, 2)}\n`;
}

async function findBuildOutput(sourceDir) {
  const candidates = [
    "dist",
    "build",
    "out",
    "public",
    path.join(".output", "public")
  ];

  for (const candidate of candidates) {
    const candidatePath = path.join(sourceDir, candidate);
    if (await pathExists(path.join(candidatePath, "index.html"))) {
      return candidatePath;
    }
  }

  return null;
}

async function copyStaticProject(sourceDir, previewDir) {
  if (!(await pathExists(path.join(sourceDir, "index.html")))) {
    throw new Error("Static project must contain index.html at its root.");
  }
  await copyDirectory(sourceDir, previewDir, ignoredArchiveDirs);
}

async function ensureSpaFallback(previewDir) {
  const indexPath = path.join(previewDir, "index.html");
  if (!(await pathExists(indexPath))) {
    throw new Error("Preview output does not contain index.html.");
  }
}

async function copyDirectory(source, destination, ignoredNames = new Set()) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredNames.has(entry.name)) continue;

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, ignoredNames);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
