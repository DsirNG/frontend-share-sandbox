const uploadForm = document.querySelector("#uploadForm");
const projectFile = document.querySelector("#projectFile");
const projectList = document.querySelector("#projectList");
const projectName = document.querySelector("#projectName");
const projectMeta = document.querySelector("#projectMeta");
const openPreview = document.querySelector("#openPreview");
const previewFrame = document.querySelector("#previewFrame");
const emptyState = document.querySelector("#emptyState");
const analysis = document.querySelector("#analysis");
const logs = document.querySelector("#logs");

let selectedProjectId = null;
let pollTimer = null;

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
    previewFrame.src = `${project.previewUrl}?t=${Date.now()}`;
    emptyState.classList.add("hidden");
  } else {
    openPreview.href = "#";
    openPreview.classList.add("disabled");
    previewFrame.removeAttribute("src");
    emptyState.classList.remove("hidden");
    emptyState.textContent = project.status === "failed" ? "构建失败" : "构建中...";
  }

  renderAnalysis(project);
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
