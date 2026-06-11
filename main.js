// ============================================================
//  ADD / EDIT YOUR PROJECTS HERE
// ============================================================
const PROJECTS = [
  {
    title: "Devlink",
    description: "Devlink lets users create or join a shared room where they can edit code together in real-time and chat, all peer-to-peer with no server or account needed.",
    url: "https://duckie-jr.github.io/Projects/Devlink/",
    tag: "Media",
  },
    {
    title: "DropIn",
    description: "Instant calls with the people you actually want to talk to — no scheduling, no friction.",
    url: "https://duckie-jr.github.io/Projects/DropIn",
    tag: "Media",
  },
  {
    title: "Jr's Movies",
    description: "A personal movie and TV streaming front-end that lets users browse/search titles, watch via embedded players, and manage watch history and playlists under a student ID login.",
    url: "https://duckie-jr.github.io/Projects/Movies/",
    tag: "Web",
  },
  {
    title: "Morse Code",
    description: "A Morse code trainer with a Type mode (tap dot/dash to compose text) and a Learn mode (quizzes you on characters one at a time, with a picker to choose which letters/numbers to practice).",
    url: "https://duckie-jr.github.io/Projects/Morse/",
    tag: "Web",
  }
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


