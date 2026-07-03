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

  const projectId = nanoid(10);
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

app.use("/preview/:projectId", async (req, res, next) => {
  const project = projects.get(req.params.projectId);
  if (!project || project.status !== "ready") {
    res.status(404).send("Preview is not ready.");
    return;
  }

  const staticRoot = path.join(previewsDir, req.params.projectId);
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

function servePreviewHost(req, res, next) {
  const host = req.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9_-]+)\.localhost$/);
  if (!match) {
    next();
    return;
  }

  const project = findProject(match[1]);
  if (!project || project.status !== "ready") {
    res.status(404).send("Preview is not ready.");
    return;
  }

  const staticRoot = path.join(previewsDir, project.id);
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
