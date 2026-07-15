import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { nanoid } from "nanoid";
import iconv from "iconv-lite";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import pool from "./db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 30003);

const storageRoot = path.join(__dirname, "storage");
const uploadsDir = path.join(storageRoot, "uploads");
const projectsDir = path.join(storageRoot, "projects");
const previewsDir = path.join(storageRoot, "previews");
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 250);

/** JWT 密钥，与 Spring Boot 后端保持一致 */
const JWT_SECRET = process.env.JWT_SECRET || "xander-lab-secret-key-must-be-at-least-32-chars-for-hmac";

/** 每用户最大项目数，超出后自动清理最旧的 */
const MAX_PROJECTS_PER_USER = Number(process.env.MAX_PROJECTS_PER_USER || 20);

/** Redis 前缀，与 Java 后端 Constants.java 保持一致 */
const REDIS_TOKEN_PREFIX = "login:token:";

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
const readableFileExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yml",
  ".yaml"
]);
const maxReadableFileBytes = 1024 * 1024;

/** Redis 客户端，用于校验 token 是否仍活跃（与 Java 后端共享同一 Redis） */
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("[Redis] Connection error:", err.message);
});

// ──────────────────────────────────────────────
// MySQL 数据访问层
// ──────────────────────────────────────────────

/**
 * 创建项目记录
 * @param {object} project - 项目字段
 * @returns {Promise<object>} 创建的项目记录
 */
async function createProject(project) {
  const { id, user_id, name, status, framework, preview_url, scripts, dependencies, root_files, logs } = project;
  await pool.execute(
    `INSERT INTO studio_project (id, user_id, name, status, framework, preview_url, scripts, dependencies, root_files, logs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user_id, name, status || "queued", framework || "unknown", preview_url,
     JSON.stringify(scripts || {}), JSON.stringify(dependencies || {}),
     JSON.stringify(root_files || []), JSON.stringify(logs || [])]
  );
  return getProjectById(id);
}

/**
 * 根据 ID 查询单个项目
 * @param {string} id - 项目 ID
 * @returns {Promise<object|null>} 项目记录或 null
 */
async function getProjectById(id) {
  const [rows] = await pool.execute("SELECT * FROM studio_project WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  return deserializeProject(rows[0]);
}

/**
 * 查询用户的所有项目（按创建时间倒序）
 * @param {number} userId - 用户 ID
 * @returns {Promise<object[]>} 项目列表
 */
async function getProjectsByUserId(userId) {
  const [rows] = await pool.execute(
    "SELECT * FROM studio_project WHERE user_id = ? ORDER BY created_at DESC",
    [userId]
  );
  return rows.map(deserializeProject);
}

/**
 * 更新项目状态
 * @param {string} id - 项目 ID
 * @param {string} status - 新状态
 */
async function updateProjectStatus(id, status) {
  await pool.execute("UPDATE studio_project SET status = ? WHERE id = ?", [status, id]);
}

/**
 * 更新项目的全部可变字段（构建完成后调用）
 * @param {string} id - 项目 ID
 * @param {object} fields - 要更新的字段
 */
async function updateProjectFull(id, fields) {
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    const col = camelToSnake(key);
    if (["scripts", "dependencies", "root_files", "logs"].includes(col)) {
      sets.push(`${col} = ?`);
      values.push(JSON.stringify(value));
    } else {
      sets.push(`${col} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  await pool.execute(`UPDATE studio_project SET ${sets.join(", ")} WHERE id = ?`, values);
}

async function markProjectBuildFailed(projectId, error) {
  const existing = await getProjectById(projectId);
  const logs = Array.isArray(existing?.logs) ? [...existing.logs] : [];
  const fatalLine = `Fatal error: ${error.message}`;

  if (logs[logs.length - 1] !== fatalLine) {
    logs.push(fatalLine);
  }

  await updateProjectFull(projectId, { status: "failed", logs });
}

/**
 * 删除项目记录
 * @param {string} id - 项目 ID
 */
async function deleteProjectById(id) {
  await pool.execute("DELETE FROM studio_project WHERE id = ?", [id]);
}

/**
 * 清理用户超出限额的旧项目（保留最新的 MAX_PROJECTS_PER_USER 个）
 * @param {number} userId - 用户 ID
 */
async function cleanupOldProjects(userId) {
  const [rows] = await pool.execute(
    "SELECT id FROM studio_project WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000",
    [userId]
  );
  if (rows.length <= MAX_PROJECTS_PER_USER) return;

  const toDelete = rows.slice(MAX_PROJECTS_PER_USER);
  for (const row of toDelete) {
    await deleteProjectById(row.id);
    // 清理磁盘上的预览文件
    await fs.rm(path.join(previewsDir, row.id), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(projectsDir, row.id), { recursive: true, force: true }).catch(() => {});
    console.log(`[Cleanup] Deleted project ${row.id} for user ${userId}`);
  }
}

/**
 * 将 MySQL 行反序列化为前端友好的项目对象
 * @param {object} row - MySQL 行
 * @returns {object} 反序列化后的项目对象
 */
function deserializeProject(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    framework: row.framework,
    previewUrl: row.preview_url,
    scripts: safeJsonParse(row.scripts, {}),
    dependencies: safeJsonParse(row.dependencies, {}),
    rootFiles: safeJsonParse(row.root_files, []),
    logs: safeJsonParse(row.logs, []),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * 安全解析 JSON 字符串
 * @param {string|null} str - JSON 字符串
 * @param {*} fallback - 解析失败时的默认值
 * @returns {*} 解析结果
 */
function safeJsonParse(str, fallback) {
  if (str == null) return fallback;
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * camelCase 转 snake_case
 * @param {string} str - camelCase 字符串
 * @returns {string} snake_case 字符串
 */
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// ──────────────────────────────────────────────
// JWT 鉴权中间件
// ──────────────────────────────────────────────

/**
 * JWT 鉴权中间件
 * 验证 token 签名 + 检查 Redis 中 token 是否仍活跃
 * 通过后设置 req.userId
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendError(res, 401, "未登录或登录已过期");
    return;
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // 检查 Redis 中 token 是否仍存在（与 Java 后端逻辑一致）
    const redisValue = await redis.get(REDIS_TOKEN_PREFIX + token);
    if (!redisValue) {
      sendError(res, 401, "未登录或登录已过期");
      return;
    }
    req.userId = Number(decoded.sub || redisValue);
    next();
  } catch (err) {
    sendError(res, 401, "未登录或登录已过期");
  }
}

// ──────────────────────────────────────────────
// 编码检测
// ──────────────────────────────────────────────

/**
 * 检测文本编码并返回 UTF-8 字符串
 * 优先 UTF-8，若检测到乱码则回退到 GBK（兼容中文 Windows 生成的文件）
 * @param {Buffer} buf - 文件原始字节
 * @returns {string} UTF-8 编码的文本内容
 */
function decodeTextContent(buf) {
  const utf8Str = buf.toString("utf8");
  if (!utf8Str.includes("\uFFFD")) {
    const nonAscii = utf8Str.replace(/[\x00-\x7f]/g, "");
    if (nonAscii.length === 0) return utf8Str;
    const gbkStr = iconv.decode(buf, "gbk");
    if (/[\u4e00-\u9fff]/.test(gbkStr) && !/[\u4e00-\u9fff]/.test(utf8Str)) {
      return gbkStr;
    }
    return utf8Str;
  }
  return iconv.decode(buf, "gbk");
}

// ──────────────────────────────────────────────
// Multer 上传配置
// ──────────────────────────────────────────────

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: maxUploadMb * 1024 * 1024
  }
});

// ──────────────────────────────────────────────
// 请求日志中间件 & 错误响应辅助
// ──────────────────────────────────────────────

/**
 * 请求日志中间件：记录每个请求的完整响应信息
 * 拦截 res.json() 捕获响应体，在 res.end() 时输出格式化日志
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  let responseBody = "";

  // 拦截 json() 调用以捕获响应体
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = JSON.stringify(body);
    return originalJson(body);
  };

  // 拦截 send() 调用以捕获纯文本响应
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === "string") responseBody = body;
    return originalSend(body);
  };

  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    const method = req.method;
    const uri = req.originalUrl || req.url;
    const status = res.statusCode;
    const separator = "================";
    const header = `${separator} OUTGOING RESPONSE ${separator}`;
    const footer = "=".repeat(header.length);

    console.log(
      `\n${header}\n` +
      `Method : ${method}\n` +
      `URI    : ${uri}\n` +
      `Status : ${status}\n` +
      `Time   : ${duration} ms\n` +
      `Res Body: ${responseBody || "(empty)"}\n` +
      `${footer}`
    );
    originalEnd.apply(res, args);
  };
  next();
}

/**
 * 发送统一格式的错误响应 { code, message, data: null }
 * @param {object} res - Express response 对象
 * @param {number} code - HTTP 状态码
 * @param {string} message - 错误消息
 */
function sendError(res, code, message) {
  res.status(code).json({ code, message, data: null });
}

// ──────────────────────────────────────────────
// Express 中间件 & 路由
// ──────────────────────────────────────────────

app.use(express.json());
app.use(requestLogger);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * GET /studio-api/projects - 获取当前用户的所有项目
 */
app.get("/studio-api/projects", authMiddleware, async (req, res) => {
  try {
    const projects = await getProjectsByUserId(req.userId);
    res.json({ projects });
  } catch (error) {
    console.error("[GET /studio-api/projects]", error.message);
    sendError(res, 500, "加载项目失败");
  }
});

/**
 * GET /studio-api/projects/:id - 获取单个项目详情
 */
app.get("/studio-api/projects/:id", authMiddleware, async (req, res) => {
  try {
    const project = await findProject(req.params.id);
    if (!project || project.userId !== req.userId) {
      sendError(res, 404, "项目不存在");
      return;
    }
    res.json({ project });
  } catch (error) {
    console.error("[GET /studio-api/projects/:id]", error.message);
    sendError(res, 500, "加载项目失败");
  }
});

/**
 * GET /studio-api/projects/:id/files - 获取项目文件树
 */
app.get("/studio-api/projects/:id/files", authMiddleware, async (req, res) => {
  try {
    const project = await findProject(req.params.id);
    if (!project || project.userId !== req.userId) {
      sendError(res, 404, "项目不存在");
      return;
    }

    const sourceDir = await getProjectSourceDir(req.params.id);
    if (!sourceDir) {
      sendError(res, 404, "项目文件不存在");
      return;
    }

    const tree = await buildFileTree(sourceDir);
    res.json({ tree });
  } catch (error) {
    sendError(res, 500, error.message || "加载文件树失败");
  }
});

/**
 * GET /studio-api/projects/:id/files/content - 获取项目文件内容
 */
app.get("/studio-api/projects/:id/files/content", authMiddleware, async (req, res) => {
  try {
    const project = await findProject(req.params.id);
    if (!project || project.userId !== req.userId) {
      sendError(res, 404, "项目不存在");
      return;
    }

    const sourceDir = await getProjectSourceDir(req.params.id);
    if (!sourceDir) {
      sendError(res, 404, "项目文件不存在");
      return;
    }

    const relativePath = String(req.query.path || "");
    const filePath = resolveProjectPath(sourceDir, relativePath);
    if (!filePath) {
      sendError(res, 400, "无效的文件路径");
      return;
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendError(res, 400, "路径不是文件");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!readableFileExtensions.has(extension)) {
      sendError(res, 415, "该文件类型不支持文本预览");
      return;
    }

    if (stat.size > maxReadableFileBytes) {
      sendError(res, 413, "文件过大，无法预览");
      return;
    }

    const rawBuf = await fs.readFile(filePath);
    const content = decodeTextContent(rawBuf);
    res.json({
      path: normalizeRelativePath(path.relative(sourceDir, filePath)),
      extension,
      size: stat.size,
      content
    });
  } catch (error) {
    sendError(res, 500, error.message || "加载文件失败");
  }
});

/**
 * POST /studio-api/projects/upload - 上传 zip 项目
 */
app.post("/studio-api/projects/upload", authMiddleware, uploadProject, async (req, res) => {
  if (!req.file) {
    sendError(res, 400, "请上传 zip 文件");
    return;
  }

  const projectId = createProjectId();
  const originalName = req.file.originalname || "project.zip";
  const projectDir = path.join(projectsDir, projectId);
  const previewDir = path.join(previewsDir, projectId);
  const uploadPath = req.file.path;

  const record = {
    id: projectId,
    userId: req.userId,
    name: originalName.replace(/\.zip$/i, ""),
    status: "queued",
    createdAt: new Date().toISOString(),
    previewUrl: null,
    scripts: {},
    dependencies: {},
    framework: "unknown",
    sourceDir: null,
    rootFiles: [],
    logs: []
  };

  try {
    // 写入 MySQL
    await createProject({
      id: projectId,
      user_id: req.userId,
      name: record.name,
      status: "queued",
      framework: "unknown",
      preview_url: null,
      scripts: {},
      dependencies: {},
      root_files: [],
      logs: [],
    });

    res.status(202).json({ project: record });

    // 异步构建
    buildUploadedProject({ projectId, uploadPath, projectDir, previewDir }).catch((error) => {
      markProjectBuildFailed(projectId, error).catch((err) => {
        console.error("[Build Failure]", err.message);
      });
    });

    // 清理超出限额的旧项目
    cleanupOldProjects(req.userId).catch((err) => {
      console.error("[Cleanup] Error:", err.message);
    });
  } catch (error) {
    console.error("[Upload]", error.message);
    sendError(res, 500, "创建项目失败");
  }
});

/**
 * POST /studio-api/components/vue/upload - 上传 Vue 组件
 */
app.post("/studio-api/components/vue/upload", authMiddleware, uploadVueComponent, async (req, res) => {
  const componentFile = req.files?.component?.[0];
  const demoFile = req.files?.demo?.[0];

  if (!componentFile) {
    sendError(res, 400, "请上传 .vue 组件文件");
    return;
  }

  const projectId = createProjectId();
  const componentName = toPascalCase(path.basename(componentFile.originalname, ".vue")) || "SharedComponent";
  const projectDir = path.join(projectsDir, projectId);
  const previewDir = path.join(previewsDir, projectId);

  const record = {
    id: projectId,
    userId: req.userId,
    name: componentName,
    status: "queued",
    createdAt: new Date().toISOString(),
    previewUrl: null,
    scripts: {},
    dependencies: {},
    framework: "Vue Component",
    sourceDir: null,
    rootFiles: [],
    logs: []
  };

  try {
    await createProject({
      id: projectId,
      user_id: req.userId,
      name: componentName,
      status: "queued",
      framework: "Vue Component",
      preview_url: null,
      scripts: {},
      dependencies: {},
      root_files: [],
      logs: [],
    });

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
      markProjectBuildFailed(projectId, error).catch((err) => {
        console.error("[Vue Build Failure]", err.message);
      });
    });

    cleanupOldProjects(req.userId).catch((err) => {
      console.error("[Cleanup] Error:", err.message);
    });
  } catch (error) {
    console.error("[Vue Upload]", error.message);
    sendError(res, 500, "创建项目失败");
  }
});

// ──────────────────────────────────────────────
// Multer 中间件
// ──────────────────────────────────────────────

function uploadProject(req, res, next) {
  upload.single("project")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, 413, `文件过大，当前限制 ${maxUploadMb} MB`);
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
      sendError(res, 413, `文件过大，当前限制 ${maxUploadMb} MB`);
      return;
    }

    next(error);
  });
}

// ──────────────────────────────────────────────
// 预览服务
// ──────────────────────────────────────────────

// Preview is served only from the configured project subdomain.
app.use(async (req, res, next) => {
  const projectId = getPreviewProjectIdFromHost(req);
  if (!projectId) {
    next();
    return;
  }

  const project = await findProject(projectId);
  const storedProjectId = project?.id || await findStoredPreviewId(projectId);
  if (!storedProjectId) {
    sendError(res, 404, "预览尚未准备好");
    return;
  }

  // 如果有项目记录，检查状态
  if (project && project.status !== "ready") {
    sendError(res, 404, "预览尚未准备好");
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

// ──────────────────────────────────────────────
// 启动
// ──────────────────────────────────────────────

app.listen(port, async () => {
  await ensureStorage();
  // 尝试连接 Redis（非阻塞，失败时仅警告）
  try {
    await redis.connect();
    console.log("[Redis] Connected");
  } catch (err) {
    console.warn("[Redis] Failed to connect:", err.message);
  }
  console.log(`Frontend share sandbox is running at http://localhost:${port}`);
});

// ──────────────────────────────────────────────
// 构建流程
// ──────────────────────────────────────────────

/**
 * 构建上传的 zip 项目
 * 流程：解压 → 检测框架 → npm install → npm build → 复制 dist 到预览目录
 * @param {object} params - 构建参数
 */
async function buildUploadedProject({ projectId, uploadPath, projectDir, previewDir }) {
  await updateProjectStatus(projectId, "extracting");

  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(previewDir, { recursive: true, force: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  // 用临时 logs 数组收集日志，构建完成后一次性写入 MySQL
  const logs = [];

  await extractZipSafely(uploadPath, projectDir, { logs });
  await fs.rm(uploadPath, { force: true });

  const sourceDir = await findProjectRoot(projectDir);
  const rootFiles = await listRootFiles(sourceDir);

  const packageJsonPath = path.join(sourceDir, "package.json");
  const hasPackageJson = await pathExists(packageJsonPath);

  if (!hasPackageJson) {
    await updateProjectFull(projectId, {
      status: "publishing",
      framework: "static",
      rootFiles,
      logs: [...logs, "No package.json found. Publishing as a static site."],
    });
    await copyStaticProject(sourceDir, previewDir);
    await updateProjectFull(projectId, {
      status: "ready",
      previewUrl: getPreviewUrl(projectId),
      logs: [...logs, "No package.json found. Published files as a static site."],
    });
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const name = packageJson.name || (await getProjectById(projectId))?.name || projectId;
  const scripts = packageJson.scripts || {};
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const framework = detectFramework(packageJson);

  // 更新项目元信息
  await updateProjectFull(projectId, {
    name,
    scripts,
    dependencies,
    framework,
    rootFiles,
    logs,
  });

  if (!scripts.build) {
    logs.push("package.json does not contain a build script.");
    await updateProjectFull(projectId, { status: "failed", logs });
    return;
  }

  // npm install
  await updateProjectStatus(projectId, "installing");
  const packageManager = getPackageManager(sourceDir);
  await runCommand(packageManager, getInstallArgs(packageManager), sourceDir, { logs, projectId });

  // npm build
  await updateProjectStatus(projectId, "building");
  const buildRecord = { dependencies, logs };
  await runCommand(packageManager, getBuildArgs(buildRecord, projectId), sourceDir, { logs, projectId });

  const distDir = await findBuildOutput(sourceDir);
  if (!distDir) {
    logs.push("Build finished, but no dist/build/public output folder was found.");
    await updateProjectFull(projectId, { status: "failed", logs });
    return;
  }

  // 发布
  await updateProjectStatus(projectId, "publishing");
  await copyDirectory(distDir, previewDir);
  await ensureSpaFallback(previewDir);

  logs.push(`Published preview from ${path.relative(sourceDir, distDir) || "."}.`);
  await updateProjectFull(projectId, {
    status: "ready",
    previewUrl: getPreviewUrl(projectId),
    logs,
  });
}

/**
 * 构建 Vue 组件沙箱
 * 流程：解析组件 → 生成脚手架 → npm install → npm build → 复制 dist
 * @param {object} params - 构建参数
 */
async function buildVueComponentSandbox({ projectId, componentName, componentPath, demoPath, externalCss, projectDir, previewDir }) {
  await updateProjectStatus(projectId, "preparing");
  const logs = [];

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
    logs.push("Using uploaded App.vue as the component demo.");
  } else {
    await fs.writeFile(path.join(projectDir, "src", "App.vue"), createDefaultVueDemo(componentName, componentSource), "utf8");
    logs.push("Generated a default Vue demo wrapper.");
  }

  if (sandboxOptions.detectedDependencies.length) {
    logs.push(`Detected component dependencies: ${sandboxOptions.detectedDependencies.join(", ")}`);
  }

  if (sandboxOptions.externalCss.length) {
    logs.push(`Injected external CSS: ${sandboxOptions.externalCss.join(", ")}`);
  }

  await fs.writeFile(path.join(projectDir, "package.json"), createVuePackageJson(componentName, sandboxOptions.dependencies), "utf8");
  await fs.writeFile(path.join(projectDir, "index.html"), createVueIndexHtml(componentName, sandboxOptions), "utf8");
  await fs.writeFile(path.join(projectDir, "src", "main.ts"), createVueMainTs(sandboxOptions), "utf8");
  await fs.writeFile(path.join(projectDir, "src", "style.css"), createVuePreviewCss(), "utf8");
  await fs.writeFile(path.join(projectDir, "vite.config.ts"), createVueViteConfig(), "utf8");
  await fs.writeFile(path.join(projectDir, "tsconfig.json"), createVueTsConfig(), "utf8");

  const rootFiles = await listRootFiles(projectDir);
  const scripts = { build: "vite build" };
  const dependencies = { ...sandboxOptions.dependencies };

  await updateProjectFull(projectId, {
    scripts,
    dependencies,
    rootFiles,
    logs,
  });

  // npm install
  await updateProjectStatus(projectId, "installing");
  const packageManager = getPackageManager(projectDir);
  await runCommand(packageManager, getInstallArgs(packageManager), projectDir, { logs, projectId });

  // npm build
  await updateProjectStatus(projectId, "building");
  await runCommand(packageManager, ["run", "build", "--", "--base", getPreviewAssetBase(projectId)], projectDir, { logs, projectId });

  const distDir = await findBuildOutput(projectDir);
  if (!distDir) {
    logs.push("Build finished, but no dist output folder was found.");
    await updateProjectFull(projectId, { status: "failed", logs });
    return;
  }

  // 发布
  await updateProjectStatus(projectId, "publishing");
  await copyDirectory(distDir, previewDir);
  await ensureSpaFallback(previewDir);

  logs.push("Published Vue component sandbox from dist.");
  await updateProjectFull(projectId, {
    status: "ready",
    previewUrl: getPreviewUrl(projectId),
    logs,
  });
}

// ──────────────────────────────────────────────
// 预览子域名服务
// ──────────────────────────────────────────────

/**
 * 子域名预览中间件
 * 拦截 *.localhost 请求，匹配项目 ID 并返回静态文件
 */
async function servePreviewHost(req, res, next) {
  const host = req.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9_-]+)\.localhost$/);
  if (!match) {
    next();
    return;
  }

  const project = await findProject(match[1]);
  const storedProjectId = project?.id || await findStoredPreviewId(match[1]);
  if (!storedProjectId) {
    sendError(res, 404, "预览尚未准备好");
    return;
  }

  if (project && project.status !== "ready") {
    sendError(res, 404, "预览尚未准备好");
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

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/**
 * 查找项目（先查 MySQL，再尝试大小写不敏感匹配）
 * @param {string} id - 项目 ID
 * @returns {Promise<object|null>} 项目对象或 null
 */
async function findProject(id) {
  const project = await getProjectById(id);
  if (project) return project;

  // 大小写不敏感回退
  const [rows] = await pool.execute(
    "SELECT id FROM studio_project WHERE LOWER(id) = LOWER(?)",
    [id]
  );
  if (rows.length > 0) {
    return getProjectById(rows[0].id);
  }
  return null;
}

/**
 * 生成唯一项目 ID
 * @returns {string} 格式为 p + 10位字母数字
 */
function createProjectId() {
  let suffix = "";
  while (suffix.length < 10) {
    suffix += nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  return `p${suffix.slice(0, 10)}`;
}

/**
 * 获取项目源码目录
 * @param {string} projectId - 项目 ID
 * @returns {Promise<string|null>} 源码目录路径或 null
 */
async function getProjectSourceDir(projectId) {
  const projectDir = path.join(projectsDir, projectId);
  if (!(await pathExists(projectDir))) {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === projectId.toLowerCase());
    if (!match) return null;
    return findProjectRoot(path.join(projectsDir, match.name));
  }

  return findProjectRoot(projectDir);
}

/**
 * 构建文件树结构
 * @param {string} sourceDir - 源码根目录
 * @returns {Promise<object>} 文件树对象
 */
async function buildFileTree(sourceDir) {
  const counter = { count: 0 };
  const children = await readTreeChildren(sourceDir, sourceDir, 0, counter);
  return {
    name: path.basename(sourceDir),
    path: "",
    type: "dir",
    children
  };
}

/**
 * 递归读取目录子节点（文件树构建辅助）
 * @param {string} rootDir - 根目录
 * @param {string} currentDir - 当前目录
 * @param {number} depth - 当前深度
 * @param {object} counter - 计数器（防止过多节点）
 * @returns {Promise<object[]>} 子节点数组
 */
async function readTreeChildren(rootDir, currentDir, depth, counter) {
  if (depth > 8 || counter.count > 700) return [];

  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !entry.name.startsWith("__MACOSX"))
    .filter((entry) => !ignoredArchiveDirs.has(entry.name))
    .filter((entry) => !entry.name.startsWith(".") || [".env.example", ".gitignore"].includes(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = [];
  for (const entry of visibleEntries) {
    if (counter.count > 700) break;

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
    counter.count += 1;

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: "dir",
        children: await readTreeChildren(rootDir, absolutePath, depth + 1, counter)
      });
      continue;
    }

    if (entry.isFile()) {
      const stat = await fs.stat(absolutePath);
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: "file",
        size: stat.size,
        readable: readableFileExtensions.has(path.extname(entry.name).toLowerCase()) && stat.size <= maxReadableFileBytes
      });
    }
  }

  return nodes;
}

/**
 * 安全解析相对路径，防止路径穿越
 * @param {string} sourceDir - 源目录
 * @param {string} relativePath - 相对路径
 * @returns {string|null} 安全的绝对路径或 null
 */
function resolveProjectPath(sourceDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.includes("\0")) return null;

  const absolutePath = path.resolve(sourceDir, normalized);
  const relative = path.relative(sourceDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolutePath;
}

/**
 * 规范化相对路径（统一分隔符，去除前导斜杠）
 * @param {string} relativePath - 原始路径
 * @returns {string} 规范化后的路径
 */
function normalizeRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 在预览目录中查找大小写不敏感匹配的项目 ID
 * @param {string} id - 项目 ID
 * @returns {Promise<string|null>} 匹配到的实际目录名或 null
 */
async function findStoredPreviewId(id) {
  const directPath = path.join(previewsDir, id);
  if (await pathExists(directPath)) {
    return id;
  }

  const entries = await fs.readdir(previewsDir, { withFileTypes: true }).catch(() => []);
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === id.toLowerCase());
  return match?.name || null;
}

/**
 * 确保存储目录存在
 */
async function ensureStorage() {
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(previewsDir, { recursive: true });
}

/**
 * 安全解压 zip 文件
 * 过滤 node_modules/.git 等无关目录，防止路径穿越
 * @param {string} zipPath - zip 文件路径
 * @param {string} destination - 解压目标目录
 * @param {object} record - 日志记录对象
 */
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

/**
 * 查找项目根目录（处理 zip 内嵌套单层目录的情况）
 * @param {string} projectDir - 项目解压目录
 * @returns {Promise<string>} 实际的项目根目录
 */
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

/**
 * 列出项目根目录的文件和文件夹
 * @param {string} sourceDir - 源码目录
 * @returns {Promise<object[]>} 根目录条目列表
 */
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

/**
 * 根据 package.json 检测项目框架
 * @param {object} packageJson - package.json 内容
 * @returns {string} 框架名称
 */
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

/**
 * 执行构建命令（npm install / npm build 等）
 * @param {string} command - 命令
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @param {object} record - 日志记录对象
 */
async function runCommand(command, args, cwd, record) {
  const displayCommand = `${command} ${args.join(" ")}`.trim();
  record.logs.push(`$ ${displayCommand}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        CI: "true",
        npm_config_fund: "false",
        npm_config_audit: "false"
      }
    });

    const timeout = setTimeout(() => {
      const message = `Command timed out after 180 seconds: ${displayCommand}`;
      record.logs.push(message);
      child.kill("SIGTERM");
      persistCommandLogs(record).finally(() => reject(new Error(message)));
    }, 180_000);

    child.stdout.on("data", (chunk) => pushLog(record, chunk));
    child.stderr.on("data", (chunk) => pushLog(record, chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      record.logs.push(`Command failed to start: ${error.message}`);
      persistCommandLogs(record).finally(() => reject(error));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      const message = code === 127
        ? `Command failed with exit code 127 while running "${displayCommand}". A command was not found in PATH or a build dependency was not installed.`
        : `Command failed with exit code ${code}.`;
      record.logs.push(message);
      persistCommandLogs(record).finally(() => reject(new Error(message)));
    });
  });
}

async function persistCommandLogs(record) {
  if (!record.projectId) return;

  try {
    await updateProjectFull(record.projectId, { logs: record.logs });
  } catch (error) {
    console.error("[Build Logs] Failed to persist command logs:", error.message);
  }
}

/**
 * 将命令输出追加到日志数组
 * @param {object} record - 含 logs 数组的对象
 * @param {Buffer} chunk - stdout/stderr 输出
 */
function pushLog(record, chunk) {
  const text = decodeTextContent(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) record.logs.push(line);
  }
  record.logs = record.logs.slice(-600);
}

/**
 * 获取包管理器命令
 * 按优先级检测：pnpm → npm → yarn
 * @returns {string} 包管理器命令
 */
function getPackageManager(cwd = "") {
  const isWin = process.platform === "win32";
  const lockfileManagers = [
    { lockfile: "pnpm-lock.yaml", manager: isWin ? "pnpm.cmd" : "pnpm" },
    { lockfile: "package-lock.json", manager: isWin ? "npm.cmd" : "npm" },
    { lockfile: "npm-shrinkwrap.json", manager: isWin ? "npm.cmd" : "npm" },
    { lockfile: "yarn.lock", manager: isWin ? "yarn.cmd" : "yarn" }
  ];

  for (const { lockfile, manager } of lockfileManagers) {
    if (!existsSync(path.join(cwd, lockfile))) continue;

    if (!isCommandAvailable(manager)) {
      throw new Error(`Package manager not found: ${manager}. Required by ${lockfile}.`);
    }

    console.log(`[PackageManager] Using ${manager} for ${lockfile}`);
    return manager;
  }

  const managers = isWin ? ["npm.cmd", "pnpm.cmd", "yarn.cmd"] : ["npm", "pnpm", "yarn"];

  for (const manager of managers) {
    if (isCommandAvailable(manager)) {
      console.log(`[PackageManager] Using ${manager}`);
      return manager;
    }
  }

  throw new Error("No supported package manager found in PATH. Install npm, pnpm, or yarn in the build container.");
}

function isCommandAvailable(command) {
  const lookup = process.platform === "win32" ? `where ${command}` : `command -v ${command}`;

  try {
    execSync(lookup, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getInstallArgs(packageManager) {
  const normalized = packageManager.replace(/\.cmd$/i, "");

  if (normalized === "npm") {
    return ["install", "--include=dev"];
  }

  if (normalized === "pnpm") {
    return ["install", "--prod=false"];
  }

  if (normalized === "yarn") {
    return ["install", "--production=false"];
  }

  return ["install"];
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

/**
 * 获取构建命令参数
 * @param {object} record - 项目记录（含 dependencies）
 * @param {string} projectId - 项目 ID
 * @returns {string[]} 命令参数
 */
function getBuildArgs(record, projectId) {
  if (record.dependencies?.vite) {
    return ["run", "build", "--", "--base", getPreviewAssetBase(projectId)];
  }

  return ["run", "build"];
}

/**
 * 预览 URL 模板，可通过环境变量覆盖
 * 默认: http://<projectId>.localhost:<port>/
 * 生产: https://<projectId>.preview.xander-lab.dsircity.top/
 */
const previewUrlPattern = process.env.PREVIEW_URL_PATTERN
  || `http://<projectId>.localhost:${port}/`;

/**
 * 根据项目 ID 生成预览 URL
 * @param {string} projectId - 项目唯一标识
 * @returns {string} 完整的预览地址
 */
function getPreviewUrl(projectId) {
  return previewUrlPattern.replace(/<projectId>/g, projectId.toLowerCase());
}

function getPreviewAssetBase(projectId) {
  try {
    const previewUrl = new URL(getPreviewUrl(projectId));
    return previewUrl.pathname.endsWith("/") ? previewUrl.pathname : `${previewUrl.pathname}/`;
  } catch {
    return "/";
  }
}

function getPreviewProjectIdFromHost(req) {
  let host = req.hostname || req.headers.host || "";
  host = host.split(":")[0].toLowerCase();
  if (!host) return null;

  try {
    const marker = "preview-project-id";
    const patternHost = new URL(getPreviewUrl(marker)).hostname.toLowerCase();
    const markerIndex = patternHost.indexOf(marker);
    if (markerIndex < 0) return null;

    const prefix = patternHost.slice(0, markerIndex);
    const suffix = patternHost.slice(markerIndex + marker.length);
    if (!host.startsWith(prefix) || !host.endsWith(suffix)) return null;

    const projectId = host.slice(prefix.length, host.length - suffix.length);
    return /^[a-z0-9-]+$/.test(projectId) ? projectId : null;
  } catch {
    return null;
  }
}

/**
 * 将字符串转为 PascalCase
 * @param {string} value - 原始字符串
 * @returns {string} PascalCase 结果
 */
function toPascalCase(value) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * HTML 实体转义
 * @param {string} value - 原始字符串
 * @returns {string} 转义后的安全字符串
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * 分析 Vue 组件源码，提取依赖和配置
 * @param {string} componentSource - 组件源码
 * @param {string} demoSource - demo 源码
 * @param {string} externalCssInput - 外部 CSS
 * @returns {object} 沙箱配置
 */
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
    // Keep curated packages on tested versions, but do not require every
    // component library to be added to this list before it can be previewed.
    // npm resolves `latest` during the sandbox install for other valid imports.
    dependencies[dependency] = knownDependencyVersions[dependency] || "latest";
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

/**
 * 规范化外部 CSS 链接列表
 * @param {string} input - 原始输入
 * @returns {string[]} 有效的 CSS URL 数组
 */
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

/**
 * 检测源码中是否使用了 Font Awesome
 * @param {string} source - 源码
 * @returns {boolean}
 */
function usesFontAwesome(source) {
  return /\b(?:fa|fas|far|fab|fal|fad|fa-solid|fa-regular|fa-brands)\b/.test(source);
}

/**
 * 从源码中提取裸模块 import
 * @param {string} source - 源码
 * @returns {Set<string>} 模块名集合
 */
function extractBareImports(source) {
  const imports = new Set();
  const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;

  while ((match = importPattern.exec(source))) {
    const specifier = match[1] || match[2];
    if (
      !specifier
      || specifier.startsWith(".")
      || specifier.startsWith("/")
      || specifier.startsWith("@/")
      || specifier.startsWith("#")
      || specifier.includes(":")
    ) continue;

    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    imports.add(packageName);
  }

  return imports;
}

/**
 * 生成 Vue 沙箱的 package.json
 * @param {string} componentName - 组件名
 * @param {object} dependencies - 依赖
 * @returns {string} JSON 字符串
 */
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

/**
 * 生成 Vue 沙箱的 index.html
 * @param {string} componentName - 组件名
 * @param {object} options - 沙箱配置
 * @returns {string} HTML 字符串
 */
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

/**
 * 生成 Vue 沙箱的 main.ts 入口文件
 * @param {object} options - 沙箱配置
 * @returns {string} TypeScript 源码
 */
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

/**
 * 生成默认 Vue 组件 demo 包装器
 * @param {string} componentName - 组件名
 * @param {string} componentSource - 组件源码
 * @returns {string} Vue SFC 源码
 */
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

/**
 * 根据组件源码推断默认 props
 * @param {string} componentSource - 组件源码
 * @returns {string[]} props 属性字符串数组
 */
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

/**
 * 检查组件是否声明了某个 prop
 * @param {string} source - 组件源码
 * @param {string} propName - prop 名称
 * @returns {boolean}
 */
function hasProp(source, propName) {
  return new RegExp(`\\b${propName}\\s*:`, "m").test(source);
}

/**
 * 检查组件是否声明了某个 required prop
 * @param {string} source - 组件源码
 * @param {string} propName - prop 名称
 * @returns {boolean}
 */
function hasRequiredProp(source, propName) {
  return new RegExp(`\\b${propName}\\s*:\\s*\\{[\\s\\S]*?required\\s*:\\s*true`, "m").test(source);
}

/**
 * 生成 Vue 预览页的基础 CSS
 * @returns {string} CSS 内容
 */
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

/**
 * 生成 Vite 配置
 * @returns {string} vite.config.ts 内容
 */
function createVueViteConfig() {
  return `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()]
})
`;
}

/**
 * 生成 TypeScript 配置
 * @returns {string} tsconfig.json 内容
 */
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

/**
 * 查找构建输出目录（dist/build/out/public/.output/public）
 * @param {string} sourceDir - 源码目录
 * @returns {Promise<string|null>} 构建输出目录路径或 null
 */
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

/**
 * 复制静态项目到预览目录
 * @param {string} sourceDir - 源目录
 * @param {string} previewDir - 预览目录
 */
async function copyStaticProject(sourceDir, previewDir) {
  if (!(await pathExists(path.join(sourceDir, "index.html")))) {
    throw new Error("Static project must contain index.html at its root.");
  }
  await copyDirectory(sourceDir, previewDir, ignoredArchiveDirs);
}

/**
 * 确保 SPA 回退入口存在
 * @param {string} previewDir - 预览目录
 */
async function ensureSpaFallback(previewDir) {
  const indexPath = path.join(previewDir, "index.html");
  if (!(await pathExists(indexPath))) {
    throw new Error("Preview output does not contain index.html.");
  }
}

/**
 * 递归复制目录
 * @param {string} source - 源目录
 * @param {string} destination - 目标目录
 * @param {Set<string>} ignoredNames - 忽略的目录名
 */
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

/**
 * 检查路径是否存在
 * @param {string} targetPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
