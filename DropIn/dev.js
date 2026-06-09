// ═══════════════════════════════════════════════════
//  dev.js — CREATOR / DEVELOPER-ONLY UI
//
//  Split out of main.js. Loaded as a classic (non-module) <script defer>
//  immediately AFTER main.js, so it shares main.js's global scope: every
//  top-level let/const/function in main.js is visible here, and the
//  functions defined here (showCreatorModal, openServerListModal,
//  openMoveUserModal, openRandomModModal, …) are visible to main.js.
//
//  All cross-file references happen at call time (inside event handlers and
//  functions), never at the top level, so the load order is safe.
//
//  Shared state still owned by main.js: isCreator, CREATOR_PASSWORD,
//  STORAGE_KEY_CREATOR, the active-server registry and the Random presence /
//  ban infrastructure (those are woven into core networking).
// ═══════════════════════════════════════════════════


// ═══════════════════════════════════════════════════
//  CREATOR BADGE — MODAL
// ═══════════════════════════════════════════════════

const creatorModalEl          = document.getElementById("creator-modal");
const creatorPasswordInputEl  = document.getElementById("creator-password-input");
const creatorPasswordErrorEl  = document.getElementById("creator-password-error");
const creatorPasswordSubmitEl = document.getElementById("creator-password-submit");
const creatorPasswordCancelEl = document.getElementById("creator-password-cancel");

function showCreatorModal() {
  creatorPasswordInputEl.value        = "";
  creatorPasswordErrorEl.textContent  = "";
  creatorModalEl.classList.remove("hidden");
  setTimeout(() => creatorPasswordInputEl.focus(), 50);
}

function hideCreatorModal() {
  creatorModalEl.classList.add("hidden");
}

creatorPasswordSubmitEl.addEventListener("click", () => {
  if (creatorPasswordInputEl.value === CREATOR_PASSWORD) {
    isCreator = true;
    localStorage.setItem(STORAGE_KEY_CREATOR, "1");
    hideCreatorModal();
    setLobbyStatus("Creator badge activated!");
  } else {
    creatorPasswordErrorEl.textContent = "Incorrect password.";
    creatorPasswordInputEl.select();
  }
});

creatorPasswordCancelEl.addEventListener("click", hideCreatorModal);

creatorPasswordInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter")  creatorPasswordSubmitEl.click();
  if (e.key === "Escape") hideCreatorModal();
});

// ═══════════════════════════════════════════════════
//  CREATOR — ACTIVE SERVERS MENU
//
//  Opened when a verified creator types "creator" in the Join field. Lists
//  every live room reported by the registry and lets the creator hop into any.
// ═══════════════════════════════════════════════════

const serverListModalEl     = document.getElementById("server-list-modal");
const serverListContainerEl = document.getElementById("server-list-container");
const serverListRefreshEl   = document.getElementById("server-list-refresh");
const serverListCloseEl     = document.getElementById("server-list-close");

function hideServerListModal() {
  serverListModalEl.classList.add("hidden");
}

function renderServerList(servers) {
  serverListContainerEl.innerHTML = "";

  if (!servers || servers.length === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className   = "server-list-empty";
    emptyEl.textContent = "No active servers found right now.";
    serverListContainerEl.appendChild(emptyEl);
    return;
  }

  for (const server of servers) {
    const rowEl = document.createElement("div");
    rowEl.className = "server-list-row";

    const infoEl = document.createElement("div");
    infoEl.className = "server-list-info";

    const hostNameEl       = document.createElement("div");
    hostNameEl.className    = "server-list-host";
    hostNameEl.textContent  = server.hostName || "Unknown host";

    const metaEl       = document.createElement("div");
    metaEl.className    = "server-list-meta";
    const count        = server.participantCount ?? 1;
    metaEl.textContent  = `${count} ${count === 1 ? "person" : "people"} · ${server.roomId}`;

    infoEl.append(hostNameEl, metaEl);

    const joinBtnEl       = document.createElement("button");
    joinBtnEl.className    = "btn btn-primary btn-sm";
    joinBtnEl.textContent  = "Join";
    joinBtnEl.addEventListener("click", () => {
      hideServerListModal();
      startJoinRoom(server.roomId);
    });

    rowEl.append(infoEl, joinBtnEl);
    serverListContainerEl.appendChild(rowEl);
  }
}

async function openServerListModal() {
  serverListModalEl.classList.remove("hidden");
  serverListContainerEl.innerHTML =
    `<p class="server-list-empty">Scanning for active servers…</p>`;
  const servers = await fetchActiveServers();
  renderServerList(servers);
}

serverListRefreshEl.addEventListener("click", () => openServerListModal());
serverListCloseEl.addEventListener("click", hideServerListModal);
serverListModalEl.addEventListener("click", (e) => {
  if (e.target === serverListModalEl) hideServerListModal();
});

// ═══════════════════════════════════════════════════
//  HOST / CREATOR — MOVE PARTICIPANT TO ANOTHER ROOM
// ═══════════════════════════════════════════════════

const moveUserModalEl    = document.getElementById("move-user-modal");
const moveUserNameEl     = document.getElementById("move-user-name");
const moveServerListEl   = document.getElementById("move-server-list");
const moveRoomInputEl    = document.getElementById("move-room-input");
const moveConfirmBtnEl   = document.getElementById("move-confirm-btn");
const moveCancelBtnEl    = document.getElementById("move-cancel-btn");

// The participant being relocated (kept separately from the menu target,
// which is cleared as soon as the menu closes).
let moveTargetPeerId = null;

function hideMoveUserModal() {
  moveUserModalEl.classList.add("hidden");
  moveTargetPeerId = null;
}

// Sends the relocation request — directly if host, relayed if creator-guest.
function performMove(roomId) {
  const targetRoomId = (roomId ?? "").trim();
  if (!targetRoomId || !moveTargetPeerId) return;

  if (isHost) {
    moveGuestToRoom(moveTargetPeerId, targetRoomId);
  } else if (isCreator) {
    requestCreatorModeration("move", moveTargetPeerId, targetRoomId);
  }
  hideMoveUserModal();
}

async function openMoveUserModal(targetPeerId, targetUsername) {
  moveTargetPeerId          = targetPeerId;
  moveUserNameEl.textContent = targetUsername;
  moveRoomInputEl.value      = "";
  moveUserModalEl.classList.remove("hidden");
  setTimeout(() => moveRoomInputEl.focus(), 50);

  // Offer live rooms (other than the current one) as one-click destinations.
  moveServerListEl.innerHTML =
    `<p class="server-list-empty">Loading destinations…</p>`;
  const servers = (await fetchActiveServers()).filter((s) => s.roomId !== currentRoomId);

  moveServerListEl.innerHTML = "";
  if (servers.length === 0) {
    moveServerListEl.innerHTML =
      `<p class="server-list-empty">No other live rooms — type a Room ID below.</p>`;
    return;
  }

  for (const server of servers) {
    const rowEl = document.createElement("div");
    rowEl.className = "server-list-row";

    const infoEl = document.createElement("div");
    infoEl.className = "server-list-info";
    const hostNameEl      = document.createElement("div");
    hostNameEl.className   = "server-list-host";
    hostNameEl.textContent = server.hostName || "Unknown host";
    const metaEl      = document.createElement("div");
    metaEl.className   = "server-list-meta";
    const count       = server.participantCount ?? 1;
    metaEl.textContent = `${count} ${count === 1 ? "person" : "people"} · ${server.roomId}`;
    infoEl.append(hostNameEl, metaEl);

    const pickBtnEl      = document.createElement("button");
    pickBtnEl.className   = "btn btn-primary btn-sm";
    pickBtnEl.textContent = "Move here";
    pickBtnEl.addEventListener("click", () => performMove(server.roomId));

    rowEl.append(infoEl, pickBtnEl);
    moveServerListEl.appendChild(rowEl);
  }
}

moveConfirmBtnEl.addEventListener("click", () => performMove(moveRoomInputEl.value));
moveCancelBtnEl.addEventListener("click", hideMoveUserModal);
moveRoomInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter")  performMove(moveRoomInputEl.value);
  if (e.key === "Escape") hideMoveUserModal();
});
moveUserModalEl.addEventListener("click", (e) => {
  if (e.target === moveUserModalEl) hideMoveUserModal();
});

// "Move to Room…" entry in the participant action menu (host + creator).
hostActionMenuEl.querySelector(".host-action-move-btn").addEventListener("click", () => {
  const targetPeerId  = hostActionMenuTargetPeerId;
  const targetName    = hostActionMenuEl.querySelector(".host-action-menu-name").textContent;
  closeHostActionMenu();
  if (targetPeerId) openMoveUserModal(targetPeerId, targetName);
});


// ═══════════════════════════════════════════════════
//  RANDOM MODE — CREATOR MODERATION (modal UI)
//
//  The creator-only "★ Moderate" button opens this panel. It lists everyone
//  currently in Random (kick / ban each) plus the permanent ban list (unban).
// ═══════════════════════════════════════════════════

function hideRandomModModal() {
  if (randomModModalEl) randomModModalEl.classList.add("hidden");
}

async function openRandomModModal() {
  if (!isCreator || !randomModModalEl) return;
  randomModModalEl.classList.remove("hidden");
  randomModListEl.innerHTML = `<p class="server-list-empty">Loading people…</p>`;
  randomModBansEl.innerHTML = "";
  await refreshRandomModModal();
}

async function refreshRandomModModal() {
  if (!randomModModalEl || randomModModalEl.classList.contains("hidden")) return;
  const { users, bans } = await queryRandomPresence();
  renderRandomModList(users, bans);
}

// Reads the chosen ban length from the duration <select>. Returns the number
// of milliseconds, or null for a permanent ban.
function getSelectedBanDurationMs() {
  const selectEl = document.getElementById("random-ban-duration");
  const raw = selectEl ? selectEl.value : "permanent";
  if (raw === "permanent") return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : null;
}

function renderRandomModList(users, bans) {
  // ─── Live people (everyone but ourselves), shown with their numbers ───
  randomModListEl.innerHTML = "";
  const others = (users || []).filter(
    (user) => String(user.userNumber || "") !== userNumber
  );

  if (others.length === 0) {
    randomModListEl.innerHTML =
      `<p class="server-list-empty">No one else is in Random right now.</p>`;
  } else {
    for (const user of others) {
      const rowEl  = document.createElement("div"); rowEl.className  = "server-list-row";
      const infoEl = document.createElement("div"); infoEl.className = "server-list-info";

      const nameEl = document.createElement("div"); nameEl.className = "server-list-host";
      nameEl.textContent = user.username || "Stranger";
      const metaEl = document.createElement("div"); metaEl.className = "server-list-meta";
      metaEl.textContent = "#" + (user.userNumber || "??????");
      infoEl.append(nameEl, metaEl);

      const actionsEl = document.createElement("div");
      actionsEl.className = "random-mod-actions";

      const kickBtnEl       = document.createElement("button");
      kickBtnEl.className    = "btn btn-xs btn-secondary";
      kickBtnEl.textContent  = "Kick";
      kickBtnEl.addEventListener("click", () => kickRandomUser(user.id, user.userNumber, user.username));

      const banBtnEl       = document.createElement("button");
      banBtnEl.className    = "btn btn-xs btn-danger";
      banBtnEl.textContent  = "Ban";
      banBtnEl.addEventListener("click", () => banRandomUser(user.userNumber, user.username));

      actionsEl.append(kickBtnEl, banBtnEl);
      rowEl.append(infoEl, actionsEl);
      randomModListEl.appendChild(rowEl);
    }
  }

  // ─── Banned numbers (merge holder's view with our persisted list) ───
  const numberToUntil = new Map();
  for (const ban of [...(bans || []), ...loadRandomBans()]) {
    if (!ban || !ban.number) continue;
    const until = ban.until ?? null;
    if (!isBanActive(until)) continue;
    numberToUntil.set(String(ban.number), until);
  }

  randomModBansEl.innerHTML = "";
  if (numberToUntil.size === 0) {
    randomModBansEl.innerHTML = `<p class="server-list-empty">No banned numbers.</p>`;
    return;
  }

  for (const [number, until] of numberToUntil.entries()) {
    const rowEl  = document.createElement("div"); rowEl.className  = "server-list-row";
    const infoEl = document.createElement("div"); infoEl.className = "server-list-info";

    const nameEl = document.createElement("div"); nameEl.className = "server-list-host";
    nameEl.textContent = "#" + number;
    const metaEl = document.createElement("div"); metaEl.className = "server-list-meta";
    metaEl.textContent = until == null
      ? "permanent"
      : "frees in " + formatDuration(until - Date.now());
    infoEl.append(nameEl, metaEl);

    const unbanBtnEl       = document.createElement("button");
    unbanBtnEl.className    = "btn btn-xs btn-secondary";
    unbanBtnEl.textContent  = "Unban";
    unbanBtnEl.addEventListener("click", () => unbanRandomUser(number));

    rowEl.append(infoEl, unbanBtnEl);
    randomModBansEl.appendChild(rowEl);
  }
}

// Boots a single Random user immediately (they can rejoin straight away).
function kickRandomUser(presenceId, userNumberToKick, username) {
  sendRandomModeration({ type: "kick_random", presenceId });
  appendRandomSystemMsg(`Kicked #${userNumberToKick} (${username || "stranger"}) from Random.`);
  setTimeout(() => refreshRandomModModal(), 400);
}

// Bans a device number for the duration chosen in the dropdown (or forever),
// persists it, and pushes it to the holder for enforcement.
function banRandomUser(userNumberToBan, username) {
  const num = String(userNumberToBan || "");
  if (!num) return;
  const durationMs = getSelectedBanDurationMs();
  const until = durationMs == null ? null : Date.now() + durationMs;

  saveRandomBans([...loadRandomBans(), { number: num, until }]);
  sendRandomModeration({ type: "ban_random", userNumber: num, until });

  const howLong = until == null ? "permanently" : "for " + formatDuration(until - Date.now());
  appendRandomSystemMsg(`Banned #${num} (${username || "stranger"}) ${howLong}.`);
  setTimeout(() => refreshRandomModModal(), 400);
}

// Lifts a ban on a device number, both locally and on the registry holder.
function unbanRandomUser(userNumberToUnban) {
  const num = String(userNumberToUnban || "");
  if (!num) return;
  saveRandomBans(loadRandomBans().filter((ban) => ban.number !== num));
  sendRandomModeration({ type: "unban_random", userNumber: num });
  appendRandomSystemMsg(`Unbanned #${num}.`);
  setTimeout(() => refreshRandomModModal(), 400);
}


// ═══════════════════════════════════════════════════
//  RANDOM MODE — CREATOR MODERATION (modal controls)
// ═══════════════════════════════════════════════════
// ─── Creator moderation modal controls ─────────────
randomModBtnEl?.addEventListener("click", () => openRandomModModal());
randomModRefreshBtnEl?.addEventListener("click", () => refreshRandomModModal());
randomModCloseBtnEl?.addEventListener("click", () => hideRandomModModal());
randomModModalEl?.addEventListener("click", (e) => {
  if (e.target === randomModModalEl) hideRandomModModal();
});


// ═══════════════════════════════════════════════════
//  CREATOR BADGE — STATE HELPERS
//
//  The shared `isCreator` flag and STORAGE_KEY_CREATOR stay in main.js
//  (core features read them); these creator-only helpers + the password
//  live here. The final renderCreatorStatus() call reflects saved state on
//  load — dev.js runs right after main.js, with the DOM already parsed.
// ═══════════════════════════════════════════════════

const CREATOR_PASSWORD = "229300";

// Grants the creator badge and remembers it across sessions.
function activateCreator() {
  isCreator = true;
  localStorage.setItem(STORAGE_KEY_CREATOR, "1");
  renderCreatorStatus();
}

// Revokes the creator badge and forgets it across sessions. Also tears down
// every creator-only surface so nothing lingers once the badge is gone:
// the active-servers / move modals, the discovered recent-rooms list, and
// any join text still sitting in the input.
function deactivateCreator() {
  isCreator = false;
  localStorage.removeItem(STORAGE_KEY_CREATOR);
  renderCreatorStatus();

  hideServerListModal();
  hideMoveUserModal();
  clearAllRecentRooms();
  if (roomIdInputEl) roomIdInputEl.value = "";
}

// Shows/hides the "Creator mode active" row in the lobby based on current state.
function renderCreatorStatus() {
  const statusEl = document.getElementById("creator-status");
  if (statusEl) statusEl.classList.toggle("hidden", !isCreator);
}

// Reflect the saved creator state as soon as the page loads.
renderCreatorStatus();


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD
//
//  A fullscreen creator-only panel, opened by pressing ` (backtick) from
//  anywhere in the app. Esc or ` again closes it. The dashboard announces
//  itself to the registry as isMonitor:true so it appears in presence but is
//  excluded from matchmaking. Three panels show live Random users (with kick/
//  ban), active rooms (with join), and the ban list (with unban / clear all).
//  Data auto-refreshes every 5 seconds while open.
//
//  Moderation commands work regardless of connection state:
//    • We ARE the registry holder  → handled locally.
//    • We have a presence conn     → sent down that connection.
//    • Neither                     → a one-shot helper peer delivers the command.
// ═══════════════════════════════════════════════════

const devDashboardEl        = document.getElementById("dev-dashboard");
const devRandomListEl       = document.getElementById("dev-random-list");
const devRoomsListEl        = document.getElementById("dev-rooms-list");
const devBansListEl         = document.getElementById("dev-bans-list");
const devStatRandomCountEl  = document.getElementById("dev-stat-random-count");
const devStatRoomsCountEl   = document.getElementById("dev-stat-rooms-count");
const devStatBansCountEl    = document.getElementById("dev-stat-bans-count");
const devLastRefreshEl      = document.getElementById("dev-last-refresh");
const devDashboardRefreshEl = document.getElementById("dev-dashboard-refresh");
const devDashboardCloseEl   = document.getElementById("dev-dashboard-close");
const devClearAllBansEl     = document.getElementById("dev-clear-all-bans");
const devBanDurationEl      = document.getElementById("dev-ban-duration");

let devDashboardIsOpen = false;
// randomDashboardTimer is declared in main.js; reused here for the auto-refresh interval.

// ─── Open / close ─────────────────────────────────

async function openDevDashboard() {
  if (!isCreator) return;
  devDashboardIsOpen = true;
  devDashboardEl.classList.remove("hidden");

  // Announce to the registry as a monitor so the holder knows we're watching,
  // not a matchmaking participant. Only start a fresh presence connection if
  // we aren't already connected (e.g. the creator is also in an active Random call).
  if (!randomPresenceConn && !registryHolderPeer) {
    randomMonitorMode = true;
    randomIsDestroyed = false;
    randomUsername    = randomUsername || screenName || "Creator";
    await announceRandomPresence();
  } else {
    randomMonitorMode = true;
  }

  await refreshDevDashboard();

  if (!randomDashboardTimer) {
    randomDashboardTimer = setInterval(refreshDevDashboard, 5000);
  }
}

function closeDevDashboard() {
  devDashboardIsOpen = false;
  devDashboardEl.classList.add("hidden");

  clearInterval(randomDashboardTimer);
  randomDashboardTimer = null;

  // Only tear down the presence connection we started here; don't disconnect
  // the creator if they are also actively in a Random call.
  const isInRandomCall = !randomCallScreenEl.classList.contains("hidden");
  if (!isInRandomCall) {
    randomMonitorMode = false;
    stopRandomPresence();
    randomIsDestroyed = true;
  } else {
    randomMonitorMode = false;
  }
}

// ─── Refresh ──────────────────────────────────────

async function refreshDevDashboard() {
  if (!devDashboardIsOpen) return;
  devLastRefreshEl.textContent = "loading…";

  const [presenceResult, activeRooms] = await Promise.all([
    queryRandomPresence(),
    fetchActiveServers(),
  ]);

  const { users, bans } = presenceResult;

  renderDevRandomList(users);
  renderDevRoomsList(activeRooms);
  renderDevBansList(bans);

  const liveUserCount = (users || []).filter(user => !user.isMonitor).length;
  devStatRandomCountEl.textContent = liveUserCount;
  devStatRoomsCountEl.textContent  = (activeRooms || []).length;

  const now = new Date();
  devLastRefreshEl.textContent =
    "updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Random users panel ───────────────────────────

function renderDevRandomList(users) {
  devRandomListEl.innerHTML = "";

  const otherUsers = (users || []).filter(
    user => String(user.userNumber || "") !== userNumber
  );

  if (otherUsers.length === 0) {
    devRandomListEl.innerHTML = `<p class="dev-empty">Nobody in Random right now.</p>`;
    return;
  }

  for (const user of otherUsers) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-row";

    const infoEl = document.createElement("div");
    infoEl.className = "dev-row-info";

    const nameEl       = document.createElement("span");
    nameEl.className   = "dev-row-name";
    nameEl.textContent = user.username || "Unknown";

    const numberEl       = document.createElement("span");
    numberEl.className   = "dev-row-meta";
    numberEl.textContent = "#" + (user.userNumber || "??????");

    infoEl.append(nameEl, numberEl);

    if (user.isMonitor) {
      const pillEl       = document.createElement("span");
      pillEl.className   = "dev-pill dev-pill--monitor";
      pillEl.textContent = "monitor";
      infoEl.appendChild(pillEl);
    }

    const actionsEl = document.createElement("div");
    actionsEl.className = "dev-row-actions";

    if (!user.isMonitor) {
      const kickBtnEl       = document.createElement("button");
      kickBtnEl.className    = "btn btn-xs btn-secondary";
      kickBtnEl.textContent  = "Kick";
      kickBtnEl.addEventListener("click", () =>
        devKickUser(user.id, user.userNumber, user.username)
      );

      const banBtnEl       = document.createElement("button");
      banBtnEl.className    = "btn btn-xs btn-danger";
      banBtnEl.textContent  = "Ban";
      banBtnEl.addEventListener("click", () =>
        devBanUser(user.userNumber, user.username)
      );

      actionsEl.append(kickBtnEl, banBtnEl);
    }

    rowEl.append(infoEl, actionsEl);
    devRandomListEl.appendChild(rowEl);
  }
}

// ─── Active rooms panel ───────────────────────────

function renderDevRoomsList(rooms) {
  devRoomsListEl.innerHTML = "";

  if (!rooms || rooms.length === 0) {
    devRoomsListEl.innerHTML = `<p class="dev-empty">No active rooms right now.</p>`;
    return;
  }

  for (const room of rooms) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-row";

    const infoEl = document.createElement("div");
    infoEl.className = "dev-row-info";

    const hostEl       = document.createElement("span");
    hostEl.className   = "dev-row-name";
    hostEl.textContent = room.hostName || "Unknown host";

    const count        = room.participantCount ?? 1;
    const metaEl       = document.createElement("span");
    metaEl.className   = "dev-row-meta";
    metaEl.textContent = `${count} ${count === 1 ? "person" : "people"} · ${room.roomId}`;

    infoEl.append(hostEl, metaEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "dev-row-actions";

    const joinBtnEl       = document.createElement("button");
    joinBtnEl.className    = "btn btn-xs btn-secondary";
    joinBtnEl.textContent  = "Join";
    joinBtnEl.addEventListener("click", () => {
      closeDevDashboard();
      startJoinRoom(room.roomId);
    });

    actionsEl.appendChild(joinBtnEl);
    rowEl.append(infoEl, actionsEl);
    devRoomsListEl.appendChild(rowEl);
  }
}

// ─── Bans panel ───────────────────────────────────

function renderDevBansList(holderBans) {
  devBansListEl.innerHTML = "";

  // Merge the holder's view with the locally persisted list, deduped by number.
  const numberToUntil = new Map();
  for (const ban of [...(holderBans || []), ...loadRandomBans()]) {
    if (!ban || !ban.number) continue;
    const until = ban.until ?? null;
    if (!isBanActive(until)) continue;
    numberToUntil.set(String(ban.number), until);
  }

  devStatBansCountEl.textContent = numberToUntil.size;

  if (numberToUntil.size === 0) {
    devBansListEl.innerHTML = `<p class="dev-empty">No active bans.</p>`;
    return;
  }

  for (const [number, until] of numberToUntil.entries()) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-row";

    const infoEl = document.createElement("div");
    infoEl.className = "dev-row-info";

    const numEl       = document.createElement("span");
    numEl.className   = "dev-row-name";
    numEl.textContent = "#" + number;

    const expiryEl       = document.createElement("span");
    expiryEl.className   = "dev-row-meta";
    expiryEl.textContent = until == null
      ? "permanent"
      : "expires in " + formatDuration(until - Date.now());

    infoEl.append(numEl, expiryEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "dev-row-actions";

    const unbanBtnEl       = document.createElement("button");
    unbanBtnEl.className    = "btn btn-xs btn-secondary";
    unbanBtnEl.textContent  = "Unban";
    unbanBtnEl.addEventListener("click", () => devUnbanUser(number));

    actionsEl.appendChild(unbanBtnEl);
    rowEl.append(infoEl, actionsEl);
    devBansListEl.appendChild(rowEl);
  }
}

// ─── Moderation helpers ───────────────────────────

// Delivers a moderation command to the registry regardless of this client's
// current connection state, using a one-shot helper peer when necessary.
async function sendDashboardModeration(message) {
  if (registryHolderPeer) {
    handleRegistryMessage(null, message);
    return;
  }
  if (randomPresenceConn) {
    try { randomPresenceConn.send(message); } catch (_) {}
    return;
  }
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return;
  const conn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, REGISTRY_QUERY_TIMEOUT);
    conn.on("open", () => {
      try { conn.send(message); } catch (_) {}
      clearTimeout(timeout);
      setTimeout(resolve, 300);
    });
    conn.on("error", () => { clearTimeout(timeout); resolve(); });
  });
  try { helperPeer.destroy(); } catch (_) {}
}

function devGetBanUntil() {
  const value = devBanDurationEl ? devBanDurationEl.value : "permanent";
  if (value === "permanent") return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60000 : null;
}

function devKickUser(presenceId, kickedUserNumber, username) {
  sendDashboardModeration({ type: "kick_random", presenceId });
  setTimeout(refreshDevDashboard, 600);
}

function devBanUser(bannedUserNumber, username) {
  const num = String(bannedUserNumber || "");
  if (!num) return;
  const until = devGetBanUntil();
  saveRandomBans([...loadRandomBans(), { number: num, until }]);
  sendDashboardModeration({ type: "ban_random", userNumber: num, until });
  setTimeout(refreshDevDashboard, 600);
}

function devUnbanUser(unbannedUserNumber) {
  const num = String(unbannedUserNumber || "");
  if (!num) return;
  saveRandomBans(loadRandomBans().filter(ban => ban.number !== num));
  sendDashboardModeration({ type: "unban_random", userNumber: num });
  setTimeout(refreshDevDashboard, 600);
}

function devClearAllBans() {
  for (const ban of loadRandomBans()) {
    sendDashboardModeration({ type: "unban_random", userNumber: ban.number });
  }
  saveRandomBans([]);
  setTimeout(refreshDevDashboard, 600);
}

// ─── Event listeners ──────────────────────────────

devDashboardRefreshEl?.addEventListener("click", () => refreshDevDashboard());
devDashboardCloseEl?.addEventListener("click",   () => closeDevDashboard());
devClearAllBansEl?.addEventListener("click",     () => devClearAllBans());

// Backtick (`) opens the dashboard; Esc or another backtick closes it.
// Guard: do not fire while the user is typing in an input/textarea/select.
document.addEventListener("keydown", (e) => {
  if (e.key !== "`") return;
  const focusedTag = document.activeElement?.tagName?.toLowerCase();
  if (focusedTag === "input" || focusedTag === "textarea" || focusedTag === "select") return;
  e.preventDefault();
  devDashboardIsOpen ? closeDevDashboard() : openDevDashboard();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && devDashboardIsOpen) closeDevDashboard();
});
