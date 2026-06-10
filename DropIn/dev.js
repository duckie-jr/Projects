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
const devStatBansCountEl       = document.getElementById("dev-stat-bans-count");
const devStatRoomsTodayEl      = document.getElementById("dev-stat-rooms-today");
const devStatPeakConcurrentEl  = document.getElementById("dev-stat-peak-concurrent");
const devStatTotalBansEl       = document.getElementById("dev-stat-total-bans");
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

  const platformStats = await queryPlatformStats();
  const formatStat = (val) => val == null ? "—" : String(val);
  if (devStatRoomsTodayEl)     devStatRoomsTodayEl.textContent     = formatStat(platformStats.roomsCreatedToday);
  if (devStatPeakConcurrentEl) devStatPeakConcurrentEl.textContent = formatStat(platformStats.peakConcurrentUsers);
  if (devStatTotalBansEl)      devStatTotalBansEl.textContent      = formatStat(platformStats.totalBansIssued);

  const now = new Date();
  devLastRefreshEl.textContent =
    "updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Random users panel ───────────────────────────

function renderDevRandomList(users) {
  devRandomListEl.innerHTML = "";

  const devFilterInput = document.getElementById("dev-random-filter");
  const devFilterText  = (devFilterInput?.value ?? "").trim().toLowerCase().replace(/^#/, "");

  const otherUsers = (users || []).filter((user) => {
    if (String(user.userNumber || "") === String(userNumber)) return false;
    if (!devFilterText) return true;
    return (
      String(user.userNumber || "").includes(devFilterText) ||
      (user.username || "").toLowerCase().includes(devFilterText)
    );
  });

  if (otherUsers.length === 0) {
    devRandomListEl.innerHTML = `<p class="dev-empty">Nobody in Random right now.</p>`;
    return;
  }

  for (const user of otherUsers) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-row";

    const infoEl = document.createElement("div");
    infoEl.className = "dev-row-info";

    // User number is the persistent admin-facing ID — show it first
    const numberEl       = document.createElement("span");
    numberEl.className   = "dev-row-name dev-uid-badge";
    numberEl.textContent = "#" + (user.userNumber || "??????");

    const nameEl         = document.createElement("span");
    nameEl.className     = "dev-row-meta";
    nameEl.textContent   = user.username || "Unknown";

    infoEl.append(numberEl, nameEl);

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

        const reloadUserBtnEl      = document.createElement("button");
        reloadUserBtnEl.className   = "btn btn-xs btn-secondary";
        reloadUserBtnEl.textContent = "⟳";
        reloadUserBtnEl.title       = "Force-reload this client";
        reloadUserBtnEl.addEventListener("click", () => forceReloadRandomUser(user.id));

        actionsEl.append(reloadUserBtnEl, kickBtnEl, banBtnEl);
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

    const observeBtnEl       = document.createElement("button");
    observeBtnEl.className    = "btn btn-xs btn-primary";
    observeBtnEl.textContent  = "👁 Observe";
    observeBtnEl.title        = "Join invisibly — participants cannot see you";
    observeBtnEl.addEventListener("click", () => ghostJoinRoom(room.roomId));

    const joinBtnEl       = document.createElement("button");
    joinBtnEl.className    = "btn btn-xs btn-secondary";
    joinBtnEl.textContent  = "Join";
    joinBtnEl.addEventListener("click", () => {
      closeDevDashboard();
      startJoinRoom(room.roomId);
    });

    const closeBtnEl       = document.createElement("button");
    closeBtnEl.className    = "btn btn-xs btn-danger";
    closeBtnEl.textContent  = "⛔ Close";
    closeBtnEl.title        = "Force-close room — kicks every participant";
    closeBtnEl.addEventListener("click", () => {
      const count = room.participantCount ?? 1;
      if (confirm(`Force-close room "${room.roomId}" and disconnect all ${count} participant${count !== 1 ? "s" : ""}?`)) {
        forceCloseRoom(room.roomId);
      }
    });

    actionsEl.append(observeBtnEl, joinBtnEl, closeBtnEl);
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


// ═══════════════════════════════════════════════════
//  GHOST OBSERVER — STATE
//
//  The ghost observer is a hidden PeerJS peer that joins a room, receives
//  every participant's audio/video stream, but never appears in anyone's
//  participant list or video grid. Users consent to this in the ToS.
//
//  How it works:
//    1. We create a new PeerJS peer (ghostObserverPeer) and connect to the
//       room host via a data channel, sending { type: "ghost_hello" }.
//    2. The host validates our CREATOR_PASSWORD token, adds us to
//       ghostObserverPeerIds, notifies all guests with
//       { type: "ghost_observer_joining" }, then replies with
//       { type: "ghost_approved", users: [...] }.
//    3. We call each participant with a silent stream so they send us their
//       streams back. Their handleIncomingCall checks ghostObserverPeerIds
//       and silently answers without adding a video tile.
//    4. We display all received streams in the ghost observer panel overlay.
// ═══════════════════════════════════════════════════

let ghostObserverPeer     = null;
let ghostObserverDataConn = null;
const ghostObserverCallMap = new Map();  // targetPeerId → PeerJS Call

// Creates a MediaStream with one silent audio track so PeerJS can build a
// valid WebRTC offer. Without at least one track, some browsers refuse to
// create a media connection at all.
function createSilentMediaStream() {
  const audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
  const gainNode    = audioCtx.createGain();
  gainNode.gain.value = 0;  // completely silent
  const destination = audioCtx.createMediaStreamDestination();
  gainNode.connect(destination);
  return destination.stream;
}

function setGhostObserverStatus(message) {
  const statusEl = document.getElementById('ghost-observer-status');
  if (statusEl) statusEl.textContent = message;
}

function addGhostObserverTile(peerId, username, stream) {
  const gridEl = document.getElementById('ghost-observer-grid');
  if (!gridEl || gridEl.querySelector(`[data-peer-id="${peerId}"]`)) return;

  const tileEl = document.createElement('div');
  tileEl.className = 'ghost-observer-tile';
  tileEl.dataset.peerId = peerId;

  const hasVideo = stream.getVideoTracks().length > 0;

  if (hasVideo) {
    const videoEl = document.createElement('video');
    videoEl.srcObject  = stream;
    videoEl.autoplay   = true;
    videoEl.playsInline = true;
    videoEl.muted      = false;  // creator should hear participants
    tileEl.appendChild(videoEl);
  } else {
    // Audio-only participant — show an avatar placeholder
    const audioEl = document.createElement('audio');
    audioEl.srcObject = stream;
    audioEl.autoplay  = true;
    tileEl.appendChild(audioEl);

    const avatarEl = document.createElement('div');
    avatarEl.className   = 'ghost-observer-avatar';
    avatarEl.textContent = username.charAt(0).toUpperCase();
    tileEl.appendChild(avatarEl);
  }

  const labelEl = document.createElement('div');
  labelEl.className   = 'ghost-observer-label';
  labelEl.textContent = username;
  tileEl.appendChild(labelEl);

  const actionsBarEl = document.createElement('div');
  actionsBarEl.className = 'ghost-observer-actions';

  const muteTileBtn     = document.createElement('button');
  muteTileBtn.className   = 'btn btn-xs btn-secondary';
  muteTileBtn.textContent = '🔇 Mute';
  muteTileBtn.addEventListener('click', () => requestGhostModeration('mute', peerId));

  const reloadTileBtn     = document.createElement('button');
  reloadTileBtn.className   = 'btn btn-xs btn-secondary';
  reloadTileBtn.textContent = '⟳ Reload';
  reloadTileBtn.addEventListener('click', () => requestGhostModeration('reload', peerId));

  const kickTileBtn     = document.createElement('button');
  kickTileBtn.className   = 'btn btn-xs btn-secondary';
  kickTileBtn.textContent = '👟 Kick';
  kickTileBtn.addEventListener('click', () => requestGhostModeration('kick', peerId));

  const banTileBtn     = document.createElement('button');
  banTileBtn.className   = 'btn btn-xs btn-danger';
  banTileBtn.textContent = '⛔ Ban';
  banTileBtn.addEventListener('click', () => {
    if (confirm('Ban ' + username + ' from this room?')) requestGhostModeration('ban', peerId);
  });

  actionsBarEl.append(muteTileBtn, reloadTileBtn, kickTileBtn, banTileBtn);
  tileEl.appendChild(actionsBarEl);

  gridEl.appendChild(tileEl);
  setGhostObserverStatus('');
}

function removeGhostObserverTile(peerId) {
  document.querySelector(`#ghost-observer-grid [data-peer-id="${peerId}"]`)?.remove();
}

function closeGhostObserver() {
  // Close every media call we opened
  for (const call of ghostObserverCallMap.values()) {
    try { call.close(); } catch (_) {}
  }
  ghostObserverCallMap.clear();

  // Close the data connection to the host
  try { ghostObserverDataConn?.close(); } catch (_) {}
  ghostObserverDataConn = null;

  // Destroy the ghost peer entirely
  try { ghostObserverPeer?.destroy(); } catch (_) {}
  ghostObserverPeer = null;

  // Hide and clear the panel
  const panelEl = document.getElementById('ghost-observer-panel');
  if (panelEl) panelEl.classList.add('hidden');
  const gridEl = document.getElementById('ghost-observer-grid');
  if (gridEl) gridEl.innerHTML = '';
  setGhostObserverStatus('');
}

async function ghostJoinRoom(roomId) {
  if (!isCreator) return;

  // Close any existing ghost session before starting a new one
  closeGhostObserver();
  closeDevDashboard();

  // Show the observer panel early so the creator sees loading feedback
  const panelEl = document.getElementById('ghost-observer-panel');
  document.getElementById('ghost-observer-room-id').textContent = roomId;
  panelEl.classList.remove('hidden');
  setGhostObserverStatus('Connecting to room…');

  // Create the ghost peer
  ghostObserverPeer = createPeer();
  const peerReady = await new Promise((resolve) => {
    ghostObserverPeer.once('open',  () => resolve(true));
    ghostObserverPeer.once('error', () => resolve(false));
  });

  if (!peerReady) {
    setGhostObserverStatus('Could not create observer peer. Check your connection and try again.');
    try { ghostObserverPeer.destroy(); } catch (_) {}
    ghostObserverPeer = null;
    return;
  }

  // Connect to the room host via data channel
  ghostObserverDataConn = ghostObserverPeer.connect(roomId, { reliable: true });

  const approvedPayload = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    ghostObserverDataConn.on('open', () => {
      ghostObserverDataConn.send({ type: 'ghost_hello', ghostToken: CREATOR_PASSWORD });
    });
    ghostObserverDataConn.on('data',  (msg) => {
      if (msg.type === 'ghost_approved') finish(msg);
    });
    ghostObserverDataConn.on('error', () => finish(null));
    ghostObserverDataConn.on('close', () => finish(null));
    setTimeout(() => finish(null), 6000);
  });

  if (!approvedPayload) {
    setGhostObserverStatus('Ghost join rejected or timed out. The room may not support this feature yet.');
    return;
  }

  const roomUsers = approvedPayload.users || [];

  if (roomUsers.length === 0) {
    setGhostObserverStatus('Room is empty.');
    return;
  }

  setGhostObserverStatus(`Connecting to ${roomUsers.length} participant${roomUsers.length !== 1 ? 's' : ''}…`);

  // Brief delay so ghost_observer_joining messages can reach all guests before
  // we start dialling — prevents the rare race where a participant answers
  // before they know to suppress the tile.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const silentStream = createSilentMediaStream();

  for (const user of roomUsers) {
    // Skip ourselves if we somehow appear in the list
    if (user.peerId === ghostObserverPeer.id) continue;

    const call = ghostObserverPeer.call(user.peerId, silentStream);
    ghostObserverCallMap.set(user.peerId, call);

    call.on('stream', (remoteStream) => {
      addGhostObserverTile(user.peerId, user.username, remoteStream);
    });

    call.on('close', () => {
      removeGhostObserverTile(user.peerId);
      ghostObserverCallMap.delete(user.peerId);
      if (ghostObserverCallMap.size === 0) {
        setGhostObserverStatus('All participants have left.');
      }
    });
  }

  setGhostObserverStatus('');
}


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — FORCE CLOSE ROOM
//
//  Connects a one-shot helper peer to the target room's host and sends
//  { type: "creator_force_close" }. The host notifies all guests and
//  tears itself down. No need to join or observe first.
// ═══════════════════════════════════════════════════

async function forceCloseRoom(roomId) {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) {
    alert("Could not reach the room. It may have already closed.");
    return;
  }

  const conn = helperPeer.connect(roomId, { reliable: true });

  await new Promise((resolve) => {
    const timeout = setTimeout(() => { resolve(); }, 4000);
    conn.on("open", () => {
      conn.send({ type: "creator_force_close", ghostToken: CREATOR_PASSWORD });
      clearTimeout(timeout);
      // Allow time for the message to arrive before destroying the helper
      setTimeout(resolve, 800);
    });
    conn.on("error", () => { clearTimeout(timeout); resolve(); });
  });

  try { helperPeer.destroy(); } catch (_) {}
  // Refresh the rooms list after giving guests time to disconnect
  setTimeout(() => refreshDevDashboard(), 2500);
}


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — BROADCAST TO ALL ROOMS
//
//  Iterates every active room in the registry, connects a helper peer to
//  each host, and sends { type: "creator_broadcast", text }. Each host
//  relays the message to its guests as a system_broadcast.
// ═══════════════════════════════════════════════════

function setDevBroadcastStatus(message) {
  const statusEl = document.getElementById("dev-broadcast-status");
  if (statusEl) statusEl.textContent = message;
}

async function broadcastToAllRooms(messageText) {
  const trimmedText = messageText.trim();
  if (!trimmedText) return;

  const activeRooms = await fetchActiveServers();
  if (activeRooms.length === 0) {
    setDevBroadcastStatus("No active rooms to broadcast to.");
    return;
  }

  setDevBroadcastStatus(`Sending to ${activeRooms.length} room${activeRooms.length !== 1 ? "s" : ""}…`);

  let successCount = 0;
  for (const room of activeRooms) {
    const helperPeer = await createHelperPeer();
    if (!helperPeer) continue;

    const conn = helperPeer.connect(room.roomId, { reliable: true });
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(); }, 3500);
      conn.on("open", () => {
        conn.send({ type: "creator_broadcast", ghostToken: CREATOR_PASSWORD, text: trimmedText });
        clearTimeout(timeout);
        setTimeout(resolve, 500);
        successCount++;
      });
      conn.on("error", () => { clearTimeout(timeout); resolve(); });
    });
    try { helperPeer.destroy(); } catch (_) {}
  }

  setDevBroadcastStatus(
    successCount === activeRooms.length
      ? `✓ Sent to all ${successCount} room${successCount !== 1 ? "s" : ""}.`
      : `Sent to ${successCount} / ${activeRooms.length} rooms.`
  );

  // Auto-clear the status after a few seconds
  setTimeout(() => setDevBroadcastStatus(""), 4000);
}


// ═══════════════════════════════════════════════════
//  GHOST OBSERVER — IN-PANEL MODERATION
// ═══════════════════════════════════════════════════

function requestGhostModeration(action, targetPeerId) {
  if (!ghostObserverDataConn) return;
  try {
    ghostObserverDataConn.send({
      type:       "ghost_moderation",
      action,
      targetPeerId,
      ghostToken: CREATOR_PASSWORD,
    });
  } catch (_) {}
}


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — FORCE RELOAD
// ═══════════════════════════════════════════════════

function forceReloadRandomUser(presenceId) {
  sendDashboardModeration({ type: "reload_random", presenceId });
}

async function forceReloadAllClients() {
  const reloadAllBtnEl = document.getElementById("dev-reload-all-btn");
  if (reloadAllBtnEl) { reloadAllBtnEl.disabled = true; reloadAllBtnEl.textContent = "Reloading…"; }

  const [activeRooms, presenceResult] = await Promise.all([
    fetchActiveServers(),
    queryRandomPresence(),
  ]);

  for (const room of activeRooms) {
    const helperPeer = await createHelperPeer();
    if (!helperPeer) continue;
    const conn = helperPeer.connect(room.roomId, { reliable: true });
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3500);
      conn.on("open", () => {
        conn.send({ type: "creator_force_reload", ghostToken: CREATOR_PASSWORD });
        clearTimeout(timeout);
        setTimeout(resolve, 400);
      });
      conn.on("error", () => { clearTimeout(timeout); resolve(); });
    });
    try { helperPeer.destroy(); } catch (_) {}
  }

  for (const user of (presenceResult.users || [])) {
    if (String(user.userNumber || "") === String(userNumber)) continue;
    forceReloadRandomUser(user.id);
  }

  if (reloadAllBtnEl) {
    reloadAllBtnEl.textContent = "⟳ Reload All";
    setTimeout(() => { reloadAllBtnEl.disabled = false; }, 3000);
  }
}

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

// Ghost observer panel — close button
document.getElementById('ghost-observer-close-btn')?.addEventListener('click', () => {
  closeGhostObserver();
});

// ─── Broadcast panel ──────────────────────────────
const devBroadcastBtnEl   = document.getElementById("dev-broadcast-btn");
const devBroadcastInputEl = document.getElementById("dev-broadcast-input");

devBroadcastBtnEl?.addEventListener("click", async () => {
  const text = devBroadcastInputEl?.value ?? "";
  if (!text.trim()) { setDevBroadcastStatus("Type a message first."); return; }
  devBroadcastBtnEl.disabled    = true;
  devBroadcastBtnEl.textContent = "Sending…";
  await broadcastToAllRooms(text);
  devBroadcastBtnEl.disabled    = false;
  devBroadcastBtnEl.textContent = "Send to All";
  if (devBroadcastInputEl) devBroadcastInputEl.value = "";
});

devBroadcastInputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") devBroadcastBtnEl?.click();
});

// ─── Force Reload All ─────────────────────────────
document.getElementById("dev-reload-all-btn")?.addEventListener("click", () => forceReloadAllClients());

// ─── Random user search filter ────────────────────
document.getElementById("dev-random-filter")?.addEventListener("input", () => {
  if (devDashboardIsOpen) refreshDevDashboard();
});


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — POP-OUT WINDOW
//
//  Opens the dashboard in a standalone browser window so it doesn't sit on
//  top of the main app. The new window loads the same page; the #devpopout
//  hash signals it to auto-open the dashboard. localStorage carries the
//  creator badge automatically (same origin, same storage).
// ═══════════════════════════════════════════════════

function popOutDevDashboard() {
  const baseUrl = window.location.href.split('#')[0];
  const popoutUrl = baseUrl + '#devpopout';
  window.open(
    popoutUrl,
    'dropin-dev-dashboard',
    'width=1380,height=860,menubar=no,toolbar=no,location=no,status=no,scrollbars=yes'
  );
}

document.getElementById("dev-popout-btn")?.addEventListener("click", () => {
  popOutDevDashboard();
});

// Auto-open the dashboard when this page was launched via the pop-out button.
// isCreator is already set from localStorage at this point (main.js ran first).
if (window.location.hash === '#devpopout' && isCreator) {
  // Small delay to let the rest of the scripts finish initialising.
  setTimeout(() => openDevDashboard(), 200);
}
