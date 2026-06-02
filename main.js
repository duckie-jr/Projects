// ============================================================
//  ADD / EDIT YOUR PROJECTS HERE
// ============================================================
const PROJECTS = [
  {
    title: "My First Project",
    description: "A short description of what this project does.",
    url: "https://github.com/duckie-jr",
    tag: "Web",
  },
  {
    title: "Your Project Name",
    description: "What it does in one sentence.",
    url: "https://github.com/duckie-jr",
    tag: "Web",
  },
  {
    title: "Cool Experiment",
    description: "Something I tried out just for fun.",
    url: "https://github.com/duckie-jr",
    tag: "Experiment",
  },
];
// ============================================================

const grid = document.getElementById("project-grid");

grid.innerHTML = PROJECTS.map(({ title, description, url, tag }) => `
  <a class="card" href="${url}" target="_blank" rel="noopener noreferrer">
    <span class="tag">${tag}</span>
    <h3>${title}</h3>
    <p>${description}</p>
    <span class="arrow">—&gt;</span>
  </a>
`).join("");


