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

// "Monitor" button in the creator-status lobby row — opens the Dev Dashboard.
document.getElementById("creator-monitor-btn")?.addEventListener("click", () => {
  openDevDashboard();
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

// Shared AudioContext primed when the dashboard is opened (user-gesture context).
// Reusing it lets playAirHornLocally work from async callbacks and network messages
// where no fresh user gesture is present.
let dashboardAudioCtx   = null;
let devDashboardIsOpen      = false;
let devDashboardRefreshTimer = null;  // auto-refresh interval for the dashboard

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

  if (!devDashboardRefreshTimer) {
    devDashboardRefreshTimer = setInterval(refreshDevDashboard, 5000);
  }

  // Activate the rooms tab when opening.
  activateDashboardTab('rooms');
}

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

    actionsEl.append(observeBtnEl, joinBtnEl, closeBtnEl);
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

devBroadcastBtnEl?.addEventListener("click", async () => {
  const text = devBroadcastInputEl?.value ?? "";
  if (!text.trim()) { setDevBroadcastStatus("Type a message first."); return; }

  const dismissAfterSeconds = Math.max(0, Math.floor(Number(devBroadcastDurationEl?.value ?? "0") || 0));
  const targetIsRoom        = broadcastTargetRoomEl?.checked ?? false;
  const specificRoomId      = devBroadcastRoomIdEl?.value ?? "";

  if (targetIsRoom && !specificRoomId.trim()) {
    setDevBroadcastStatus("Paste a Room ID to target a specific room.");
    return;
  }

  devBroadcastBtnEl.disabled    = true;
  devBroadcastBtnEl.textContent = "Sending…";

  if (targetIsRoom) {
    await broadcastToRoom(specificRoomId, text, dismissAfterSeconds);
  } else {
    await broadcastToAllRooms(text, dismissAfterSeconds);
  }

  devBroadcastBtnEl.disabled    = false;
  devBroadcastBtnEl.textContent = "Send Broadcast";

  // Clear the textarea after a successful send
  if (devBroadcastInputEl) devBroadcastInputEl.value = "";
});

devBroadcastInputEl?.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+Enter submits; plain Enter is allowed for multi-line messages
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) devBroadcastBtnEl?.click();
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
