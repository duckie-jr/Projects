// ============================================================
//  ADD / EDIT YOUR PROJECTS HERE
// ============================================================
const PROJECTS = [
  {
    title: "My First Project",
    description: "A short description of what this project does.",
    url: "https://github.com/duckie-jr/Projects",
    tag: "Web",
  },
  {
    title: "Your Project Name",
    description: "What it does in one sentence.",
    url: "https://github.com/duckie-jr/Projects",
    tag: "Web",
  },
  {
    title: "Morse Code Trainer",
    description: "A Morse code trainer with a Type mode (tap dot/dash to compose text) and a Learn mode (quizzes you on characters one at a time, with a picker to choose which letters/numbers to practice).",
    url: "https://github.com/duckie-jr/Projects/Morse",
    tag: "Web",
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


