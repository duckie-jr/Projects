const GITHUB_USERNAME = "duckie-jr";
const PROJECTS_REPO   = "Projects";
const API_BASE        = "https://api.github.com";
const RAW_BASE        = "https://raw.githubusercontent.com";

const avatarImg      = document.getElementById("avatar");
const loadingGrid    = document.getElementById("loading-grid");
const projectGrid    = document.getElementById("project-grid");
const emptyState     = document.getElementById("empty-state");
const emptyMessage   = document.getElementById("empty-message");
const errorState     = document.getElementById("error-state");
const errorMessage   = document.getElementById("error-message");
const searchInput    = document.getElementById("search-input");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const retryBtn       = document.getElementById("retry-btn");

let allProjects        = [];
let currentSearchQuery = "";

// ── Theme ────────────────────────────────────────────────────
function initializeTheme() {
  const saved      = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", saved ?? (prefersDark ? "dark" : "light"));
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
}

// ── GitHub API ───────────────────────────────────────────────
async function fetchProjectFolders() {
  const response = await fetch(
    `${API_BASE}/repos/${GITHUB_USERNAME}/${PROJECTS_REPO}/contents`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
  const contents = await response.json();
  return contents.filter((entry) => entry.type === "dir");
}

async function fetchFolderDescription(folderName) {
  try {
    const response = await fetch(
      `${RAW_BASE}/${GITHUB_USERNAME}/${PROJECTS_REPO}/main/${folderName}/README.md`
    );
    if (!response.ok) return "";
    const text = await response.text();
    const firstContentLine = text.split("\n").find(
      (line) => line.trim() && !line.startsWith("#")
    );
    return firstContentLine?.trim() ?? "";
  } catch {
    return "";
  }
}

async function loadAvatar() {
  try {
    const response = await fetch(`${API_BASE}/users/${GITHUB_USERNAME}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return;
    const userData = await response.json();
    avatarImg.src = userData.avatar_url;
    avatarImg.style.display = "block";
  } catch {
    // decorative — skip silently
  }
}

// ── Rendering ────────────────────────────────────────────────
function buildProjectCardHTML(project, index) {
  const descriptionHTML = project.description
    ? `<p class="card-description">${project.description}</p>`
    : `<p class="card-description" style="opacity:0.4;font-style:italic">No description yet.</p>`;

  return `
    <article class="project-card">
      <span class="card-number">Project ${String(index + 1).padStart(2, "0")}</span>
      <h3 class="card-title">
        <a href="${project.url}" target="_blank" rel="noopener noreferrer">${project.name}</a>
      </h3>
      ${descriptionHTML}
      <a href="${project.url}" target="_blank" rel="noopener noreferrer" class="card-cta">
        View project
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 8h10M9 4l4 4-4 4"/>
        </svg>
      </a>
    </article>
  `;
}

function renderProjects() {
  const query   = currentSearchQuery.toLowerCase().trim();
  const visible = allProjects.filter(
    (p) => !query || p.name.toLowerCase().includes(query)
  );

  if (visible.length === 0) {
    projectGrid.hidden = true;
    emptyState.hidden  = false;
    emptyMessage.textContent = query
      ? `No projects match "${query}".`
      : "No project folders yet — add a folder to this repo to get started!";
    return;
  }

  projectGrid.innerHTML = visible.map((p, i) => buildProjectCardHTML(p, i)).join("");
  projectGrid.hidden    = false;
  emptyState.hidden     = true;
}

// ── Data loading ─────────────────────────────────────────────
async function loadProjects() {
  loadingGrid.hidden = false;
  projectGrid.hidden = true;
  emptyState.hidden  = true;
  errorState.hidden  = true;

  try {
    const folders = await fetchProjectFolders();

    allProjects = await Promise.all(
      folders.map(async (folder) => ({
        name:        folder.name,
        url:         folder.html_url,
        description: await fetchFolderDescription(folder.name),
      }))
    );

    renderProjects();
  } catch (err) {
    console.error("Failed to load projects:", err);
    errorMessage.textContent = err.message;
    errorState.hidden = false;
  } finally {
    loadingGrid.hidden = true;
  }
}

// ── Service worker ───────────────────────────────────────────
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(console.warn);
  }
}

// ── Init ─────────────────────────────────────────────────────
function main() {
  initializeTheme();
  registerServiceWorker();
  loadAvatar();

  themeToggleBtn.addEventListener("click", toggleTheme);
  searchInput.addEventListener("input", (e) => {
    currentSearchQuery = e.target.value;
    renderProjects();
  });
  retryBtn.addEventListener("click", loadProjects);

  loadProjects();
}

main();
