const uploadForm = document.querySelector("#uploadForm");
const vueComponentForm = document.querySelector("#vueComponentForm");
const projectFile = document.querySelector("#projectFile");
const componentFile = document.querySelector("#componentFile");
const demoFile = document.querySelector("#demoFile");
const externalCss = document.querySelector("#externalCss");
const projectList = document.querySelector("#projectList");
const projectName = document.querySelector("#projectName");
const projectMeta = document.querySelector("#projectMeta");
const openPreview = document.querySelector("#openPreview");
const previewWrap = document.querySelector(".preview-wrap");
const previewFrame = document.querySelector("#previewFrame");
const emptyState = document.querySelector("#emptyState");
const fileExplorer = document.querySelector("#fileExplorer");
const fileTree = document.querySelector("#fileTree");
const activeFilePath = document.querySelector("#activeFilePath");
const fileContent = document.querySelector("#fileContent");
const details = document.querySelector(".details");
const analysis = document.querySelector("#analysis");
const logs = document.querySelector("#logs");

let selectedProjectId = null;
let pollTimer = null;
let explorerProjectId = null;
let selectedFilePath = null;

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = projectFile.files[0];
  if (!file) {
    alert("先选择一个 zip 文件。");
    return;
  }

  const formData = new FormData();
  formData.append("project", file);

  const response = await fetch("/api/projects/upload", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    alert(error.error || "上传失败");
    return;
  }

  const { project } = await response.json();
  selectedProjectId = project.id;
  renderProject(project);
  await loadProjects();
  startPolling(project.id);
});

vueComponentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const component = componentFile.files[0];
  if (!component) {
    alert("先选择一个 .vue 组件文件。");
    return;
  }

  const formData = new FormData();
  formData.append("component", component);
  if (demoFile.files[0]) {
    formData.append("demo", demoFile.files[0]);
  }
  if (externalCss.value.trim()) {
    formData.append("externalCss", externalCss.value.trim());
  }

  const response = await fetch("/api/components/vue/upload", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    alert(error.error || "上传失败");
    return;
  }

  const { project } = await response.json();
  selectedProjectId = project.id;
  renderProject(project);
  await loadProjects();
  startPolling(project.id);
});

async function loadProjects() {
  const response = await fetch("/api/projects");
  const data = await response.json();
  renderProjectList(data.projects);
}

async function loadProject(id) {
  const response = await fetch(`/api/projects/${id}`);
  if (!response.ok) return;
  const { project } = await response.json();
  renderProject(project);

  if (!["ready", "failed"].includes(project.status)) {
    startPolling(project.id);
  }
}

function startPolling(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await loadProject(id);
    await loadProjects();

    const response = await fetch(`/api/projects/${id}`);
    if (!response.ok) return;
    const { project } = await response.json();
    if (["ready", "failed"].includes(project.status)) {
      clearInterval(pollTimer);
    }
  }, 1400);
}

function renderProjectList(projects) {
  projectList.innerHTML = "";

  if (!projects.length) {
    projectList.innerHTML = `<div class="hint">暂无项目。</div>`;
    return;
  }

  for (const project of projects) {
    const button = document.createElement("button");
    button.className = `project-card ${project.id === selectedProjectId ? "active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(project.name)}</strong>
      <span class="status-${project.status}">${escapeHtml(project.status)} · ${escapeHtml(project.framework)}</span>
    `;
    button.addEventListener("click", () => {
      selectedProjectId = project.id;
      renderProject(project);
      loadProject(project.id);
      loadProjects();
    });
    projectList.appendChild(button);
  }
}

function renderProject(project) {
  selectedProjectId = project.id;
  projectName.textContent = project.name;
  projectMeta.innerHTML = `<span class="status-${project.status}">${project.status}</span> · ${project.framework} · ${new Date(project.createdAt).toLocaleString()}`;
  logs.textContent = project.logs?.length ? project.logs.join("\n") : "等待构建日志...";
  logs.scrollTop = logs.scrollHeight;

  if (project.status === "ready" && project.previewUrl) {
    openPreview.href = project.previewUrl;
    openPreview.classList.remove("disabled");
    previewFrame.removeAttribute("src");
    previewWrap.classList.add("hidden");
    details.classList.add("hidden");
    fileExplorer.classList.remove("hidden");
    loadFileExplorer(project.id);
  } else {
    openPreview.href = "#";
    openPreview.classList.add("disabled");
    previewFrame.removeAttribute("src");
    previewWrap.classList.remove("hidden");
    details.classList.remove("hidden");
    fileExplorer.classList.add("hidden");
    emptyState.classList.remove("hidden");
    emptyState.textContent = project.status === "failed" ? "构建失败，请查看日志。" : "上传成功，正在解析和构建...";
  }

  renderAnalysis(project);
}

async function loadFileExplorer(projectId) {
  if (explorerProjectId === projectId) return;

  explorerProjectId = projectId;
  selectedFilePath = null;
  fileTree.innerHTML = `<div class="hint">正在加载文件目录...</div>`;
  activeFilePath.textContent = "选择一个文件";
  fileContent.textContent = "正在解析项目文件...";

  const response = await fetch(`/api/projects/${projectId}/files`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "文件目录加载失败" }));
    fileTree.innerHTML = `<div class="hint">${escapeHtml(error.error)}</div>`;
    fileContent.textContent = error.error;
    return;
  }

  const { tree } = await response.json();
  fileTree.innerHTML = "";
  renderFileNodes(tree.children || [], fileTree, 0, projectId);

  const firstFile = findFirstReadableFile(tree);
  if (firstFile) {
    await openFile(projectId, firstFile.path);
  } else {
    activeFilePath.textContent = "没有可预览的文本文件";
    fileContent.textContent = "这个项目没有找到可直接预览的文本文件。";
  }
}

function renderFileNodes(nodes, container, depth, projectId) {
  for (const node of nodes) {
    const item = document.createElement(node.type === "file" && node.readable ? "button" : "div");
    item.className = `file-node ${node.type}${node.readable === false ? " unreadable" : ""}`;
    item.style.paddingLeft = `${8 + depth * 14}px`;
    item.dataset.path = node.path;

    const prefix = node.type === "dir" ? "[dir]" : "[file]";
    item.innerHTML = `<span>${prefix}</span><span class="file-node-name">${escapeHtml(node.name)}</span>`;

    if (node.type === "file" && node.readable) {
      item.addEventListener("click", () => openFile(projectId, node.path));
    }

    container.appendChild(item);

    if (node.type === "dir" && node.children?.length) {
      renderFileNodes(node.children, container, depth + 1, projectId);
    }
  }
}

function findFirstReadableFile(node) {
  if (node.type === "file" && node.readable) return node;
  for (const child of node.children || []) {
    const result = findFirstReadableFile(child);
    if (result) return result;
  }
  return null;
}

async function openFile(projectId, path) {
  selectedFilePath = path;
  activeFilePath.textContent = path;
  fileContent.textContent = "正在加载文件...";
  updateActiveFileNode(path);

  const response = await fetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "文件加载失败" }));
    fileContent.textContent = error.error;
    return;
  }

  const file = await response.json();
  activeFilePath.textContent = file.path;
  fileContent.textContent = file.content;
}

function updateActiveFileNode(path) {
  for (const node of fileTree.querySelectorAll(".file-node")) {
    node.classList.toggle("active", node.dataset.path === path);
  }
}

function renderAnalysis(project) {
  const dependencies = Object.keys(project.dependencies || {});
  const scripts = Object.keys(project.scripts || {});
  const files = project.rootFiles || [];

  analysis.innerHTML = [
    metric("项目 ID", project.id),
    metric("识别框架", project.framework),
    metric("npm scripts", scripts.length ? scripts.join(", ") : "无"),
    metric("依赖数量", dependencies.length),
    metric("根目录文件", files.map((file) => file.name).join(", ") || "无")
  ].join("");
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadProjects();
