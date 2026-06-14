// ═══════════════════════════════════════════════════
//  dev.js — CREATOR / DEVELOPER-ONLY UI
//
//  Loaded as a classic (non-module) <script defer> after rooms.js in
//  index.html.  For the future standalone dev control panel (dev/index.html),
//  load these files first so every symbol this file needs is available:
//
//    1. PeerJS CDN  (window.Peer)
//    2. main.js     → createPeer, PEER_OPTIONS,
//                     REGISTRY_PEER_ID, REGISTRY_QUERY_TIMEOUT,
//                     registryHolderPeer, isCreator, STORAGE_KEY_CREATOR,
//                     currentRoomId
//    3. rooms.js    → fetchActiveServers, createHelperPeer,
//                     handleRegistryMessage
//
//  All cross-file references are resolved at call time (inside event
//  handlers and functions), so load order is safe as long as the three
//  files above are deferred before this one.
//
//  Sections:
//    • Creator badge modal (password prompt)
//    • Active-servers list modal
//    • Move participant modal
//    • Creator badge state helpers (activateCreator / deactivateCreator)
//    • Dev dashboard (open/close, refresh, rooms panel)
//    • Ghost observer (invisible join, whisper mode, moderation)
//    • Force-close room
//    • Broadcast to all rooms / single room
//    • Prank audio — air horn (local + network)
//    • Ghost observer in-panel moderation
//    • Pull-to-room, force-reload
//    • Pop-out window
// ═══════════════════════════════════════════════════

//  CREATOR BADGE — MODAL
// ═══════════════════════════════════════════════════

const creatorModalEl          = document.getElementById("creator-modal");
const creatorEmailInputEl     = document.getElementById("creator-email-input");
const creatorPasswordInputEl  = document.getElementById("creator-password-input");
const creatorConfirmInputEl   = document.getElementById("creator-confirm-input");
const creatorPasswordErrorEl  = document.getElementById("creator-password-error");
const creatorPasswordSubmitEl = document.getElementById("creator-password-submit");
const creatorPasswordCancelEl = document.getElementById("creator-password-cancel");

const STORAGE_KEY_DEV_EMAIL = "coterie_dev_email";

function showCreatorModal() {
  const savedEmail  = localStorage.getItem(STORAGE_KEY_DEV_EMAIL) ?? "";
  const isReturning = savedEmail.length > 0;

  // Pre-fill the email so returning devs don't have to retype it.
  if (creatorEmailInputEl)   creatorEmailInputEl.value   = savedEmail;
  creatorPasswordInputEl.value                           = "";
  if (creatorConfirmInputEl) creatorConfirmInputEl.value = "";
  creatorPasswordErrorEl.textContent = "";

  // Update the description to reflect first-time vs returning sign-in.
  const descEl = document.getElementById("creator-modal-desc");
  if (descEl) {
    descEl.textContent = isReturning
      ? `Welcome back, ${savedEmail}. Enter your password to continue.`
      : "First time here? Choose your dev email and enter the password to register this device.";
  }

  creatorModalEl.classList.remove("hidden");
  // Focus password directly for returning users since email is already filled.
  setTimeout(() => (isReturning ? creatorPasswordInputEl : creatorEmailInputEl)?.focus(), 50);
}

function hideCreatorModal() {
  creatorModalEl.classList.add("hidden");
}

function _renderDevSignedInEmail() {
  const emailEl    = document.getElementById("dev-signed-in-email");
  const savedEmail = localStorage.getItem(STORAGE_KEY_DEV_EMAIL) ?? "";
  if (!emailEl) return;
  emailEl.textContent = savedEmail;
  emailEl.classList.toggle("hidden", !savedEmail);
}

creatorPasswordSubmitEl.addEventListener("click", () => {
  const email    = (creatorEmailInputEl?.value ?? "").trim();
  const password = creatorPasswordInputEl.value;
  const confirm  = creatorConfirmInputEl?.value ?? "";

  if (!email || !email.includes("@") || !email.includes(".")) {
    creatorPasswordErrorEl.textContent = "Enter a valid email address.";
    creatorEmailInputEl?.focus();
    return;
  }
  if (password !== CREATOR_PASSWORD) {
    creatorPasswordErrorEl.textContent = "Incorrect password.";
    creatorPasswordInputEl.select();
    return;
  }
  if (confirm !== CREATOR_PASSWORD) {
    creatorPasswordErrorEl.textContent = "Confirm code does not match.";
    creatorConfirmInputEl?.select();
    return;
  }

  // If an account was already registered on this device, reject a different email.
  const existingEmail = localStorage.getItem(STORAGE_KEY_DEV_EMAIL);
  if (existingEmail && existingEmail !== email) {
    creatorPasswordErrorEl.textContent = `This device is registered to ${existingEmail}. Use that email to sign in.`;
    creatorEmailInputEl?.select();
    return;
  }

  localStorage.setItem(STORAGE_KEY_DEV_EMAIL, email);
  hideCreatorModal();
  activateCreator();
  _renderDevSignedInEmail();
});

creatorPasswordCancelEl.addEventListener("click", hideCreatorModal);

[creatorEmailInputEl, creatorPasswordInputEl, creatorConfirmInputEl].forEach((inputEl) => {
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  creatorPasswordSubmitEl.click();
    if (e.key === "Escape") hideCreatorModal();
  });
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
    hostNameEl.textContent  = server.roomName || server.hostName || "Unnamed room";

    const metaEl       = document.createElement("div");
    metaEl.className    = "server-list-meta";
    const count        = server.participantCount ?? 1;
    metaEl.textContent  = `${count} ${count === 1 ? "person" : "people"} · ${server.roomId} · hosted by ${server.hostName || "Unknown"}`;

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
    hostNameEl.textContent = server.roomName || server.hostName || "Unnamed room";
    const metaEl      = document.createElement("div");
    metaEl.className   = "server-list-meta";
    const count       = server.participantCount ?? 1;
    metaEl.textContent = `${count} ${count === 1 ? "person" : "people"} · ${server.roomId} · hosted by ${server.hostName || "Unknown"}`;
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
//  CREATOR BADGE — STATE HELPERS
//
//  The shared `isCreator` flag and STORAGE_KEY_CREATOR are defined earlier
//  in this file. The final renderCreatorStatus() call reflects saved state
//  on load.
// ═══════════════════════════════════════════════════

const CREATOR_PASSWORD = "229300";

// Grants the creator badge and remembers it across sessions.
function activateCreator() {
  isCreator = true;
  localStorage.setItem(STORAGE_KEY_CREATOR, "1");
  setLobbyStatus("Creator badge activated!");
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
// On the standalone dev page (identified by the presence of #dp-verify-btn),
// also gates the entire dashboard — auto-opens on login, closes on revocation.
function renderCreatorStatus() {
  const creatorStatusEl = document.getElementById("creator-status");
  if (creatorStatusEl) creatorStatusEl.classList.toggle("hidden", !isCreator);

  _renderDevSignedInEmail();

  const devVerifyBtnEl = document.getElementById("dp-verify-btn");
  if (!devVerifyBtnEl) return;  // not on the dev page — nothing else to do

  devVerifyBtnEl.classList.toggle("hidden", isCreator);

  if (isCreator) {
    if (!devDashboardIsOpen) openDevDashboard();
  } else {
    closeDevDashboard();
    // Re-prompt immediately so the page is never usable without a valid credential.
    showCreatorModal();
  }
}

// NOTE: renderCreatorStatus() is called after devDashboardEl and devDashboardIsOpen
// are declared below — calling it here would trigger a TDZ ReferenceError because
// those const/let bindings haven't been initialised yet.

// "Dashboard" button in the main-app creator-status row — navigates to the
// standalone dev control panel instead of opening an in-page overlay.
document.getElementById("creator-monitor-btn")?.addEventListener("click", () => {
  window.location.href = "./Dev/";
});


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD
//
//  A fullscreen creator-only panel, opened by pressing ` (backtick) from
//  anywhere in the app. Esc or ` again closes it. Shows active rooms with
//  join/observe/close actions, plus broadcast tools.
//  Data auto-refreshes every 5 seconds while open.
// ═══════════════════════════════════════════════════

const devDashboardEl        = document.getElementById("dev-dashboard");
const devRoomsListEl        = document.getElementById("dev-rooms-list");
const devStatRoomsCountEl   = document.getElementById("dev-stat-rooms-count");
const devStatRoomsTodayEl      = document.getElementById("dev-stat-rooms-today");
const devStatPeakConcurrentEl  = document.getElementById("dev-stat-peak-concurrent");
const devStatTotalBansEl       = document.getElementById("dev-stat-total-bans");
const devLastRefreshEl      = document.getElementById("dev-last-refresh");
const devDashboardRefreshEl = document.getElementById("dev-dashboard-refresh");
const devDashboardCloseEl   = document.getElementById("dev-dashboard-close");
const devClearAllBansEl     = document.getElementById("dev-clear-all-bans");


// ─── Event log ────────────────────────────────────────────────────────────────
//
//  appendEventLog() is called from dev-bootstrap.js (for registry events) and
//  from this file (for broadcasts, moderation, observer actions).

const MAX_LOG_ENTRIES  = 300;
const eventLogEntries  = [];  // { category, message, timestamp }

function appendEventLog(category, message) {
  eventLogEntries.unshift({ category, message, timestamp: Date.now() });
  if (eventLogEntries.length > MAX_LOG_ENTRIES) eventLogEntries.length = MAX_LOG_ENTRIES;
  renderEventLog();
}

// Active filter chip selection: "all" | "broadcast" | "mod" | "rooms" | "watchlist"
let activeLogFilter = "all";

function _matchesLogFilter(entry) {
  switch (activeLogFilter) {
    case "broadcast":  return entry.category === "broadcast";
    case "mod":        return entry.category.startsWith("mod-");
    case "rooms":      return entry.category.includes("room") || entry.category === "registry" || entry.category === "observer";
    case "watchlist":  return entry.category === "watchlist";
    default:           return true;  // "all"
  }
}

function renderEventLog() {
  const logListEl = document.getElementById("dev-log-list");
  if (!logListEl) return;

  const filteredEntries = eventLogEntries.filter(_matchesLogFilter);

  if (filteredEntries.length === 0) {
    logListEl.innerHTML = eventLogEntries.length === 0
      ? '<p class="dev-empty">No events yet — waiting for registry activity…</p>'
      : '<p class="dev-empty">No events match this filter.</p>';
    return;
  }

  logListEl.innerHTML = "";
  for (const entry of filteredEntries) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-log-row dev-log-row--" + entry.category;

    const timeEl       = document.createElement("span");
    timeEl.className   = "dev-log-time";
    timeEl.textContent = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const msgEl       = document.createElement("span");
    msgEl.className   = "dev-log-message";
    msgEl.textContent = entry.message;

    rowEl.append(timeEl, msgEl);
    logListEl.appendChild(rowEl);
  }
}

document.getElementById("dev-log-clear-btn")?.addEventListener("click", () => {
  eventLogEntries.length = 0;
  renderEventLog();
});

document.getElementById("dev-log-export-btn")?.addEventListener("click", () => {
  const lines = eventLogEntries.map(entry =>
    new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    + "  [" + entry.category + "]  " + entry.message
  );
  const blob   = new Blob([lines.join("\n")], { type: "text/plain" });
  const anchor = document.createElement("a");
  anchor.href     = URL.createObjectURL(blob);
  anchor.download = "coterie-event-log-" + new Date().toISOString().slice(0, 10) + ".txt";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

// Log filter chip clicks.
document.querySelector(".dev-log-filter")?.addEventListener("click", (clickEvent) => {
  const chip = clickEvent.target.closest(".dev-log-chip");
  if (!chip) return;
  activeLogFilter = chip.dataset.filter ?? "all";
  document.querySelectorAll(".dev-log-chip").forEach((chipEl) => {
    chipEl.classList.toggle("dev-log-chip--active", chipEl.dataset.filter === activeLogFilter);
  });
  renderEventLog();
});

// Shared AudioContext primed when the dashboard is opened (user-gesture context).
// Reusing it lets playAirHornLocally work from async callbacks and network messages
// where no fresh user gesture is present.
let dashboardAudioCtx   = null;
let devDashboardIsOpen      = false;
let devDashboardRefreshTimer = null;  // auto-refresh interval for the dashboard

// Now that devDashboardEl and devDashboardIsOpen are initialised, it is safe to
// call renderCreatorStatus(). On the dev page this auto-opens the dashboard (if
// already a creator) or shows the login modal (if not). On the main app it just
// shows/hides the creator-status bar, which is the same as before.
renderCreatorStatus();

// ─── Open / close ─────────────────────────────────

async function openDevDashboard() {
  if (!isCreator) return;

  // ── Prime audio while still inside the user-gesture handler ──────────────
  // AudioContext must be created/resumed synchronously during a user gesture;
  // any code after the first 'await' loses that privilege.
  if (!dashboardAudioCtx || dashboardAudioCtx.state === 'closed') {
    dashboardAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (dashboardAudioCtx.state === 'suspended') dashboardAudioCtx.resume();
  devDashboardIsOpen = true;
  devDashboardEl.classList.remove("hidden");

  await refreshDevDashboard();
  _restartAutoRefreshTimer();

  // Activate the rooms tab when opening.
  activateDashboardTab('rooms');
}

// ─── Auto-refresh helpers ─────────────────────────────────────────────────────

function _getAutoRefreshIntervalMs() {
  const selectEl = document.getElementById("dev-autorefresh-interval");
  return (parseInt(selectEl?.value ?? "5") || 5) * 1000;
}

function _restartAutoRefreshTimer() {
  if (devDashboardRefreshTimer) {
    clearInterval(devDashboardRefreshTimer);
    devDashboardRefreshTimer = null;
  }
  const toggleEl = document.getElementById("dev-autorefresh-toggle");
  if ((toggleEl?.checked ?? true) && devDashboardIsOpen) {
    devDashboardRefreshTimer = setInterval(refreshDevDashboard, _getAutoRefreshIntervalMs());
  }
}

document.getElementById("dev-autorefresh-toggle")?.addEventListener("change", _restartAutoRefreshTimer);
document.getElementById("dev-autorefresh-interval")?.addEventListener("change", () => {
  if (devDashboardIsOpen) _restartAutoRefreshTimer();
});

// Switches the visible panel by toggling dev-panel--active and dev-tab--active.
// Works on mobile (tab bar visible) and is a no-op on desktop (panels all shown).
function activateDashboardTab(targetTabName) {
  const allPanels = document.querySelectorAll('.dev-panel[data-tab]');
  const allTabs   = document.querySelectorAll('.dev-tab');

  for (const panelEl of allPanels) {
    panelEl.classList.toggle('dev-panel--active', panelEl.dataset.tab === targetTabName);
  }
  for (const tabEl of allTabs) {
    tabEl.classList.toggle('dev-tab--active', tabEl.dataset.target === targetTabName);
  }
}

function closeDevDashboard() {
  devDashboardIsOpen = false;
  devDashboardEl.classList.add("hidden");

  if (devDashboardRefreshTimer) {
    clearInterval(devDashboardRefreshTimer);
    devDashboardRefreshTimer = null;
  }
}

// ─── Refresh ──────────────────────────────────────

async function refreshDevDashboard() {
  if (!devDashboardIsOpen) return;
  devLastRefreshEl.textContent = "loading…";

  const activeRooms = await fetchActiveServers();

  devRoomsListEl._cachedRooms = activeRooms;
  renderDevRoomsList(activeRooms);
  devStatRoomsCountEl.textContent = (activeRooms || []).length;

  const platformStats = await queryPlatformStats();
  const formatStat = (val) => val == null ? "—" : String(val);
  if (devStatRoomsTodayEl)     devStatRoomsTodayEl.textContent     = formatStat(platformStats.roomsCreatedToday);
  if (devStatPeakConcurrentEl) devStatPeakConcurrentEl.textContent = formatStat(platformStats.peakConcurrentUsers);
  if (devStatTotalBansEl)      devStatTotalBansEl.textContent      = formatStat(platformStats.totalBansIssued);

  _checkWatchlistHits(activeRooms);

  const now = new Date();
  devLastRefreshEl.textContent =
    "updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}


// ─── Active rooms panel ───────────────────────────

function renderDevRoomsList(rooms) {
  devRoomsListEl.innerHTML = "";
  // Cache so the search filter can re-render without a full network refresh.
  devRoomsListEl._lastRooms = rooms;

  const filterInput = document.getElementById("dev-rooms-filter");
  const filterText  = (filterInput?.value ?? "").trim().toLowerCase().replace(/^#/, "");

  if (!rooms || rooms.length === 0) {
    devRoomsListEl.innerHTML = `<p class="dev-empty">No active rooms right now.</p>`;
    return;
  }

  // ── Search mode: flat view of participants matching the typed name / ID ───
  if (filterText) {
    let anyMatch = false;
    for (const room of rooms) {
      const matchingParticipants = (room.participants ?? []).filter(p =>
        String(p.userNumber || "").includes(filterText) ||
        (p.username || "").toLowerCase().includes(filterText)
      );
      if (matchingParticipants.length === 0) continue;
      anyMatch = true;

      const findHeaderEl       = document.createElement("div");
      findHeaderEl.className   = "dev-room-find-header";
      findHeaderEl.textContent = (room.roomName || room.hostName || "Unnamed") + "  ·  " + room.roomId;
      devRoomsListEl.appendChild(findHeaderEl);

      for (const participant of matchingParticipants) {
        const rowEl     = document.createElement("div"); rowEl.className     = "dev-row dev-row--indented";
        const infoEl    = document.createElement("div"); infoEl.className    = "dev-row-info";
        const nameEl    = document.createElement("span"); nameEl.className   = "dev-row-name"; nameEl.textContent = participant.username || "Unknown";
        const numEl     = document.createElement("span"); numEl.className    = "dev-row-meta"; numEl.textContent  = participant.userNumber ? "#" + participant.userNumber : "no ID";
        infoEl.append(nameEl, numEl);

        const actionsEl = document.createElement("div"); actionsEl.className = "dev-row-actions";

        if (participant.userNumber) {
          const copyIdBtnEl      = document.createElement("button");
          copyIdBtnEl.className   = "btn btn-xs btn-secondary";
          copyIdBtnEl.textContent = "Copy ID";
          const numForCopy = participant.userNumber;
          copyIdBtnEl.addEventListener("click", () => {
            navigator.clipboard.writeText(numForCopy);
            copyIdBtnEl.textContent = "Copied!";
            setTimeout(() => { copyIdBtnEl.textContent = "Copy ID"; }, 1500);
          });
          actionsEl.appendChild(copyIdBtnEl);
        }

        const observeRoomBtnEl      = document.createElement("button");
        observeRoomBtnEl.className   = "btn btn-xs btn-primary";
        observeRoomBtnEl.textContent = "Observe Room";
        const roomIdForObserve = room.roomId;
        observeRoomBtnEl.addEventListener("click", () => ghostJoinRoom(roomIdForObserve));
        actionsEl.appendChild(observeRoomBtnEl);

        rowEl.append(infoEl, actionsEl);
        devRoomsListEl.appendChild(rowEl);
      }
    }
    if (!anyMatch) {
      devRoomsListEl.innerHTML = `<p class="dev-empty">No participants match that ID or name.</p>`;
    }
    return;
  }

  // ── Normal mode: one card per room with inline participant list ───────────
  for (const room of rooms) {
    const roomWrapEl     = document.createElement("div");
    roomWrapEl.className = "dev-room-wrap";

    // Room header row
    const rowEl     = document.createElement("div"); rowEl.className     = "dev-row";
    const infoEl    = document.createElement("div"); infoEl.className    = "dev-row-info";
    const hostEl    = document.createElement("span"); hostEl.className   = "dev-row-name"; hostEl.textContent = room.roomName || room.hostName || "Unnamed room";
    const count     = room.participantCount ?? 1;
    const metaEl    = document.createElement("span"); metaEl.className   = "dev-row-meta";
    metaEl.textContent = count + " " + (count === 1 ? "person" : "people") + " · " + room.roomId + " · hosted by " + (room.hostName || "Unknown");
    infoEl.append(hostEl, metaEl);

    const actionsEl = document.createElement("div"); actionsEl.className = "dev-row-actions";

    const observeBtnEl = document.createElement("button");
    observeBtnEl.className = "btn btn-xs btn-primary"; observeBtnEl.textContent = "Observe";
    observeBtnEl.title = "Join invisibly — participants cannot see you";
    const roomIdO = room.roomId;
    observeBtnEl.addEventListener("click", () => ghostJoinRoom(roomIdO));

    const joinBtnEl = document.createElement("button");
    joinBtnEl.className = "btn btn-xs btn-secondary"; joinBtnEl.textContent = "Join";
    const roomIdJ = room.roomId;
    joinBtnEl.addEventListener("click", () => { closeDevDashboard(); startJoinRoom(roomIdJ); });

    const closeBtnEl = document.createElement("button");
    closeBtnEl.className = "btn btn-xs btn-danger"; closeBtnEl.textContent = "Close";
    closeBtnEl.title = "Force-close room — kicks every participant";
    const roomIdC = room.roomId; const countC = room.participantCount ?? 1;
    closeBtnEl.addEventListener("click", () => {
      if (confirm("Force-close room and disconnect all " + countC + " participant" + (countC !== 1 ? "s" : "") + "?")) {
        forceCloseRoom(roomIdC);
      }
    });

    const copyRoomIdBtnEl       = document.createElement("button");
    copyRoomIdBtnEl.className    = "btn btn-xs btn-muted";
    copyRoomIdBtnEl.textContent  = "Copy ID";
    copyRoomIdBtnEl.title        = "Copy Room ID to clipboard";
    const roomIdForCopy = room.roomId;
    copyRoomIdBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(roomIdForCopy);
      copyRoomIdBtnEl.textContent = "Copied!";
      setTimeout(() => { copyRoomIdBtnEl.textContent = "Copy ID"; }, 1500);
    });

    // ── Copy join-link button ──────────────────────────────────────────────
    const copyLinkBtnEl      = document.createElement("button");
    copyLinkBtnEl.className   = "btn btn-xs btn-muted";
    copyLinkBtnEl.textContent = "Copy Link";
    copyLinkBtnEl.title       = "Copy a shareable join link for this room";
    const roomIdForLink = room.roomId;
    copyLinkBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const joinUrl = window.location.origin + "/?room=" + encodeURIComponent(roomIdForLink);
      navigator.clipboard.writeText(joinUrl);
      copyLinkBtnEl.textContent = "Copied!";
      setTimeout(() => { copyLinkBtnEl.textContent = "Copy Link"; }, 1500);
    });

    // ── Rename button with inline edit flow ───────────────────────────────
    const renameBtnEl      = document.createElement("button");
    renameBtnEl.className   = "btn btn-xs btn-muted";
    renameBtnEl.textContent = "Rename";
    renameBtnEl.title       = "Update this room's display name";
    const roomIdForRename   = room.roomId;

    renameBtnEl.addEventListener("click", async (e) => {
      e.stopPropagation();

      const currentName    = hostEl.textContent;
      const renameInputEl  = document.createElement("input");
      renameInputEl.type      = "text";
      renameInputEl.className = "dev-rename-input";
      renameInputEl.value     = currentName;
      renameInputEl.maxLength = 40;

      hostEl.replaceWith(renameInputEl);
      renameBtnEl.style.display = "none";
      renameInputEl.focus();
      renameInputEl.select();

      const saveBtnEl   = document.createElement("button");
      saveBtnEl.className   = "btn btn-xs btn-primary";
      saveBtnEl.textContent = "✓";
      saveBtnEl.title       = "Save";

      const cancelBtnEl   = document.createElement("button");
      cancelBtnEl.className   = "btn btn-xs btn-secondary";
      cancelBtnEl.textContent = "✗";
      cancelBtnEl.title       = "Cancel";

      actionsEl.prepend(cancelBtnEl);
      actionsEl.prepend(saveBtnEl);

      const cancelRename = () => {
        saveBtnEl.remove();
        cancelBtnEl.remove();
        renameInputEl.replaceWith(hostEl);
        renameBtnEl.style.display = "";
      };

      const confirmRename = async () => {
        const newName = renameInputEl.value.trim();
        saveBtnEl.remove();
        cancelBtnEl.remove();
        hostEl.textContent = newName || currentName;
        renameInputEl.replaceWith(hostEl);
        renameBtnEl.style.display = "";

        if (!newName || newName === currentName) return;

        const helperPeer = await createHelperPeer();
        if (!helperPeer) return;
        const conn = helperPeer.connect(roomIdForRename, { reliable: true });
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 3500);
          conn.on("open", () => {
            conn.send({ type: "creator_rename_room", roomId: roomIdForRename, newName, ghostToken: CREATOR_PASSWORD });
            clearTimeout(timeout);
            setTimeout(resolve, 400);
          });
          conn.on("error", () => { clearTimeout(timeout); resolve(); });
        });
        try { helperPeer.destroy(); } catch (_) {}
        appendEventLog("room-renamed", `Renamed ${roomIdForRename} → "${newName}"`);
        setTimeout(() => refreshDevDashboard(), 800);
      };

      saveBtnEl.addEventListener("click",   confirmRename);
      cancelBtnEl.addEventListener("click", cancelRename);
      renameInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter")  confirmRename();
        if (e.key === "Escape") cancelRename();
      });
    });

    actionsEl.append(copyRoomIdBtnEl, copyLinkBtnEl, renameBtnEl, observeBtnEl, joinBtnEl, closeBtnEl);
    rowEl.append(infoEl, actionsEl);
    roomWrapEl.appendChild(rowEl);

    // ── Participant sub-list ──────────────────────────────────────────────
    const participants = room.participants ?? [];
    if (participants.length > 0) {
      const participantsContainerEl = document.createElement("div");
      participantsContainerEl.className = "dev-room-participants";

      for (const participant of participants) {
        const pRowEl     = document.createElement("div"); pRowEl.className = "dev-room-participant-row";
        const pNameEl    = document.createElement("span"); pNameEl.className = "dev-room-participant-name"; pNameEl.textContent = participant.username || "Unknown";
        const pActionsEl = document.createElement("div"); pActionsEl.className = "dev-room-participant-actions";

        if (participant.userNumber) {
          const numBadgeEl       = document.createElement("span");
          numBadgeEl.className   = "dev-room-participant-number";
          numBadgeEl.textContent = "#" + participant.userNumber;

          const copyIdBtnEl      = document.createElement("button");
          copyIdBtnEl.className   = "btn btn-xs btn-secondary";
          copyIdBtnEl.textContent = "Copy ID";
          const numForCopy2 = participant.userNumber;
          copyIdBtnEl.addEventListener("click", () => {
            navigator.clipboard.writeText(numForCopy2);
            copyIdBtnEl.textContent = "Copied!";
            setTimeout(() => { copyIdBtnEl.textContent = "Copy ID"; }, 1500);
          });

          pActionsEl.append(numBadgeEl, copyIdBtnEl);
        } else {
          const noIdEl = document.createElement("span"); noIdEl.className = "dev-row-meta"; noIdEl.textContent = "no ID";
          pActionsEl.appendChild(noIdEl);
        }

        pRowEl.append(pNameEl, pActionsEl);
        participantsContainerEl.appendChild(pRowEl);
      }
      roomWrapEl.appendChild(participantsContainerEl);
    }

    devRoomsListEl.appendChild(roomWrapEl);
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

// ─── Event listeners ──────────────────────────────

devDashboardRefreshEl?.addEventListener('click', () => refreshDevDashboard());

// Re-render rooms list when the search filter changes (no network request needed).
document.getElementById("dev-rooms-filter")?.addEventListener("input", () => {
  if (devDashboardIsOpen) renderDevRoomsList(devRoomsListEl._lastRooms ?? []);
});


devDashboardCloseEl?.addEventListener('click',   () => closeDevDashboard());

// Tab bar — delegate tap events to activateDashboardTab.
document.querySelector('.dev-tab-bar')?.addEventListener('click', (e) => {
  const clickedTab = e.target.closest('.dev-tab');
  if (clickedTab?.dataset.target) activateDashboardTab(clickedTab.dataset.target);
});


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

let ghostObserverAllMuted = false;  // master mute state for the observer grid

// ─── Whisper mode — lets the observer speak to selected participants ──────────
//  The ghost calls each participant with a silent stream. When whisper is
//  toggled on for a peer, we replace the outgoing audio track in that specific
//  WebRTC sender with a real microphone track. Participants hear the voice but
//  see no new tile and have no way to identify the source.
let ghostObserverMicStream      = null;   // real mic stream, acquired on demand
let ghostObserverMicAudioTrack  = null;   // the live mic track (shared across whisper targets)
const ghostObserverWhisperPeerIds = new Set();  // peerIds currently receiving live audio

// Acquires the microphone once and caches the track. Returns null on failure.
async function acquireGhostMicForWhisper() {
  // Discard a cached track that has ended — the OS kills getUserMedia tracks
  // when the tab is backgrounded on mobile (iOS Safari, Android Chrome).
  if (ghostObserverMicAudioTrack && ghostObserverMicAudioTrack.readyState === 'ended') {
    ghostObserverMicAudioTrack = null;
    if (ghostObserverMicStream) {
      ghostObserverMicStream.getTracks().forEach(track => track.stop());
      ghostObserverMicStream = null;
    }
  }
  if (ghostObserverMicAudioTrack) return ghostObserverMicAudioTrack;
  try {
    ghostObserverMicStream     = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    ghostObserverMicAudioTrack = ghostObserverMicStream.getAudioTracks()[0] ?? null;
    return ghostObserverMicAudioTrack;
  } catch (_) {
    setGhostObserverStatus('Microphone access denied — cannot use whisper mode.');
    return null;
  }
}

// Stops the mic track and frees the microphone device when no one is whispered.
function releaseGhostMicIfUnused() {
  if (ghostObserverWhisperPeerIds.size > 0) return;
  if (ghostObserverMicStream) {
    ghostObserverMicStream.getTracks().forEach(track => track.stop());
    ghostObserverMicStream = null;
  }
  ghostObserverMicAudioTrack = null;
}

// Replaces the outgoing audio track on the ghost observer's call to peerId.
// The ghost called the participant with a silent stream, so there should always
// be exactly one audio sender on the RTCPeerConnection.
// Returns true if the track was successfully replaced, false otherwise.
async function replaceGhostCallAudioTrack(peerId, newAudioTrack) {
  const call = ghostObserverCallMap.get(peerId);
  if (!call) {
    console.warn('[whisper] no ghost call for peer', peerId);
    return false;
  }

  // PeerJS v1.5.x exposes the underlying RTCPeerConnection as .peerConnection.
  // Fall back to private field names used in some builds.
  const pc = call.peerConnection ?? call._peerConnection ?? call._pc;
  if (!pc) {
    console.warn('[whisper] no RTCPeerConnection for peer', peerId);
    return false;
  }

  const senders = pc.getSenders();
  // Find the audio sender. After replaceTrack(null) the sender track is null,
  // so we also accept null-track senders to handle the restore-silence case.
  const audioSender = senders.find(
    s => s.track?.kind === 'audio' || s.track === null
  );

  if (!audioSender) {
    console.warn('[whisper] no audio sender for', peerId,
      '— senders:', senders.length, senders.map(s => s.track?.kind ?? 'null'));
    return false;
  }

  let succeeded = false;
  await audioSender.replaceTrack(newAudioTrack ?? null)
    .then(() => { succeeded = true; })
    .catch(err => { console.warn('[whisper] replaceTrack failed for', peerId, err); });
  return succeeded;
}

// Toggles whisper on/off for one participant tile. Updates the button visually.
async function toggleGhostWhisperForPeer(peerId, whisperBtnEl) {
  if (ghostObserverWhisperPeerIds.has(peerId)) {
    // Disable: restore the one persistent silent track.
    ghostObserverWhisperPeerIds.delete(peerId);
    await replaceGhostCallAudioTrack(peerId, getOrCreateGhostSilentTrack());
    whisperBtnEl.textContent = '🎤 Whisper';
    whisperBtnEl.classList.remove('btn-primary');
    whisperBtnEl.classList.add('btn-secondary');
    releaseGhostMicIfUnused();
  } else {
    // Enable: acquire mic (or re-acquire if track ended) then send it to this peer.
    const micTrack = await acquireGhostMicForWhisper();
    if (!micTrack) return;
    // Only mark as whispering after confirming replaceTrack actually succeeded.
    const replaced = await replaceGhostCallAudioTrack(peerId, micTrack);
    if (!replaced) {
      setGhostObserverStatus('Whisper failed — could not reach WebRTC sender. Check DevTools console.');
      return;
    }
    ghostObserverWhisperPeerIds.add(peerId);
    whisperBtnEl.textContent = '🎤 Whispering…';
    whisperBtnEl.classList.remove('btn-secondary');
    whisperBtnEl.classList.add('btn-primary');
  }
  // Keep the Whisper All button in sync.
  syncWhisperAllButton();
}

// Toggles whisper for ALL currently observed participants at once.
async function toggleGhostWhisperAll() {
  const allPeerIds       = [...ghostObserverCallMap.keys()];
  const allWhispering    = allPeerIds.length > 0 &&
    allPeerIds.every(peerId => ghostObserverWhisperPeerIds.has(peerId));

  if (allWhispering) {
    // Turn whisper off for everyone.
    for (const peerId of allPeerIds) {
      if (!ghostObserverWhisperPeerIds.has(peerId)) continue;
      ghostObserverWhisperPeerIds.delete(peerId);
      await replaceGhostCallAudioTrack(peerId, getOrCreateGhostSilentTrack());
      updateTileWhisperButton(peerId, false);
    }
    releaseGhostMicIfUnused();
  } else {
    // Turn whisper on for everyone not yet whispering.
    const micTrack = await acquireGhostMicForWhisper();
    if (!micTrack) return;
    for (const peerId of allPeerIds) {
      if (ghostObserverWhisperPeerIds.has(peerId)) continue;
      ghostObserverWhisperPeerIds.add(peerId);
      await replaceGhostCallAudioTrack(peerId, micTrack);
      updateTileWhisperButton(peerId, true);
    }
  }
  syncWhisperAllButton();
}

// Updates the per-tile whisper button label and style for a given peerId.
function updateTileWhisperButton(peerId, isWhispering) {
  const tileEl = document.querySelector(`#ghost-observer-grid [data-peer-id="${peerId}"]`);
  const whisperBtnEl = tileEl?.querySelector('.ghost-whisper-btn');
  if (!whisperBtnEl) return;
  whisperBtnEl.textContent = isWhispering ? '🎤 Whispering…' : '🎤 Whisper';
  whisperBtnEl.classList.toggle('btn-primary',   isWhispering);
  whisperBtnEl.classList.toggle('btn-secondary', !isWhispering);
}

// Syncs the "Whisper All" header button to reflect current state.
function syncWhisperAllButton() {
  const whisperAllBtnEl = document.getElementById('ghost-observer-whisper-all-btn');
  if (!whisperAllBtnEl) return;
  const allPeerIds    = [...ghostObserverCallMap.keys()];
  const allWhispering = allPeerIds.length > 0 &&
    allPeerIds.every(peerId => ghostObserverWhisperPeerIds.has(peerId));
  whisperAllBtnEl.textContent = allWhispering ? '🎤 Stop Whispering' : '🎤 Whisper All';
  whisperAllBtnEl.classList.toggle('btn-primary',   allWhispering);
  whisperAllBtnEl.classList.toggle('btn-secondary', !allWhispering);
}

// Module-level AudioContext and track for the ghost observer's silent stream.
// Storing both at module level prevents garbage collection from killing the track
// and avoids the bug of spawning a new oscillator on every replaceTrack() call.
let ghostSilentAudioCtx = null;
let ghostSilentTrack    = null;  // single reused track — never recreated mid-session

// Returns the one persistent live-but-silent MediaStreamTrack for the observer
// session. Creates it (along with its AudioContext) on first call and reuses it
// for every subsequent whisper-off replaceTrack call.
// Using a single track per session means the WebRTC sender always has the same
// track object and replaceTrack operates predictably.
function getOrCreateGhostSilentTrack() {
  if (ghostSilentTrack && ghostSilentTrack.readyState === 'live') {
    return ghostSilentTrack;
  }

  if (!ghostSilentAudioCtx || ghostSilentAudioCtx.state === 'closed') {
    ghostSilentAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ghostSilentAudioCtx.state === 'suspended') ghostSilentAudioCtx.resume();

  const oscillator = ghostSilentAudioCtx.createOscillator();
  const silentGain = ghostSilentAudioCtx.createGain();
  silentGain.gain.value = 0;  // completely inaudible
  oscillator.connect(silentGain);
  const destination = ghostSilentAudioCtx.createMediaStreamDestination();
  silentGain.connect(destination);
  oscillator.start();  // runs indefinitely; stopped only when the ctx is closed

  ghostSilentTrack = destination.stream.getAudioTracks()[0];
  return ghostSilentTrack;
}

// Wraps the persistent silent track in a fresh MediaStream for use as the initial
// call stream. Using the same underlying track is intentional — the RTCPeerConnection
// sender points at this one track for the entire session.
function createSilentMediaStream() {
  return new MediaStream([getOrCreateGhostSilentTrack()]);
}

function setGhostObserverStatus(message) {
  const statusEl = document.getElementById('ghost-observer-status');
  if (statusEl) statusEl.textContent = message;
}

function addGhostObserverTile(peerId, username, persistentUserNumber, stream) {
  const gridEl = document.getElementById('ghost-observer-grid');
  if (!gridEl || gridEl.querySelector(`[data-peer-id="${peerId}"]`)) return;

  const tileEl = document.createElement('div');
  tileEl.className = 'ghost-observer-tile';
  tileEl.dataset.peerId = peerId;

  const hasVideo = stream.getVideoTracks().length > 0;

  // primaryMediaEl is the video or audio element — used by the local audio toggle.
  let primaryMediaEl = null;

  if (hasVideo) {
    const videoEl = document.createElement('video');
    videoEl.srcObject   = stream;
    videoEl.autoplay    = true;
    videoEl.playsInline = true;
    // Start unmuted so the observer hears audio by default.
    // If master mute is active, honour it immediately.
    videoEl.muted       = ghostObserverAllMuted;
    primaryMediaEl = videoEl;
    tileEl.appendChild(videoEl);
  } else {
    // Audio-only participant — show an avatar placeholder.
    const audioEl = document.createElement('audio');
    audioEl.srcObject = stream;
    audioEl.autoplay  = true;
    audioEl.muted     = ghostObserverAllMuted;
    primaryMediaEl = audioEl;
    tileEl.appendChild(audioEl);

    const avatarEl = document.createElement('div');
    avatarEl.className   = 'ghost-observer-avatar';
    avatarEl.textContent = username.charAt(0).toUpperCase();
    tileEl.appendChild(avatarEl);
  }

  const labelEl = document.createElement('div');
  labelEl.className   = 'ghost-observer-label';
  labelEl.textContent = username;
  if (persistentUserNumber) {
    const numSpanEl       = document.createElement('span');
    numSpanEl.className   = 'ghost-observer-user-number';
    numSpanEl.textContent = ' #' + persistentUserNumber;
    labelEl.appendChild(numSpanEl);
  }
  tileEl.appendChild(labelEl);

  const actionsBarEl = document.createElement('div');
  actionsBarEl.className = 'ghost-observer-actions';

  // ── Whisper toggle — sends creator's live mic audio to this participant only ──
  const whisperBtnEl     = document.createElement('button');
  whisperBtnEl.className   = 'btn btn-xs btn-secondary ghost-whisper-btn';
  whisperBtnEl.textContent = '🎤 Whisper';
  whisperBtnEl.title       = 'Send your mic audio to this participant only — they cannot see who is speaking';
  whisperBtnEl.addEventListener('click', () => toggleGhostWhisperForPeer(peerId, whisperBtnEl));

  // ── Local audio toggle — only affects what the observer hears ──
  const localAudioBtnEl     = document.createElement('button');
  localAudioBtnEl.className   = 'btn btn-xs btn-secondary';
  localAudioBtnEl.textContent = ghostObserverAllMuted ? 'Unmute Audio' : 'Mute Audio';
  localAudioBtnEl.classList.toggle('btn-muted', ghostObserverAllMuted);
  localAudioBtnEl.title       = 'Toggle audio from this participant (only affects you)';
  localAudioBtnEl.addEventListener('click', () => {
    primaryMediaEl.muted          = !primaryMediaEl.muted;
    localAudioBtnEl.textContent   = primaryMediaEl.muted ? 'Unmute Audio' : 'Mute Audio';
    localAudioBtnEl.classList.toggle('btn-muted', primaryMediaEl.muted);
  });

  // ── Remote moderation buttons ──
  const muteTileBtn     = document.createElement('button');
  muteTileBtn.className   = 'btn btn-xs btn-secondary';
  muteTileBtn.textContent = 'Mute';
  muteTileBtn.title       = 'Mute this participant\'s microphone for everyone';
  muteTileBtn.addEventListener('click', () => requestGhostModeration('mute', peerId));

  const reloadTileBtn     = document.createElement('button');
  reloadTileBtn.className   = 'btn btn-xs btn-secondary';
  reloadTileBtn.textContent = 'Reload';
  reloadTileBtn.addEventListener('click', () => requestGhostModeration('reload', peerId));

  const kickTileBtn     = document.createElement('button');
  kickTileBtn.className   = 'btn btn-xs btn-secondary';
  kickTileBtn.textContent = 'Kick';
  kickTileBtn.addEventListener('click', () => requestGhostModeration('kick', peerId));

  const banTileBtn     = document.createElement('button');
  banTileBtn.className   = 'btn btn-xs btn-danger';
  banTileBtn.textContent = 'Ban';
  banTileBtn.addEventListener('click', () => {
    if (confirm('Ban ' + username + ' from this room?')) requestGhostModeration('ban', peerId);
  });

  actionsBarEl.append(whisperBtnEl, localAudioBtnEl, muteTileBtn, reloadTileBtn, kickTileBtn, banTileBtn);
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

  // Release the mic if whisper mode was active
  ghostObserverWhisperPeerIds.clear();
  releaseGhostMicIfUnused();

  // Release the persistent silent AudioContext and track reference
  if (ghostSilentAudioCtx) {
    try { ghostSilentAudioCtx.close(); } catch (_) {}
    ghostSilentAudioCtx = null;
  }
  ghostSilentTrack = null;

  // Reset master mute state so the next session starts unmuted
  ghostObserverAllMuted = false;
  const muteAllBtnEl = document.getElementById('ghost-observer-mute-all-btn');
  if (muteAllBtnEl) {
    muteAllBtnEl.textContent = 'Mute All';
    muteAllBtnEl.classList.remove('btn-muted');
  }

  // Reset Whisper All button
  const whisperAllBtnEl = document.getElementById('ghost-observer-whisper-all-btn');
  if (whisperAllBtnEl) {
    whisperAllBtnEl.textContent = '🎤 Whisper All';
    whisperAllBtnEl.classList.remove('btn-primary');
    whisperAllBtnEl.classList.add('btn-secondary');
  }

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
  appendEventLog("observer", `Ghost observer joined room ${roomId}`);

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
  // Map peerId to permanent userNumber so tiles can show it.
  const peerIdToUserNum = new Map(roomUsers.map(u => [u.peerId, u.userNumber ?? ""]));

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
      addGhostObserverTile(user.peerId, user.username, peerIdToUserNum.get(user.peerId) ?? "", remoteStream);
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

// ─── Force-close a single room ───────────────────────────────────────────────
//
//  Three-stage shutdown — works even if the host never responds:
//    1. Registry removal (instant, no rooms.js needed) — room vanishes from
//       every browser's room list and can't be rediscovered.
//    2. Blocked list entry — the registry refuses any heartbeat from this
//       roomId for 10 minutes so it can't come back on its own.
//    3. Peer-level close signal to the host — rooms.js uses this to kick guests.

async function forceCloseRoom(roomId) {
  // ── Stage 1 & 2: registry annihilation ──────────────────────────────────
  let roomLabel = roomId;
  if (registryHolderPeer) {
    const entry = registeredServers.get(roomId);
    if (entry) {
      roomLabel = entry.roomName || entry.hostName || roomId;
      registeredServers.delete(roomId);
      blockedRoomIds.set(roomId, Date.now() + 10 * 60 * 1000);  // block for 10 min
      appendEventLog("room-closed", `Admin shut down "${roomLabel}" (${roomId}) — removed from registry`);
      refreshDevDashboard();
    }
  } else {
    // Not the holder — send unregister to whoever holds the registry
    const unregHelper = await createHelperPeer();
    if (unregHelper) {
      const conn = unregHelper.connect(REGISTRY_PEER_ID, { reliable: true });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        conn.on("open", () => {
          conn.send({ type: "unregister_room", roomId });
          clearTimeout(t); setTimeout(resolve, 200);
        });
        conn.on("error", () => { clearTimeout(t); resolve(); });
      });
      try { unregHelper.destroy(); } catch (_) {}
    }
    appendEventLog("room-closed", `Admin shut down room ${roomId}`);
  }

  // ── Stage 3: signal the host peer directly ───────────────────────────────
  const hostHelper = await createHelperPeer();
  if (hostHelper) {
    const conn = hostHelper.connect(roomId, { reliable: true });
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 4000);
      conn.on("open", () => {
        conn.send({ type: "creator_force_close", ghostToken: CREATOR_PASSWORD });
        clearTimeout(timeout);
        setTimeout(resolve, 800);
      });
      conn.on("error", () => { clearTimeout(timeout); resolve(); });
    });
    try { hostHelper.destroy(); } catch (_) {}
  }

  setTimeout(() => refreshDevDashboard(), 2000);
}


// Shut down every currently active room in one call.
async function shutdownAllRooms() {
  const activeRooms = await fetchActiveServers();
  if (activeRooms.length === 0) { appendEventLog("room-closed", "Shutdown All: no active rooms."); return; }
  appendEventLog("room-closed", `Admin SHUTDOWN ALL — closing ${activeRooms.length} room${activeRooms.length !== 1 ? "s" : ""}…`);
  for (const room of activeRooms) {
    await forceCloseRoom(room.roomId);
  }
  appendEventLog("room-closed", "Shutdown All complete.");
  refreshDevDashboard();
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

// Send to every active room, showing a mandatory-view overlay on each client.
async function broadcastToAllRooms(messageText, dismissAfterSeconds = 0) {
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
        conn.send({ type: "creator_broadcast", ghostToken: CREATOR_PASSWORD, text: trimmedText, dismissAfterSeconds });
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
      ? `Sent to all ${successCount} room${successCount !== 1 ? "s" : ""}.`
      : `Sent to ${successCount} / ${activeRooms.length} rooms.`
  );

  setTimeout(() => setDevBroadcastStatus(""), 4000);
}

// Send to a single room by ID.
async function broadcastToRoom(roomId, messageText, dismissAfterSeconds = 0) {
  const trimmedRoomId = (roomId ?? "").trim();
  const trimmedText   = (messageText ?? "").trim();
  if (!trimmedRoomId || !trimmedText) return;

  setDevBroadcastStatus(`Sending to room ${trimmedRoomId}…`);

  const helperPeer = await createHelperPeer();
  if (!helperPeer) {
    setDevBroadcastStatus("Could not connect — room may be offline.");
    setTimeout(() => setDevBroadcastStatus(""), 4000);
    return;
  }

  const conn = helperPeer.connect(trimmedRoomId, { reliable: true });
  let sent = false;

  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 3500);
    conn.on("open", () => {
      conn.send({ type: "creator_broadcast", ghostToken: CREATOR_PASSWORD, text: trimmedText, dismissAfterSeconds });
      clearTimeout(timeout);
      sent = true;
      setTimeout(resolve, 400);
    });
    conn.on("error", () => { clearTimeout(timeout); resolve(); });
  });

  try { helperPeer.destroy(); } catch (_) {}
  setDevBroadcastStatus(sent ? "Sent to room." : "Could not reach room — it may be offline.");
  setTimeout(() => setDevBroadcastStatus(""), 4000);
}


// ═══════════════════════════════════════════════════
//  PRANK AUDIO — AIR HORN + DISPATCH
//
//  playAirHornLocally() synthesises a loud air horn using the Web Audio API.
//  handlePrankAction() dispatches network-delivered prank messages to the
//  correct local handler. Both are called by main.js when prank payloads
//  arrive from the network, so they must exist in the shared global scope.
// ═══════════════════════════════════════════════════

// Synthesises and plays an air horn locally using the shared dashboardAudioCtx.
// Using a pre-primed shared context (initialised on dashboard open, a user gesture)
// means this works even when called from async callbacks or network messages where
// the browser's autoplay policy would block creating a fresh AudioContext.
async function playAirHornLocally() {
  try {
    // Use the best already-running AudioContext to avoid autoplay blocks.
    // Guests receive the prank via a network callback — no user-gesture context —
    // so new AudioContext() there is silently blocked by the browser.
    //  1. dashboardAudioCtx   — primed when creator opened the dashboard.
    //  2. audioContextInstance — main.js speaking-indicator context; already live
    //     for every room participant once their first video/audio tile appears.
    //     This is the key fallback for guests who never opened the dashboard.
    //  3. Last resort: create a new one (works if page had any prior user input).
    let audioCtx = (dashboardAudioCtx && dashboardAudioCtx.state !== 'closed')
      ? dashboardAudioCtx
      : (typeof audioContextInstance !== 'undefined'
          && audioContextInstance
          && audioContextInstance.state !== 'closed')
        ? audioContextInstance
        : null;
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      dashboardAudioCtx = audioCtx;
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(1.0, now + 0.02);
    masterGain.gain.setValueAtTime(1.0, now + 0.55);
    masterGain.gain.linearRampToValueAtTime(0, now + 0.75);

    // Three detuned sawtooth oscillators — classic air-horn chord A♭/E♭/A♭
    [[233, 0.7], [311, 0.5], [466, 0.35]].forEach(([baseFrequency, relativeVolume]) => {
      const oscillator = audioCtx.createOscillator();
      const oscGain    = audioCtx.createGain();
      oscillator.type = 'sawtooth';
      // Start ~4% sharp then glide down for realism
      oscillator.frequency.setValueAtTime(baseFrequency * 1.04, now);
      oscillator.frequency.exponentialRampToValueAtTime(baseFrequency, now + 0.12);
      oscGain.gain.value = relativeVolume;
      oscillator.connect(oscGain);
      oscGain.connect(masterGain);
      oscillator.start(now);
      oscillator.stop(now + 0.75);
    });

    // Disconnect the master gain after playback to free node references.
    // We do NOT close the AudioContext — it is shared and reused.
    setTimeout(() => { try { masterGain.disconnect(); } catch (_) {} }, 1000);
  } catch (audioError) {
    console.warn('Air horn audio failed:', audioError);
  }
}

// Dispatches a prank action received from the network to its local handler.
function handlePrankAction(action) {
  if (action === 'air_horn') playAirHornLocally();
}

// ═══════════════════════════════════════════════════
//  GHOST OBSERVER — AIR HORN
//
//  Sends a ghost_prank message to the host via the existing data connection.
//  The host relays { type: "prank", action: "air_horn" } to all guests and
//  plays it locally. The observer also hears it immediately.
// ═══════════════════════════════════════════════════

function sendGhostAirHorn() {
  if (!ghostObserverDataConn) {
    setGhostObserverStatus('Not connected to a room — cannot send air horn.');
    return;
  }
  try {
    ghostObserverDataConn.send({
      type:       'ghost_prank',
      action:     'air_horn',
      ghostToken: CREATOR_PASSWORD,
    });
  } catch (_) {}
  // Observer hears it too.
  playAirHornLocally();
}


// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — AIR HORN (no active ghost session)
//
//  Connects a one-shot helper peer to each target room and sends
//  { type: "creator_prank", action: "air_horn" }. The host relays it
//  to guests and plays it locally. Works identically to broadcastToAllRooms.
// ═══════════════════════════════════════════════════

function setDevPrankStatus(message) {
  const statusEl = document.getElementById('dev-prank-status');
  if (statusEl) statusEl.textContent = message;
}

// Sends the air horn to a single room by ID via a helper peer.
async function sendAirHornToRoomById(roomId) {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return false;
  const conn = helperPeer.connect(roomId, { reliable: true });
  let delivered = false;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3500);
    conn.on('open', () => {
      conn.send({ type: 'creator_prank', action: 'air_horn', ghostToken: CREATOR_PASSWORD });
      clearTimeout(timeout);
      delivered = true;
      setTimeout(resolve, 300);
    });
    conn.on('error', () => { clearTimeout(timeout); resolve(); });
  });
  try { helperPeer.destroy(); } catch (_) {}
  return delivered;
}

// Sends the air horn to every active room (or a specific room if targetRoomId
// is provided). The observer / dashboard itself also plays it locally.
async function sendAirHornFromDashboard(targetRoomId = null) {
  const devAirHornBtnEl = document.getElementById('dev-airhorn-btn');
  if (devAirHornBtnEl) { devAirHornBtnEl.disabled = true; devAirHornBtnEl.textContent = '📢 Honking…'; }

  if (targetRoomId) {
    setDevPrankStatus(`Sending to room ${targetRoomId}…`);
    const delivered = await sendAirHornToRoomById(targetRoomId);
    setDevPrankStatus(delivered ? 'Air horn sent!' : 'Could not reach room — it may be offline.');
  } else {
    const activeRooms = await fetchActiveServers();
    if (activeRooms.length === 0) {
      setDevPrankStatus('No active rooms to send to.');
    } else {
      setDevPrankStatus(`Honking at ${activeRooms.length} room${activeRooms.length !== 1 ? 's' : ''}…`);
      let successCount = 0;
      for (const room of activeRooms) {
        const delivered = await sendAirHornToRoomById(room.roomId);
        if (delivered) successCount++;
      }
      setDevPrankStatus(`Air horn sent to ${successCount}/${activeRooms.length} rooms.`);
    }
  }

  // The dashboard operator hears it too.
  playAirHornLocally();

  if (devAirHornBtnEl) { devAirHornBtnEl.disabled = false; devAirHornBtnEl.textContent = '📢 Air Horn'; }
  setTimeout(() => setDevPrankStatus(''), 4000);
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


// ─── Pull to Room by user number ─────────────────

function setDevPullStatus(message) {
  const statusEl = document.getElementById("dev-pull-status");
  if (statusEl) statusEl.textContent = message;
}

// Sends a pull_to_room command via the registry.
// Uses currentRoomId if the creator is currently in a room; otherwise falls
// back to whatever the creator typed in the pull-room input.
function devPullUserToRoom(targetUserNumber) {
  const num      = String(targetUserNumber || "").trim().replace(/^#/, "");
  const roomInput = document.getElementById("dev-pull-room");
  const targetRoom = (roomInput?.value ?? "").trim() || currentRoomId;

  if (!num) { setDevPullStatus("No user number provided."); return; }
  if (!targetRoom) { setDevPullStatus("Enter a Room ID or join a room first."); return; }

  sendDashboardModeration({ type: "pull_to_room", userNumber: num, roomId: targetRoom });
  setDevPullStatus(`Pulling #${num} → ${targetRoom}…`);
  setTimeout(() => setDevPullStatus(""), 3500);
}

document.getElementById("dev-pull-btn")?.addEventListener("click", () => {
  const numInput  = document.getElementById("dev-pull-number");
  const rawNum    = (numInput?.value ?? "").trim().replace(/^#/, "");
  devPullUserToRoom(rawNum);
});

document.getElementById("dev-pull-number")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") devPullUserToRoom((e.target.value ?? "").trim().replace(/^#/, ""));
});

// ═══════════════════════════════════════════════════
//  DEV DASHBOARD — FORCE RELOAD
// ═══════════════════════════════════════════════════

function forceReloadRandomUser(presenceId) {
  sendDashboardModeration({ type: "reload_random", presenceId });
}

async function forceReloadAllClients() {
  const reloadAllBtnEl = document.getElementById("dev-reload-all-btn");
  if (reloadAllBtnEl) { reloadAllBtnEl.disabled = true; reloadAllBtnEl.textContent = "Reloading…"; }

  const activeRooms = await fetchActiveServers();

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

// Ghost observer panel — Air Horn button
document.getElementById('ghost-observer-airhorn-btn')?.addEventListener('click', () => {
  sendGhostAirHorn();
});

// Ghost observer panel — Whisper All button
document.getElementById('ghost-observer-whisper-all-btn')?.addEventListener('click', () => {
  toggleGhostWhisperAll();
});

// Master mute all — toggles every video/audio element in the observer grid
document.getElementById('ghost-observer-mute-all-btn')?.addEventListener('click', () => {
  ghostObserverAllMuted = !ghostObserverAllMuted;

  // Apply to every media element currently in the grid
  document.querySelectorAll('#ghost-observer-grid video, #ghost-observer-grid audio').forEach(mediaEl => {
    mediaEl.muted = ghostObserverAllMuted;
  });

  // Sync per-tile "Mute Audio" button labels
  document.querySelectorAll('#ghost-observer-grid .ghost-observer-tile').forEach(tileEl => {
    const localAudioBtn = tileEl.querySelector('.ghost-observer-actions .btn-xs');
    if (localAudioBtn) {
      localAudioBtn.textContent = ghostObserverAllMuted ? 'Unmute Audio' : 'Mute Audio';
      localAudioBtn.classList.toggle('btn-muted', ghostObserverAllMuted);
    }
  });

  const muteAllBtnEl = document.getElementById('ghost-observer-mute-all-btn');
  if (muteAllBtnEl) {
    muteAllBtnEl.textContent = ghostObserverAllMuted ? 'Unmute All' : 'Mute All';
    muteAllBtnEl.classList.toggle('btn-muted', ghostObserverAllMuted);
  }
});

// ─── Broadcast panel ──────────────────────────────
const devBroadcastBtnEl   = document.getElementById("dev-broadcast-btn");
const devBroadcastInputEl = document.getElementById("dev-broadcast-input");
const devBroadcastDurationEl  = document.getElementById("dev-broadcast-duration");
const devBroadcastRoomIdEl    = document.getElementById("dev-broadcast-room-id");
const broadcastTargetAllEl    = document.getElementById("broadcast-target-all");
const broadcastTargetRoomEl   = document.getElementById("broadcast-target-room");

// Enable/disable the room ID input depending on which radio is selected.
broadcastTargetRoomEl?.addEventListener("change", () => {
  if (devBroadcastRoomIdEl) devBroadcastRoomIdEl.disabled = !broadcastTargetRoomEl.checked;
});
broadcastTargetAllEl?.addEventListener("change", () => {
  if (devBroadcastRoomIdEl) devBroadcastRoomIdEl.disabled = broadcastTargetAllEl.checked;
});


// ─── Broadcast history (last 5 sends, survives until page reload) ─────────────

const BROADCAST_HISTORY_MAX   = 5;
const broadcastHistoryEntries = [];  // { text, targetLabel, sentAt }

function addToBroadcastHistory(text, targetLabel) {
  broadcastHistoryEntries.unshift({ text, targetLabel, sentAt: Date.now() });
  if (broadcastHistoryEntries.length > BROADCAST_HISTORY_MAX) {
    broadcastHistoryEntries.length = BROADCAST_HISTORY_MAX;
  }
  renderBroadcastHistory();
}

function renderBroadcastHistory() {
  const historySectionEl = document.getElementById("dev-broadcast-history-section");
  const historyListEl    = document.getElementById("dev-broadcast-history-list");
  if (!historySectionEl || !historyListEl) return;

  if (broadcastHistoryEntries.length === 0) {
    historySectionEl.style.display = "none";
    return;
  }

  historySectionEl.style.display = "";
  historyListEl.innerHTML = "";

  for (const entry of broadcastHistoryEntries) {
    const itemEl = document.createElement("div");
    itemEl.className = "dev-broadcast-history-item";

    const textEl       = document.createElement("span");
    textEl.className   = "dev-broadcast-history-text";
    textEl.textContent = entry.text;
    textEl.title       = entry.text;

    const metaEl       = document.createElement("span");
    metaEl.className   = "dev-broadcast-history-meta";
    metaEl.textContent = entry.targetLabel + "  ·  " + new Date(entry.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const resendBtnEl     = document.createElement("button");
    resendBtnEl.className   = "btn btn-xs btn-secondary";
    resendBtnEl.textContent = "Resend";
    const resendText = entry.text;
    resendBtnEl.addEventListener("click", () => {
      if (devBroadcastInputEl) devBroadcastInputEl.value = resendText;
      // Trigger send immediately (delay = 0 for resends).
      const delayEl = document.getElementById("dev-broadcast-delay");
      const savedDelay = delayEl?.value ?? "0";
      if (delayEl) delayEl.value = "0";
      devBroadcastBtnEl?.click();
      if (delayEl) delayEl.value = savedDelay;
    });

    itemEl.append(textEl, metaEl, resendBtnEl);
    historyListEl.appendChild(itemEl);
  }
}


// ─── Scheduled broadcast state ──────────────────────────────────────────────

let scheduledBroadcastTimer    = null;
let scheduledCountdownTimer    = null;
let scheduledSecondsRemaining  = 0;

function cancelScheduledBroadcast() {
  if (scheduledBroadcastTimer)   { clearTimeout(scheduledBroadcastTimer);   scheduledBroadcastTimer  = null; }
  if (scheduledCountdownTimer)   { clearInterval(scheduledCountdownTimer);  scheduledCountdownTimer  = null; }
  scheduledSecondsRemaining = 0;

  const cancelBtnEl = document.getElementById("dev-broadcast-cancel-btn");
  if (cancelBtnEl) cancelBtnEl.style.display = "none";
  if (devBroadcastBtnEl) { devBroadcastBtnEl.disabled = false; devBroadcastBtnEl.textContent = "Send Broadcast"; }
  setDevBroadcastStatus("Broadcast cancelled.");
  setTimeout(() => setDevBroadcastStatus(""), 2000);
}

document.getElementById("dev-broadcast-cancel-btn")?.addEventListener("click", () => {
  cancelScheduledBroadcast();
});


// ─── Core send logic (extracted so history + schedule can both call it) ─────

async function executeBroadcastSend(text, targetIsRoom, specificRoomId, dismissAfterSeconds) {
  if (devBroadcastBtnEl) { devBroadcastBtnEl.disabled = true; devBroadcastBtnEl.textContent = "Sending…"; }

  const targetLabel = targetIsRoom ? "Room " + specificRoomId : "All rooms";

  if (targetIsRoom) {
    await broadcastToRoom(specificRoomId, text, dismissAfterSeconds);
  } else {
    await broadcastToAllRooms(text, dismissAfterSeconds);
  }

  if (devBroadcastBtnEl) { devBroadcastBtnEl.disabled = false; devBroadcastBtnEl.textContent = "Send Broadcast"; }
  if (devBroadcastInputEl) devBroadcastInputEl.value = "";

  addToBroadcastHistory(text, targetLabel);
  appendEventLog("broadcast", `Broadcast → ${targetLabel}: "${text.length > 60 ? text.slice(0, 57) + "…" : text}"`);
}


// ─── Broadcast send button ───────────────────────────────────────────────────

devBroadcastBtnEl?.addEventListener("click", async () => {
  const text = devBroadcastInputEl?.value ?? "";
  if (!text.trim()) { setDevBroadcastStatus("Type a message first."); return; }

  const dismissAfterSeconds = Math.max(0, Math.floor(Number(devBroadcastDurationEl?.value ?? "0") || 0));
  const targetIsRoom        = broadcastTargetRoomEl?.checked ?? false;
  const specificRoomId      = (devBroadcastRoomIdEl?.value ?? "").trim();

  if (targetIsRoom && !specificRoomId) {
    setDevBroadcastStatus("Paste a Room ID to target a specific room.");
    return;
  }

  const delaySeconds = Math.max(0, parseInt(document.getElementById("dev-broadcast-delay")?.value ?? "0") || 0);

  if (delaySeconds > 0) {
    // Schedule: show countdown, lock UI, fire after delay.
    devBroadcastBtnEl.disabled = true;
    scheduledSecondsRemaining  = delaySeconds;
    const cancelBtnEl = document.getElementById("dev-broadcast-cancel-btn");
    if (cancelBtnEl) cancelBtnEl.style.display = "";

    setDevBroadcastStatus(`Sending in ${scheduledSecondsRemaining}s…`);

    scheduledCountdownTimer = setInterval(() => {
      scheduledSecondsRemaining--;
      setDevBroadcastStatus(`Sending in ${scheduledSecondsRemaining}s…`);
    }, 1000);

    scheduledBroadcastTimer = setTimeout(async () => {
      clearInterval(scheduledCountdownTimer);
      scheduledCountdownTimer = null;
      if (cancelBtnEl) cancelBtnEl.style.display = "none";
      await executeBroadcastSend(text, targetIsRoom, specificRoomId, dismissAfterSeconds);
    }, delaySeconds * 1000);

    return;
  }

  // Immediate send.
  await executeBroadcastSend(text, targetIsRoom, specificRoomId, dismissAfterSeconds);
});

devBroadcastInputEl?.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+Enter submits; plain Enter is allowed for multi-line messages
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) devBroadcastBtnEl?.click();
});


// ─── Per-user moderation by #ID ──────────────────────────────────────────────
//
// Finds the room containing the target user (via the registry participants list)
// then sends a creator_moderate_user command directly to that room's host.
// The room host is expected to handle this message in rooms.js.

function setDevModStatus(message) {
  const statusEl = document.getElementById("dev-mod-status");
  if (statusEl) statusEl.textContent = message;
}

// ─── Active ban tracking ──────────────────────────────────────────────────────
//
//  Tracks bans issued through the Direct User Action panel this session.
//  Temp-bans schedule an automatic unban via setTimeout.

const activeBansMap = new Map();  // userNumber → { roomId, expiresAt, timeoutId, durationMinutes }

function renderActiveBanList() {
  const sectionEl = document.getElementById("dev-ban-list-section");
  const listEl    = document.getElementById("dev-ban-list");
  if (!sectionEl || !listEl) return;

  if (activeBansMap.size === 0) {
    sectionEl.style.display = "none";
    return;
  }

  sectionEl.style.display = "";
  listEl.innerHTML = "";

  for (const [userNum, banInfo] of activeBansMap) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-ban-row";

    const idEl       = document.createElement("span");
    idEl.className   = "dev-ban-userid";
    idEl.textContent = "#" + userNum;

    const metaEl       = document.createElement("span");
    metaEl.className   = "dev-ban-meta";
    metaEl.textContent = (banInfo.durationMinutes > 0
      ? `Temp ${banInfo.durationMinutes}min`
      : "Permanent") + "  ·  " + banInfo.roomId;

    const expiryEl = document.createElement("span");
    expiryEl.className = "dev-ban-expiry";
    if (banInfo.expiresAt) {
      const msLeft = banInfo.expiresAt - Date.now();
      const minLeft = Math.max(0, Math.ceil(msLeft / 60000));
      expiryEl.textContent = minLeft + "m left";
    }

    const unbanBtnEl     = document.createElement("button");
    unbanBtnEl.className   = "btn btn-xs btn-secondary";
    unbanBtnEl.textContent = "Unban";
    const numToUnban  = userNum;
    const roomToUnban = banInfo.roomId;
    unbanBtnEl.addEventListener("click", async () => {
      const entry = activeBansMap.get(numToUnban);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      activeBansMap.delete(numToUnban);
      renderActiveBanList();
      await sendModActionToRoom(numToUnban, "unban", roomToUnban);
      appendEventLog("mod-unban", `Manually unbanned #${numToUnban}`);
    });

    rowEl.append(idEl, metaEl, expiryEl, unbanBtnEl);
    listEl.appendChild(rowEl);
  }
}


// Sends a creator_moderate_user message directly to a known room's host.
async function sendModActionToRoom(userNum, action, roomId) {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return false;
  const conn = helperPeer.connect(roomId, { reliable: true });
  let delivered = false;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3500);
    conn.on("open", () => {
      conn.send({ type: "creator_moderate_user", action, userNumber: userNum, ghostToken: CREATOR_PASSWORD });
      clearTimeout(timeout);
      delivered = true;
      setTimeout(resolve, 400);
    });
    conn.on("error", () => { clearTimeout(timeout); resolve(); });
  });
  try { helperPeer.destroy(); } catch (_) {}
  return delivered;
}


async function moderateUserById(action) {
  const userNum = (document.getElementById("dev-mod-user-id")?.value ?? "").trim().replace(/^#/, "");
  if (!userNum) { setDevModStatus("Enter a #ID first."); return; }

  setDevModStatus(`Searching for #${userNum}…`);

  const activeRooms = await fetchActiveServers();
  const targetRoom  = activeRooms.find(room =>
    (room.participants ?? []).some(p => String(p.userNumber ?? "") === userNum)
  );

  if (!targetRoom) {
    setDevModStatus(`#${userNum} not found in any active room.`);
    setTimeout(() => setDevModStatus(""), 3500);
    return;
  }

  setDevModStatus(`Sending ${action} → #${userNum} in ${targetRoom.roomId}…`);

  const delivered = await sendModActionToRoom(userNum, action, targetRoom.roomId);

  const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
  setDevModStatus(delivered
    ? `${actionLabel} sent to #${userNum}.`
    : "Could not reach room — it may be offline."
  );
  setTimeout(() => setDevModStatus(""), 3000);

  if (!delivered) return;

  // ── Log the action ───────────────────────────────────────────────────────
  appendEventLog("mod-" + action, `${actionLabel} → #${userNum} in ${targetRoom.roomId}`);

  // ── Track bans in the session ban list ───────────────────────────────────
  if (action === "ban") {
    const durationMinutes = Math.max(0, parseInt(document.getElementById("dev-mod-ban-duration")?.value ?? "0") || 0);

    let expiresAt  = null;
    let timeoutId  = null;

    if (durationMinutes > 0) {
      expiresAt = Date.now() + durationMinutes * 60000;
      timeoutId = setTimeout(async () => {
        activeBansMap.delete(userNum);
        renderActiveBanList();
        await sendModActionToRoom(userNum, "unban", targetRoom.roomId);
        appendEventLog("mod-unban", `Temp-ban expired — auto-unbanned #${userNum}`);
      }, durationMinutes * 60000);
    }

    // Cancel any previous ban timer for this user before recording the new one
    const previousBan = activeBansMap.get(userNum);
    if (previousBan?.timeoutId) clearTimeout(previousBan.timeoutId);

    activeBansMap.set(userNum, {
      roomId: targetRoom.roomId,
      durationMinutes,
      expiresAt,
      timeoutId,
    });
    renderActiveBanList();
  } else if (action === "unban") {
    const existing = activeBansMap.get(userNum);
    if (existing?.timeoutId) clearTimeout(existing.timeoutId);
    activeBansMap.delete(userNum);
    renderActiveBanList();
  }
}

document.getElementById("dev-mod-mute-btn")?.addEventListener("click", () => moderateUserById("mute"));
document.getElementById("dev-mod-kick-btn")?.addEventListener("click", () => moderateUserById("kick"));
document.getElementById("dev-mod-ban-btn")?.addEventListener( "click", () => moderateUserById("ban"));

document.getElementById("dev-mod-user-id")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") moderateUserById("kick");
});

// ─── Dev dashboard prank target radio ─────────────
const prankTargetAllEl  = document.getElementById('prank-target-all');
const prankTargetRoomEl = document.getElementById('prank-target-room');
const devPrankRoomIdEl  = document.getElementById('dev-prank-room-id');

prankTargetRoomEl?.addEventListener('change', () => {
  if (devPrankRoomIdEl) devPrankRoomIdEl.disabled = !prankTargetRoomEl.checked;
});
prankTargetAllEl?.addEventListener('change', () => {
  if (devPrankRoomIdEl) devPrankRoomIdEl.disabled = prankTargetAllEl.checked;
});

document.getElementById('dev-airhorn-btn')?.addEventListener('click', () => {
  const targetIsRoom   = prankTargetRoomEl?.checked ?? false;
  const specificRoomId = devPrankRoomIdEl?.value?.trim() ?? '';
  if (targetIsRoom && !specificRoomId) {
    setDevPrankStatus('Paste a Room ID to target a specific room.');
    return;
  }
  sendAirHornFromDashboard(targetIsRoom ? specificRoomId : null);
});

// ─── Force Reload All ─────────────────────────────
document.getElementById("dev-reload-all-btn")?.addEventListener("click", () => forceReloadAllClients());

document.getElementById("dev-shutdown-all-btn")?.addEventListener("click", async () => {
  const activeRooms = await fetchActiveServers();
  const count = activeRooms.length;
  if (count === 0) { appendEventLog("room-closed", "No active rooms to shut down."); return; }
  if (!confirm(`Shut down ALL ${count} active room${count !== 1 ? "s" : ""}? Every participant will be disconnected.`)) return;
  await shutdownAllRooms();
});

document.getElementById("dev-force-close-by-id-btn")?.addEventListener("click", async () => {
  const roomId = (document.getElementById("dev-force-close-id")?.value ?? "").trim();
  if (!roomId) return;
  if (!confirm(`Force-close room "${roomId}"? All participants will be disconnected.`)) return;
  await forceCloseRoom(roomId);
  const inputEl = document.getElementById("dev-force-close-id");
  if (inputEl) inputEl.value = "";
});

document.getElementById("dev-force-close-id")?.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const roomId = e.target.value.trim();
  if (!roomId) return;
  if (!confirm(`Force-close room "${roomId}"?`)) return;
  await forceCloseRoom(roomId);
  e.target.value = "";
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
    'coterie-dev-dashboard',
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


// ═══════════════════════════════════════════════════
//  WATCHLIST
//
//  Devs can flag any permanent #UserID. On every dashboard refresh,
//  _checkWatchlistHits() scans the active rooms data and fires an event-log
//  alert the first time a watched user is seen.  The alert is de-duplicated
//  per session: if the user leaves and re-joins, it fires again.
// ═══════════════════════════════════════════════════

const STORAGE_KEY_WATCHLIST   = "coterie_dev_watchlist";
const watchlistAlertedSet     = new Set();  // "userNum:roomId" keys already alerted this session

function _loadWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY_WATCHLIST) ?? "[]")); }
  catch (_) { return new Set(); }
}

function _saveWatchlist(watchSet) {
  localStorage.setItem(STORAGE_KEY_WATCHLIST, JSON.stringify([...watchSet]));
}

function addToWatchlist(userNumber) {
  const watchSet = _loadWatchlist();
  watchSet.add(String(userNumber));
  _saveWatchlist(watchSet);
  renderWatchlist();
}

function removeFromWatchlist(userNumber) {
  const watchSet = _loadWatchlist();
  watchSet.delete(String(userNumber));
  _saveWatchlist(watchSet);
  // Clear any alerted state so re-adding the user fires a fresh alert.
  for (const key of [...watchlistAlertedSet]) {
    if (key.startsWith(String(userNumber) + ":")) watchlistAlertedSet.delete(key);
  }
  renderWatchlist();
}

function renderWatchlist() {
  const listEl = document.getElementById("dev-watchlist-list");
  if (!listEl) return;
  const watchSet = _loadWatchlist();
  listEl.innerHTML = "";
  if (watchSet.size === 0) {
    listEl.innerHTML = '<p class="dev-empty" style="padding:10px 0;font-size:0.78rem">No users being watched.</p>';
    return;
  }
  for (const userNumber of [...watchSet].sort()) {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-watchlist-row";
    const badgeEl = document.createElement("span");
    badgeEl.className   = "dev-watchlist-badge";
    badgeEl.textContent = "#" + userNumber;
    const removeBtnEl   = document.createElement("button");
    removeBtnEl.className   = "btn btn-xs btn-secondary";
    removeBtnEl.textContent = "Remove";
    const numToRemove = userNumber;
    removeBtnEl.addEventListener("click", () => removeFromWatchlist(numToRemove));
    rowEl.append(badgeEl, removeBtnEl);
    listEl.appendChild(rowEl);
  }
}

function _checkWatchlistHits(rooms) {
  const watchSet = _loadWatchlist();
  if (watchSet.size === 0) return;

  const currentAlertKeys = new Set();

  for (const room of rooms) {
    for (const participant of (room.participants ?? [])) {
      const userNum = String(participant.userNumber ?? "");
      if (!userNum || !watchSet.has(userNum)) continue;
      const alertKey = userNum + ":" + room.roomId;
      currentAlertKeys.add(alertKey);
      if (!watchlistAlertedSet.has(alertKey)) {
        watchlistAlertedSet.add(alertKey);
        appendEventLog("watchlist",
          `🔔 Watched #${userNum} (${participant.username ?? "?"}) spotted in ${room.roomId}`);
      }
    }
  }

  // Reset stale keys so the alert fires again if the user re-joins.
  for (const key of [...watchlistAlertedSet]) {
    if (!currentAlertKeys.has(key)) watchlistAlertedSet.delete(key);
  }
}

document.getElementById("dev-watchlist-add-btn")?.addEventListener("click", () => {
  const inputEl  = document.getElementById("dev-watchlist-input");
  const userNum  = (inputEl?.value ?? "").trim().replace(/^#/, "");
  if (!userNum) return;
  addToWatchlist(userNum);
  if (inputEl) inputEl.value = "";
  appendEventLog("watchlist", `Added #${userNum} to watchlist.`);
});

document.getElementById("dev-watchlist-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("dev-watchlist-add-btn")?.click();
});


// ═══════════════════════════════════════════════════
//  MESSAGE TEMPLATES
//
//  Saved to localStorage — survive page reloads.
//  "Use" fills the broadcast textarea; "✕" deletes the template.
// ═══════════════════════════════════════════════════

const STORAGE_KEY_TEMPLATES = "coterie_dev_templates";

function _loadTemplates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TEMPLATES) ?? "[]"); }
  catch (_) { return []; }
}

function _saveTemplates(templateList) {
  localStorage.setItem(STORAGE_KEY_TEMPLATES, JSON.stringify(templateList));
}

function addMessageTemplate(name, text) {
  const templateList = _loadTemplates();
  templateList.unshift({ name, text, savedAt: Date.now() });
  _saveTemplates(templateList);
  renderMessageTemplates();
}

function removeMessageTemplate(index) {
  const templateList = _loadTemplates();
  templateList.splice(index, 1);
  _saveTemplates(templateList);
  renderMessageTemplates();
}

function renderMessageTemplates() {
  const listEl = document.getElementById("dev-template-list");
  if (!listEl) return;
  const templateList = _loadTemplates();
  listEl.innerHTML = "";
  if (templateList.length === 0) {
    listEl.innerHTML = '<p class="dev-empty" style="padding:8px 0;font-size:0.78rem">No templates saved yet.</p>';
    return;
  }
  templateList.forEach((template, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "dev-template-row";

    const nameEl = document.createElement("span");
    nameEl.className   = "dev-template-name";
    nameEl.textContent = template.name;
    nameEl.title       = template.text;

    const useBtnEl = document.createElement("button");
    useBtnEl.className   = "btn btn-xs btn-secondary";
    useBtnEl.textContent = "Use";
    const templateText = template.text;
    useBtnEl.addEventListener("click", () => {
      if (devBroadcastInputEl) devBroadcastInputEl.value = templateText;
      devBroadcastInputEl?.focus();
    });

    const delBtnEl = document.createElement("button");
    delBtnEl.className   = "btn btn-xs btn-danger";
    delBtnEl.textContent = "✕";
    delBtnEl.title       = "Delete template";
    const indexToDelete = index;
    delBtnEl.addEventListener("click", () => removeMessageTemplate(indexToDelete));

    rowEl.append(nameEl, useBtnEl, delBtnEl);
    listEl.appendChild(rowEl);
  });
}

document.getElementById("dev-save-template-btn")?.addEventListener("click", () => {
  const text       = (devBroadcastInputEl?.value ?? "").trim();
  const nameInputEl = document.getElementById("dev-template-name-input");
  const name       = (nameInputEl?.value ?? "").trim();
  if (!text) { setDevBroadcastStatus("Type a message to save as a template."); return; }
  const templateName = name ||
    "Template " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  addMessageTemplate(templateName, text);
  if (nameInputEl) nameInputEl.value = "";
  setDevBroadcastStatus(`Template "${templateName}" saved.`);
  setTimeout(() => setDevBroadcastStatus(""), 2500);
});


// ═══════════════════════════════════════════════════
//  SCHEDULE BROADCAST AT SPECIFIC TIME
//
//  Converts a wall-clock time picker value to a delay and writes it into
//  the existing delay field, so the normal scheduled-send countdown handles it.
// ═══════════════════════════════════════════════════

document.getElementById("dev-schedule-time-btn")?.addEventListener("click", () => {
  const timeInputEl = document.getElementById("dev-schedule-time");
  const timeValue   = timeInputEl?.value;
  if (!timeValue) { setDevBroadcastStatus("Pick a time first."); return; }

  const [hours, minutes]  = timeValue.split(":").map(Number);
  const now               = new Date();
  const scheduledTime     = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0
  );

  // If the chosen time is already past today, schedule for tomorrow.
  if (scheduledTime <= now) scheduledTime.setDate(scheduledTime.getDate() + 1);

  const delaySeconds = Math.round((scheduledTime - now) / 1000);
  const delayInputEl = document.getElementById("dev-broadcast-delay");
  if (delayInputEl) delayInputEl.value = String(delaySeconds);

  const formattedTime = scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  setDevBroadcastStatus(`Delay set to ${delaySeconds}s (fires at ${formattedTime}).`);
  setTimeout(() => setDevBroadcastStatus(""), 3500);
});


// ═══════════════════════════════════════════════════
//  INITIALISE PERSISTENT UI STATE
// ═══════════════════════════════════════════════════

// Populate watchlist and template lists from localStorage on first paint.
renderWatchlist();
renderMessageTemplates();


// ═══════════════════════════════════════════════════
//  PLATFORM BLOCK LIST — DEV DASHBOARD
//
//  Sends a platform_ban message to the registry so all connected hosts
//  and future queries will reject that userNumber.
// ═══════════════════════════════════════════════════

function setPlatformBanStatus(message) {
  const statusEl = document.getElementById("dev-platform-ban-status");
  if (statusEl) statusEl.textContent = message;
}

document.getElementById("dev-platform-ban-btn")?.addEventListener("click", async () => {
  const inputEl  = document.getElementById("dev-platform-ban-number");
  const rawNum   = (inputEl?.value ?? "").trim().replace(/^#/, "");
  if (!rawNum) { setPlatformBanStatus("Enter a #UserID first."); return; }

  setPlatformBanStatus(`Banning #${rawNum} platform-wide…`);

  // Apply locally (this browser may be the registry holder).
  if (typeof platformBanUserNumber === "function") platformBanUserNumber(rawNum);

  // Propagate to the registry holder so other hosts get it on next query.
  await sendDashboardModeration({ type: "platform_ban", userNumber: rawNum });

  appendEventLog("mod-ban", `Platform ban issued for #${rawNum}`);
  setPlatformBanStatus(`#${rawNum} is now platform-banned.`);
  if (inputEl) inputEl.value = "";
  setTimeout(() => setPlatformBanStatus(""), 4000);
});

document.getElementById("dev-platform-ban-number")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("dev-platform-ban-btn")?.click();
});

document.getElementById("dev-clear-platform-bans")?.addEventListener("click", async () => {
  if (typeof platformClearAllBans === "function") platformClearAllBans();
  await sendDashboardModeration({ type: "platform_unban_all" });
  appendEventLog("mod-ban", "All platform bans cleared.");
  setPlatformBanStatus("Platform ban list cleared.");
  setTimeout(() => setPlatformBanStatus(""), 3000);
});


// ═══════════════════════════════════════════════════
//  GHOST ANNOTATION — CANVAS DRAWING
//
//  A local-only transparent canvas overlaid on top of the ghost observer's
//  video grid.  Only the creator sees it; nothing is sent over the network.
//
//  Features:
//    • Freehand drawing with pointer events (mouse + touch + stylus)
//    • Color picker (5 presets) + stroke size selector
//    • Eraser mode (draws with transparent composite operation)
//    • Clear button wipes the whole canvas
//    • Toggle button shows/hides the canvas without clearing it
// ═══════════════════════════════════════════════════

let _annotationIsActive  = false;   // canvas is visible and accepting input
let _annotationIsDrawing = false;   // pointer is currently down
let _annotationColor     = "#ff4444";
let _annotationSize      = 6;
let _annotationIsEraser  = false;

function _getAnnotationCanvas() {
  return document.getElementById("ghost-annotation-canvas");
}

function _getAnnotationContext() {
  const canvas = _getAnnotationCanvas();
  return canvas ? canvas.getContext("2d") : null;
}

// Resize the canvas to match the grid-wrap's current pixel dimensions.
function _resizeAnnotationCanvas() {
  const canvas  = _getAnnotationCanvas();
  const wrapEl  = canvas?.closest(".ghost-observer-grid-wrap");
  if (!canvas || !wrapEl) return;

  const { width, height } = wrapEl.getBoundingClientRect();
  // Only resize if dimensions changed — resizing clears the canvas.
  if (canvas.width !== Math.round(width) || canvas.height !== Math.round(height)) {
    canvas.width  = Math.round(width);
    canvas.height = Math.round(height);
  }
}

// Convert a PointerEvent to canvas-relative coordinates.
function _canvasPointerPosition(pointerEvent) {
  const canvas = _getAnnotationCanvas();
  if (!canvas) return { pointerX: 0, pointerY: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    pointerX: pointerEvent.clientX - rect.left,
    pointerY: pointerEvent.clientY - rect.top,
  };
}

// Toggle the annotation canvas on/off.
function _toggleAnnotation() {
  _annotationIsActive = !_annotationIsActive;

  const canvas       = _getAnnotationCanvas();
  const toolbarEl    = document.getElementById("ghost-annotation-toolbar");
  const toggleBtnEl  = document.getElementById("ghost-annotation-toggle-btn");

  if (!canvas) return;

  if (_annotationIsActive) {
    _resizeAnnotationCanvas();
    canvas.classList.remove("hidden");
    toolbarEl?.classList.remove("hidden");
    if (toggleBtnEl) {
      toggleBtnEl.classList.add("active");
      toggleBtnEl.title = "Hide annotation overlay";
    }
  } else {
    canvas.classList.add("hidden");
    toolbarEl?.classList.add("hidden");
    if (toggleBtnEl) {
      toggleBtnEl.classList.remove("active");
      toggleBtnEl.title = "Toggle annotation overlay (draw on top of streams)";
    }
    _annotationIsDrawing = false;
  }
}

// ── Pointer event handlers ────────────────────────────────────────────────────

function _annotationPointerDown(pointerEvent) {
  if (!_annotationIsActive) return;
  pointerEvent.preventDefault();

  const canvas = _getAnnotationCanvas();
  if (!canvas) return;
  canvas.setPointerCapture(pointerEvent.pointerId);
  _annotationIsDrawing = true;

  const context = _getAnnotationContext();
  if (!context) return;

  _resizeAnnotationCanvas();
  const { pointerX, pointerY } = _canvasPointerPosition(pointerEvent);

  context.beginPath();
  context.moveTo(pointerX, pointerY);

  if (_annotationIsEraser) {
    context.globalCompositeOperation = "destination-out";
    context.strokeStyle = "rgba(0,0,0,1)";
  } else {
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = _annotationColor;
  }

  context.lineWidth   = _annotationSize;
  context.lineCap     = "round";
  context.lineJoin    = "round";
}

function _annotationPointerMove(pointerEvent) {
  if (!_annotationIsActive || !_annotationIsDrawing) return;
  pointerEvent.preventDefault();

  const context = _getAnnotationContext();
  if (!context) return;

  const { pointerX, pointerY } = _canvasPointerPosition(pointerEvent);
  context.lineTo(pointerX, pointerY);
  context.stroke();
}

function _annotationPointerUp(pointerEvent) {
  if (!_annotationIsDrawing) return;
  _annotationIsDrawing = false;

  const context = _getAnnotationContext();
  if (context) {
    context.closePath();
    // Reset composite operation so future draws are normal.
    context.globalCompositeOperation = "source-over";
  }
}

// Wire canvas pointer events once the ghost observer panel exists.
(function _initAnnotationCanvas() {
  const canvas = _getAnnotationCanvas();
  if (!canvas) return;

  canvas.addEventListener("pointerdown", _annotationPointerDown, { passive: false });
  canvas.addEventListener("pointermove", _annotationPointerMove, { passive: false });
  canvas.addEventListener("pointerup",   _annotationPointerUp);
  canvas.addEventListener("pointercancel", _annotationPointerUp);

  // Keep canvas in sync with panel resizes.
  const resizeObserver = new ResizeObserver(() => {
    if (_annotationIsActive) _resizeAnnotationCanvas();
  });
  const wrapEl = canvas.closest(".ghost-observer-grid-wrap");
  if (wrapEl) resizeObserver.observe(wrapEl);
})();

// ── Toolbar event listeners ───────────────────────────────────────────────────

document.getElementById("ghost-annotation-toggle-btn")?.addEventListener("click", () => {
  _toggleAnnotation();
});

// Color swatch buttons.
document.querySelectorAll(".annot-color-btn").forEach((swatchBtnEl) => {
  swatchBtnEl.addEventListener("click", () => {
    _annotationColor   = swatchBtnEl.dataset.color ?? "#ff4444";
    _annotationIsEraser = false;

    // Update active swatch highlight.
    document.querySelectorAll(".annot-color-btn").forEach((btn) => btn.classList.remove("active"));
    swatchBtnEl.classList.add("active");

    // De-activate the eraser button visually.
    const eraserBtnEl = document.getElementById("annot-eraser-btn");
    if (eraserBtnEl) eraserBtnEl.classList.remove("active");
  });
});

// Stroke size picker.
document.getElementById("annot-size-select")?.addEventListener("change", (e) => {
  _annotationSize = parseInt(e.target.value, 10) || 6;
});

// Eraser toggle.
document.getElementById("annot-eraser-btn")?.addEventListener("click", () => {
  _annotationIsEraser = !_annotationIsEraser;
  document.getElementById("annot-eraser-btn")?.classList.toggle("active", _annotationIsEraser);
  // De-highlight all color swatches when eraser is on so the state is obvious.
  document.querySelectorAll(".annot-color-btn").forEach((btn) => {
    btn.classList.toggle("active", !_annotationIsEraser && btn.dataset.color === _annotationColor);
  });
});

// Clear button — wipes the entire canvas.
document.getElementById("annot-clear-btn")?.addEventListener("click", () => {
  const canvas  = _getAnnotationCanvas();
  const context = _getAnnotationContext();
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
});

// Clear the annotation canvas when the observer session closes.
const _originalCloseGhostObserver = closeGhostObserver;
function closeGhostObserver() {
  _originalCloseGhostObserver();
  // Hide annotation overlay and clear the canvas.
  const canvas    = _getAnnotationCanvas();
  const toolbarEl = document.getElementById("ghost-annotation-toolbar");
  if (canvas) {
    canvas.classList.add("hidden");
    const context = canvas.getContext("2d");
    if (context) context.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (toolbarEl) toolbarEl.classList.add("hidden");
  _annotationIsActive  = false;
  _annotationIsDrawing = false;
  const toggleBtnEl = document.getElementById("ghost-annotation-toggle-btn");
  if (toggleBtnEl) toggleBtnEl.classList.remove("active");
}
