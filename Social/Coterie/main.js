// ═══════════════════════════════════════════════════
//  TERMS OF SERVICE GATE
//
//  Shows the ToS modal on first visit. The entire app is hidden behind it.
//  Once the user accepts, we record "coterie_tos_accepted" in localStorage
//  so they are never shown it again. Declining locks them out until they
//  clear their browser data.
// ═══════════════════════════════════════════════════

const STORAGE_KEY_TOS_ACCEPTED = 'coterie_tos_accepted';

(function initToSGate() {
  const tosOverlayEl      = document.getElementById('tos-overlay');
  const tosDeclinedEl     = document.getElementById('tos-declined-screen');
  const usernameScreenElt = document.getElementById('username-screen');

  const tosAccepted = localStorage.getItem(STORAGE_KEY_TOS_ACCEPTED) === '1';

  if (tosAccepted) {
    // Already agreed — nothing to show, let the rest of main.js run normally.
    return;
  }

  // Hide the rest of the app while the ToS is pending.
  if (usernameScreenElt) usernameScreenElt.classList.add('hidden');

  // Show the ToS overlay.
  tosOverlayEl.classList.remove('hidden');

  document.getElementById('tos-accept-btn').addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEY_TOS_ACCEPTED, '1');
    tosOverlayEl.classList.add('hidden');
    // Reveal the username screen so normal startup continues.
    if (usernameScreenElt) usernameScreenElt.classList.remove('hidden');
  });

  document.getElementById('tos-decline-btn').addEventListener('click', () => {
    tosOverlayEl.classList.add('hidden');
    tosDeclinedEl.classList.remove('hidden');
  });

  document.getElementById('tos-review-btn').addEventListener('click', () => {
    tosDeclinedEl.classList.add('hidden');
    tosOverlayEl.classList.remove('hidden');
  });
})();

// window.Peer → PeerJS (peerjs@1.5.4)

// ═══════════════════════════════════════════════════
//  WEBRTC ICE / TURN CONFIGURATION
//
//  Why two devices failed: PeerJS was created with no ICE config, so calls
//  only had STUN (NAT discovery). On one machine / LAN, peers exchange direct
//  "host" candidates and connect fine — but two devices on DIFFERENT networks
//  sit behind NATs/firewalls that block direct traffic, so the media never
//  flows and the call looks connected yet shows nothing. A TURN server relays
//  the audio/video in that case.
//
//  STUN_SERVERS handle NAT discovery; TURN_SERVERS relay when a direct path is
//  impossible. The TURN entries below are a free, best-effort public relay on
//  ports 80/443 + TCP (to punch through strict firewalls). Free public TURN is
//  rate-limited and not guaranteed — for anything beyond testing, replace
//  TURN_SERVERS with your own credentials (coturn, Metered, Cloudflare, Twilio).
// ═══════════════════════════════════════════════════

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

// ⚠️ Best-effort free relay — swap in your own TURN credentials for production.
const TURN_SERVERS = [
  { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

// Passed to every `new Peer(...)` so all connections share one ICE/TURN config.
//
// We auto-detect which signaling server to use so the same codebase works in
// both CoderPad (sandboxed, blocks external WebSocket) and GitHub Pages
// (open network, uses the public PeerJS cloud):
//
//   • CoderPad / Vite dev  →  local PeerJS server at /peerjs (see vite.config.ts)
//   • GitHub Pages / other →  public PeerJS cloud (default, no extra options)
//
// The probe runs eagerly on page load, well before the user can interact.
let PEER_OPTIONS = { config: { iceServers: [...STUN_SERVERS, ...TURN_SERVERS] } };

(async () => {
  try {
    const controller = new AbortController();
    const probeTimeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch('/peerjs/peerjs/id', { signal: controller.signal });
    clearTimeout(probeTimeout);
    if (response.ok) {
      const text = await response.text();
      // PeerJS returns a UUID — detect it to confirm the server is really there.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(text.trim())) {
        PEER_OPTIONS = {
          host:   window.location.hostname,
          port:   Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80),
          path:   '/peerjs',
          secure: window.location.protocol === 'https:',
          config: { iceServers: [...STUN_SERVERS, ...TURN_SERVERS] },
        };
      }
    }
  } catch (_) {
    // No local server — keep the public cloud default already set above.
  }
})();

// Creates a PeerJS peer with our shared ICE/TURN config. Pass a fixed id when
// one is needed (registry holder, Random slots); omit it for an auto id.
function createPeer(peerId) {
  return peerId ? new window.Peer(peerId, PEER_OPTIONS) : new window.Peer(PEER_OPTIONS);
}

// ─── Peer creation with retry + timeout ───────────────────────────────────────
//
// The public PeerJS signaling server is free-tier and occasionally hangs,
// rejects connections, or returns transient errors. This wrapper:
//
//   1. Sets a hard 12-second timeout per attempt (peer.once('open') can
//      hang forever if the server stops responding without sending an error).
//   2. Retries up to MAX_PEER_RETRIES times on transient failures, with a
//      short back-off between attempts.
//   3. Does NOT retry on permanent errors: unavailable-id (ID already taken),
//      invalid-id, or browser-incompatible.
//
// Returns the open Peer on success, or throws a string error type on failure.
//
const MAX_PEER_RETRIES    = 1;   // 2 total attempts; fail fast then let user retry
const PEER_OPEN_TIMEOUT_MS = 8_000;  // 8s per attempt — enough for any healthy server

// Error types that are permanent — no point retrying.
const PEER_PERMANENT_ERRORS = new Set([
  'unavailable-id',
  'invalid-id',
  'browser-incompatible',
  'ssl-unavailable',
]);

async function createPeerWithRetry(peerId) {
  let lastErrorType = 'unknown';

  for (let attempt = 0; attempt <= MAX_PEER_RETRIES; attempt++) {
    // Brief back-off before each retry so we don't hammer the server.
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }

    const candidatePeer = createPeer(peerId);

    const result = await new Promise((resolve) => {
      const openTimer = setTimeout(() => {
        // Server stopped responding — kill this peer and signal a timeout.
        try { candidatePeer.destroy(); } catch (_) {}
        resolve({ ok: false, errorType: 'timeout' });
      }, PEER_OPEN_TIMEOUT_MS);

      candidatePeer.once('open', () => {
        clearTimeout(openTimer);
        resolve({ ok: true, peer: candidatePeer });
      });

      candidatePeer.once('error', (err) => {
        clearTimeout(openTimer);
        try { candidatePeer.destroy(); } catch (_) {}
        resolve({ ok: false, errorType: err.type ?? 'unknown' });
      });
    });

    if (result.ok) return result.peer;

    lastErrorType = result.errorType;

    // Stop immediately on errors the server will never recover from.
    if (PEER_PERMANENT_ERRORS.has(lastErrorType)) break;
  }

  throw lastErrorType;
}

// ═══════════════════════════════════════════════════
//  ROOMS STATE
// ═══════════════════════════════════════════════════

let peer            = null;
let isHost          = false;
let currentRoomId   = "";
let currentUsername = "";
let currentRoomName    = "";   // custom name set by the host at creation time
let currentRoomMaxSize = 0;    // max participants; 0 = unlimited
let currentRoomPassword  = "";   // room password; empty = open room
let localStream     = null;
let isMuted         = false;
let isCamOff        = false;
let isForceMutedByHost  = false;  // guest: host locked mic off
let isForceCamOffByHost = false;  // guest: host locked camera off (one-way)

// ─── Connection heartbeat (host-side) ─────────────────
const HEARTBEAT_INTERVAL_MS = 5000;   // how often the host pings each guest
const HEARTBEAT_TIMEOUT_MS  = 12000;  // drop a guest after this many ms with no pong
let   heartbeatTimer        = null;

// ─── Screen sharing ───────────────────────────────
let isScreenSharing   = false;
let screenShareStream = null;

// ─── Raise hand ──────────────────────────────────
let   localHandRaised   = false;
const raisedHandPeerIds = new Set();

// ─── Speaking indicator ───────────────────────────
let   audioContextInstance = null;
const peerIdToAnalyser     = new Map();  // peerId → { analyser, source }
let   speakingLoopActive   = false;
const speakingDataBuffer   = new Uint8Array(64);

// ─── Screen name (set once on the username screen, used everywhere) ───────────
let screenName = "";

const guestConnectionMap = new Map();  // peerId → { conn, username }
const bannedUsernames    = new Set();
let   hostConnection     = null;
let   connectedUsers     = [];
const mediaCallMap       = new Map();  // peerId → PeerJS Call

const forceMutedPeerIds        = new Set();  // host: peerIds that have been force-muted
const forceCamOffPeerIds       = new Set();  // host: peerIds whose cameras have been forced off
const ghostObserverPeerIds      = new Set();  // creator ghost observers — invisible to all participants
let   hostActionMenuTargetPeerId = null;      // peerId the action menu is currently open for
let   hostPeerId               = "";          // peerId of the room owner (known on both sides)

// ─── Host failover ────────────────────────────────
// When the host drops, connectedUsers[1] (the first guest to join) becomes
// the designated successor. It claims a well-known signaling peer so every
// other guest can discover the new room ID and auto-rejoin.
const FAILOVER_PEER_PREFIX = "coterie-fo-";  // short prefix for signaling peer ID
const FAILOVER_GRACE_MS    = 2000;           // wait before triggering failover
const FAILOVER_TIMEOUT_MS  = 12000;          // give up waiting for the new room

let failoverInProgress = false;

// Deterministic signaling peer ID derived from the old room's ID.
function buildFailoverPeerId(oldRoomId) {
  return FAILOVER_PEER_PREFIX + oldRoomId.replace(/-/g, "").slice(0, 20);
}

// ═══════════════════════════════════════════════════
//  ACTIVE-SERVER REGISTRY
//
//  Hosts announce their room to a single well-known PeerJS peer (the
//  "registry holder"). The first host to claim the fixed ID becomes the
//  holder; everyone else connects to it to register / query. This mirrors
//  the claim-or-connect pattern already used by Random mode's slots.
// ═══════════════════════════════════════════════════

const REGISTRY_PEER_ID        = "coterie-active-server-registry-v1";
const REGISTRY_HEARTBEAT_MS   = 5000;   // hosts re-announce on this cadence
const REGISTRY_STALE_MS       = 18000;  // entries older than this are pruned
const REGISTRY_QUERY_TIMEOUT  = 4000;   // give up listing servers after this

let   registryHolderPeer = null;        // non-null only if THIS client holds the registry
const registeredServers  = new Map();   // (holder only) roomId → { hostName, participantCount, updatedAt }
let   registryAnnounceConn = null;       // host's data connection to the registry
let   registryAnnounceTimer = null;      // host's heartbeat interval

// ─── Platform-wide stats (holder only, reset when holder changes / page reloads) ─
let registryStatsRoomsCreatedToday  = 0;
let registryStatsPeakConcurrentUsers = 0;
let registryStatsTotalBansIssued    = 0;

// Returns the current total of live platform users (room participants only).
function calculateCurrentConcurrentUsers() {
  let roomParticipantCount = 0;
  for (const server of registeredServers.values()) {
    roomParticipantCount += server.participantCount ?? 1;
  }
  return roomParticipantCount;
}

function updateRegistryPeakConcurrentUsers() {
  const current = calculateCurrentConcurrentUsers();
  if (current > registryStatsPeakConcurrentUsers) {
    registryStatsPeakConcurrentUsers = current;
  }
}

// Returns current session stats for dev.js's dashboard refresh.
async function queryPlatformStats() {
  return {
    roomsCreatedToday:   registryStatsRoomsCreatedToday,
    peakConcurrentUsers: registryStatsPeakConcurrentUsers,
    totalBansIssued:     registryStatsTotalBansIssued,
  };
}


// ═══════════════════════════════════════════════════
//  PERSISTENCE — USERNAME & RECENT ROOMS
// ═══════════════════════════════════════════════════

const STORAGE_KEY_USERNAME     = "coterie_username";
const STORAGE_KEY_RECENT_ROOMS = "coterie_recent_rooms";
const MAX_RECENT_ROOMS         = 20;

// ─── Creator badge ───────────────────────────────
const STORAGE_KEY_CREATOR = "coterie_creator_verified";
// CREATOR_PASSWORD is defined below alongside the creator badge helpers.

// Set just before a forced reload so we auto-join the new room on next load.
const STORAGE_KEY_PENDING_MOVE = "coterie_pending_move";

// Persists across sessions: true once the user correctly enters the password
// or imports a creator marker file.
// ─── Stable per-device number ────────────────────
// Generated once and remembered. Used to identify a participant for moderation.
const STORAGE_KEY_USER_NUMBER = "coterie_user_number";

function loadOrCreateUserNumber() {
  let stored = localStorage.getItem(STORAGE_KEY_USER_NUMBER);
  if (!stored) {
    stored = String(Math.floor(10000000 + Math.random() * 90000000));
    localStorage.setItem(STORAGE_KEY_USER_NUMBER, stored);
  }
  return stored;
}

const userNumber = loadOrCreateUserNumber();

let isCreator = localStorage.getItem(STORAGE_KEY_CREATOR) === "1";


// ─── Username helpers ─────────────────────────────

function loadSavedUsername() {
  return localStorage.getItem(STORAGE_KEY_USERNAME) ?? "";
}

function persistUsername(name) {
  localStorage.setItem(STORAGE_KEY_USERNAME, name);
}

// ─── Recent-rooms helpers ─────────────────────────

function loadRecentRooms() {
  try   { return JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT_ROOMS) ?? "[]"); }
  catch (_) { return []; }
}

function saveRecentRoom(roomId, wasHost) {
  const rooms = loadRecentRooms().filter(r => r.id !== roomId); // dedupe
  rooms.unshift({ id: roomId, joinedAt: Date.now(), wasHost });
  localStorage.setItem(STORAGE_KEY_RECENT_ROOMS, JSON.stringify(rooms.slice(0, MAX_RECENT_ROOMS)));
  renderRecentRoomsList();
}

function deleteRecentRoom(roomId) {
  const rooms = loadRecentRooms().filter(r => r.id !== roomId);
  localStorage.setItem(STORAGE_KEY_RECENT_ROOMS, JSON.stringify(rooms));
  renderRecentRoomsList();
}

function clearAllRecentRooms() {
  localStorage.removeItem(STORAGE_KEY_RECENT_ROOMS);
  renderRecentRoomsList();
}

function exportRecentRooms() {
  const blob   = new Blob([JSON.stringify(loadRecentRooms(), null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href     = URL.createObjectURL(blob);
  anchor.download = "coterie-recent-rooms.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

// Accepts: array of room-id strings, or objects with at least { id }
function importRoomsFromArray(items) {
  // Check for the creator activation marker: { "person": "creator" }
  const hasCreatorMarker = items.some(
    (item) => typeof item === "object" && item !== null && item.person === "creator"
  );
  if (hasCreatorMarker) {
    if (isCreator) {
      setLobbyStatus("Creator badge already active.");
    } else {
      activateCreator();
      setLobbyStatus("Creator badge activated! 🎉");
    }
  }

  const existing    = loadRecentRooms();
  const existingIds = new Set(existing.map(r => r.id));
  let   added       = 0;

  for (const item of items) {
    const roomId = (typeof item === "string" ? item : String(item.id ?? "")).trim();
    if (!roomId || existingIds.has(roomId)) continue;
    existing.push({ id: roomId, joinedAt: item.joinedAt ?? Date.now(), wasHost: item.wasHost ?? false });
    existingIds.add(roomId);
    added++;
  }

  existing.sort((a, b) => b.joinedAt - a.joinedAt);
  localStorage.setItem(STORAGE_KEY_RECENT_ROOMS, JSON.stringify(existing.slice(0, MAX_RECENT_ROOMS)));
  renderRecentRoomsList();
  return added;
}

async function importRoomsFromUrl(urlString) {
  const response = await fetch(urlString);
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data  = await response.json();
  const items = Array.isArray(data) ? data : [data];
  return importRoomsFromArray(items);
}

// ─── Relative time helper ─────────────────────────

function formatRelativeTime(timestamp) {
  const diffMs  = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)          return "just now";
  if (diffMin < 60)         return diffMin + "m ago";
  const diffHr  = Math.floor(diffMin / 60);
  if (diffHr  < 24)         return diffHr + "h ago";
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7)          return diffDay + "d ago";
  return new Date(timestamp).toLocaleDateString();
}

// ─── Recent-rooms DOM refs ─────────────────────────

const recentRoomsSectionEl = document.getElementById("recent-rooms-section");
const recentRoomsListEl    = document.getElementById("recent-rooms-list");
const exportRecentsBtnEl   = document.getElementById("export-recents-btn");
const clearRecentsBtnEl    = document.getElementById("clear-recents-btn");
const importFileInputEl    = document.getElementById("import-file-input");
const importUrlInputEl     = document.getElementById("import-url-input");
const importUrlBtnEl       = document.getElementById("import-url-btn");

// ─── Render recent-rooms list ─────────────────────

function renderRecentRoomsList() {
  const rooms = loadRecentRooms();

  if (rooms.length === 0) {
    recentRoomsSectionEl.classList.add("hidden");
    return;
  }

  recentRoomsSectionEl.classList.remove("hidden");
  recentRoomsListEl.innerHTML = "";

  for (const room of rooms) {
    const rowEl = document.createElement("div");
    rowEl.className = "recent-room-row";

    // Clicking the ID fills the join input
    const idBtnEl       = document.createElement("button");
    idBtnEl.className   = "recent-room-id";
    idBtnEl.textContent = room.id;
    idBtnEl.title       = "Click to fill join field";
    idBtnEl.addEventListener("click", () => {
      roomIdInputEl.value = room.id;
      roomIdInputEl.focus();
    });

    const tagEl       = document.createElement("span");
    tagEl.className   = "recent-room-tag";
    tagEl.textContent = room.wasHost ? "Host" : "Guest";

    const timeEl       = document.createElement("span");
    timeEl.className   = "recent-room-time";
    timeEl.textContent = formatRelativeTime(room.joinedAt);

    const delBtnEl = document.createElement("button");
    delBtnEl.className = "recent-room-delete";
    delBtnEl.title     = "Remove";
    delBtnEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delBtnEl.addEventListener("click", () => deleteRecentRoom(room.id));

    rowEl.append(idBtnEl, tagEl, timeEl, delBtnEl);
    recentRoomsListEl.appendChild(rowEl);
  }
}


// ═══════════════════════════════════════════════════
//  PROFANITY FILTER
// ═══════════════════════════════════════════════════

const PROFANITY_BLOCKLIST = [
  "fuck", "shit", "ass", "bitch", "cunt", "dick", "cock", "pussy",
  "nigger", "nigga", "faggot", "fag", "whore", "slut", "bastard",
  "piss", "twat", "wank", "arse", "bollocks", "asshole", "jackass",
  "retard", "rape", "nazi", "hitler", "motherfuck"
];

// Returns an error string if invalid, or null if the name is acceptable.
function validateScreenName(rawName) {
  const name = rawName.trim();

  if (name.length < 2)  return "Name must be at least 2 characters.";
  if (name.length > 20) return "Name must be 20 characters or less.";

  if (!/^[a-zA-Z0-9 _\-]+$/.test(name)) {
    return "Only letters, numbers, spaces, _ and - are allowed.";
  }

  // Strip separators before checking for blocked words so "f-u-c-k" is caught
  const compressedName = name.toLowerCase().replace(/[\s_\-]/g, "");
  for (const blockedWord of PROFANITY_BLOCKLIST) {
    if (compressedName.includes(blockedWord)) {
      return "That name isn't allowed. Please choose something appropriate.";
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════
//  DOM REFS — ROOMS
// ═══════════════════════════════════════════════════

// ─── Username screen ──────────────────────────────
const usernameScreenEl    = document.getElementById("username-screen");
const screenNameInputEl   = document.getElementById("screen-name-input");
const screenNameCounterEl = document.getElementById("screen-name-counter");
const continueBtnEl       = document.getElementById("continue-btn");
const usernameErrorEl     = document.getElementById("username-error");

const homeScreenEl     = document.getElementById("home-screen");
const lobbyScreenEl    = document.getElementById("lobby-screen");
const appScreenEl      = document.getElementById("app-screen");
const roomIdInputEl    = document.getElementById("room-id-input");
const createRoomBtnEl  = document.getElementById("create-room-btn");
const joinRoomBtnEl    = document.getElementById("join-room-btn");
const lobbyStatusEl    = document.getElementById("lobby-status");
const roomIdLabelEl    = document.getElementById("room-id-label");
const roomNameLabelEl  = document.getElementById("room-name-label");
const copyIdBtnEl      = document.getElementById("copy-id-btn");
const roomCodeOverlayEl     = document.getElementById("room-code-overlay");
const roomCodeOverlayTextEl = document.getElementById("room-code-overlay-text");
const usersCountBtnEl       = document.getElementById("users-count-btn");
const usersCountEl          = document.getElementById("users-count");
const participantsPanelEl   = document.getElementById("participants-panel");
const participantsListEl    = participantsPanelEl.querySelector(".participants-list");
const closePanelBtnEl       = document.getElementById("close-panel-btn");
const usersBarEl       = document.getElementById("users-bar");
const chatLogEl        = document.getElementById("chat-log");
const chatInputEl      = document.getElementById("chat-input");
const sendBtnEl        = document.getElementById("send-btn");
const leaveBtnEl       = document.getElementById("leave-btn");
const videoGridEl      = document.getElementById("video-grid");
const muteBtnEl        = document.getElementById("mute-btn");
const camBtnEl         = document.getElementById("cam-btn");
const hostActionMenuEl = document.getElementById("host-action-menu");
const screenShareBtnEl = document.getElementById("screen-share-btn");
const raiseHandBtnEl   = document.getElementById("raise-hand-btn");

// ─── Broadcast overlay ───────────────────────────
const broadcastOverlayEl     = document.getElementById("broadcast-overlay");
const broadcastMessageTextEl = document.getElementById("broadcast-message-text");
const broadcastDismissBtnEl  = document.getElementById("broadcast-dismiss-btn");
const broadcastTimerBadgeEl  = document.getElementById("broadcast-timer-badge");
let   broadcastCountdownTimer = null;

// ─── Create Room modal DOM refs ───────────────────
const createRoomModalEl      = document.getElementById("create-room-modal");
const roomNameInputEl        = document.getElementById("room-name-input");
const roomNameCounterEl      = document.getElementById("room-name-counter");
const roomMaxSizeSelectEl    = document.getElementById("room-max-size-select");
const createRoomErrorEl      = document.getElementById("create-room-error");
const createRoomCancelBtnEl  = document.getElementById("create-room-cancel-btn");
const createRoomConfirmBtnEl = document.getElementById("create-room-confirm-btn");
const roomPasswordInputEl    = document.getElementById("room-password-input");
const roomPasswordToggleBtnEl = document.getElementById("room-password-toggle");
const roomLockBadgeEl        = document.getElementById("room-lock-badge");
// Dev-only persistent room ID field (hidden for regular users).
const persistentRoomIdFieldEl = document.getElementById("persistent-room-id-field");
const persistentRoomIdInputEl = document.getElementById("persistent-room-id-input");
const guestPasswordModalEl   = document.getElementById("guest-password-modal");
const guestPasswordDescEl    = document.getElementById("guest-password-modal-desc");
const guestPasswordEntryEl   = document.getElementById("guest-password-entry");
const guestPasswordToggleBtnEl = document.getElementById("guest-password-toggle");
const guestPasswordErrorEl   = document.getElementById("guest-password-error");
const guestPasswordSubmitBtnEl = document.getElementById("guest-password-submit-btn");
const guestPasswordCancelBtnEl = document.getElementById("guest-password-cancel-btn");


// ═══════════════════════════════════════════════════
//  RECENT ROOMS — EVENT LISTENERS
// ═══════════════════════════════════════════════════

exportRecentsBtnEl.addEventListener("click", () => exportRecentRooms());

clearRecentsBtnEl.addEventListener("click", () => {
  if (loadRecentRooms().length === 0) return;
  clearAllRecentRooms();
});

importFileInputEl.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data  = JSON.parse(ev.target.result);
      const items = Array.isArray(data) ? data : [data];
      const added = importRoomsFromArray(items);
      setLobbyStatus("Imported " + added + " new room" + (added !== 1 ? "s" : "") + ".");
    } catch (_) {
      setLobbyStatus("Could not parse JSON file.", true);
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

importUrlBtnEl.addEventListener("click", async () => {
  const url = importUrlInputEl.value.trim();
  if (!url) return;
  importUrlBtnEl.disabled    = true;
  importUrlBtnEl.textContent = "Fetching…";
  try {
    const added = await importRoomsFromUrl(url);
    setLobbyStatus("Imported " + added + " new room" + (added !== 1 ? "s" : "") + ".");
    importUrlInputEl.value = "";
  } catch (err) {
    setLobbyStatus("Fetch failed: " + err.message, true);
  } finally {
    importUrlBtnEl.disabled    = false;
    importUrlBtnEl.textContent = "Fetch";
  }
});


// ═══════════════════════════════════════════════════
//  HOME SCREEN NAVIGATION
// ═══════════════════════════════════════════════════

document.getElementById("select-rooms-btn").addEventListener("click", () => {
  homeScreenEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
  renderRecentRoomsList();
  renderCreatorStatus();
});

// "Remove" button inside the lobby's creator-status row.
document.getElementById("creator-remove-btn")?.addEventListener("click", () => {
  deactivateCreator();
  setLobbyStatus("Creator badge removed.");
});


document.getElementById("lobby-back-btn").addEventListener("click", () => {
  lobbyScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
  setLobbyStatus("");
  createRoomBtnEl.disabled = false;
  joinRoomBtnEl.disabled   = false;
});


// ═══════════════════════════════════════════════════
//  ROOM BROWSER
// ═══════════════════════════════════════════════════

const roomBrowserScreenEl = document.getElementById("room-browser-screen");
const rbHidePasswordedEl  = document.getElementById("rb-hide-passworded");
const rbRoomListEl        = document.getElementById("rb-room-list");
const rbStatusEl          = document.getElementById("rb-status");
const rbCreateBtnEl       = document.getElementById("rb-create-btn");
const rbRefreshBtnEl      = document.getElementById("rb-refresh-btn");
const rbJoinInputEl       = document.getElementById("rb-join-input");
const rbJoinBtnEl         = document.getElementById("rb-join-btn");
const rbCreatorBarEl      = document.getElementById("rb-creator-status");

// Cached full list for re-filtering without a network round-trip.
let rbCachedRooms = [];

const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13"
  fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg>`;

function renderRoomBrowserCreatorBar() {
  if (!rbCreatorBarEl) return;
  rbCreatorBarEl.classList.toggle("hidden", !isCreator);
}

function renderRoomBrowserList() {
  const hidePassworded = rbHidePasswordedEl?.checked ?? false;
  const rooms = hidePassworded
    ? rbCachedRooms.filter(r => !r.isPassworded)
    : rbCachedRooms;

  rbRoomListEl.innerHTML = "";

  if (rooms.length === 0) {
    const el = document.createElement("p");
    el.className   = "lob-empty";
    el.textContent = rbCachedRooms.length === 0
      ? "No active rooms right now — create one below."
      : "All rooms are password-protected.";
    rbRoomListEl.appendChild(el);
    return;
  }

  for (const room of rooms) {
    const row = document.createElement("div");
    row.className = "lob-row";

    // Col 1: lock + name + host
    const nameCell = document.createElement("div");
    nameCell.className = "lob-row-name";

    if (room.isPassworded) {
      const lock = document.createElement("span");
      lock.className = "lob-lock";
      lock.innerHTML = LOCK_SVG;
      lock.title     = "Password protected";
      nameCell.appendChild(lock);
    }

    const wrap = document.createElement("div");
    wrap.className = "lob-name-wrap";
    const rname = document.createElement("span");
    rname.className   = "lob-rname";
    rname.textContent = room.roomName || "Unnamed Room";
    const rhost = document.createElement("span");
    rhost.className   = "lob-rhost";
    rhost.textContent = "hosted by " + (room.hostName || "Unknown");
    wrap.append(rname, rhost);
    nameCell.appendChild(wrap);

    // Col 2: count
    const countCell = document.createElement("div");
    countCell.className   = "lob-row-count";
    countCell.textContent = (room.participantCount ?? 1) + (room.maxSize ? " / " + room.maxSize : "");

    // Col 3: join button
    const actionCell = document.createElement("div");
    actionCell.className = "lob-row-action";
    const joinBtn = document.createElement("button");
    joinBtn.className   = "lob-join-btn";
    joinBtn.textContent = "Join →";
    joinBtn.addEventListener("click", e => { e.stopPropagation(); rbJoinRoom(room.roomId); });
    actionCell.appendChild(joinBtn);

    row.append(nameCell, countCell, actionCell);
    row.addEventListener("click", () => rbJoinRoom(room.roomId));
    rbRoomListEl.appendChild(row);
  }
}

function rbJoinRoom(roomId) {
  if (!roomId) return;
  rbCreateBtnEl.disabled = true;
  rbJoinBtnEl.disabled   = true;
  setLobbyStatus("Connecting…");
  // Route through existing startJoinRoom machinery
  currentUsername = screenName;
  isHost          = false;
  joinRoom(roomId);
}

async function openRoomBrowser() {
  usernameScreenEl.classList.add("hidden");
  homeScreenEl.classList.add("hidden");
  lobbyScreenEl.classList.add("hidden");
  roomBrowserScreenEl.classList.remove("hidden");

  // Populate welcome name and permanent #ID pill
  const welcomeNameEl = document.getElementById("lob-username");
  if (welcomeNameEl) welcomeNameEl.textContent = "Welcome, " + screenName;

  const myIdPillEl = document.getElementById("lob-my-id");
  if (myIdPillEl) myIdPillEl.textContent = "#" + userNumber;

  // Clear the online pill until rooms load
  const onlinePillEl = document.getElementById("lob-count-pill");
  if (onlinePillEl) onlinePillEl.textContent = "";

  renderRoomBrowserCreatorBar();
  await refreshRoomBrowser();
}

async function refreshRoomBrowser() {
  rbRoomListEl.innerHTML  = `<p class="rb-empty">Loading rooms…</p>`;
  rbRefreshBtnEl.disabled = true;
  rbRefreshBtnEl.textContent = "Loading…";
  try {
    rbCachedRooms = await fetchActiveServers();
  } catch (_) {
    rbCachedRooms = [];
  }
  renderRoomBrowserList();

  // Update online pill with room count
  const onlinePillEl = document.getElementById("lob-count-pill");
  if (onlinePillEl) {
    const count = rbCachedRooms.length;
    onlinePillEl.textContent = count === 0
      ? "No rooms online"
      : count === 1 ? "1 room online" : count + " rooms online";
  }
  rbRefreshBtnEl.disabled    = false;
  rbRefreshBtnEl.textContent = "↺ Refresh";
}

// ─── Room browser event listeners ─────────────────

rbHidePasswordedEl?.addEventListener("change", () => renderRoomBrowserList());

rbRefreshBtnEl?.addEventListener("click", () => refreshRoomBrowser());

rbCreateBtnEl?.addEventListener("click", () => {
  currentUsername = screenName;
  isHost          = true;
  rbCreateBtnEl.disabled = true;
  openCreateRoomModal();
});

rbJoinBtnEl?.addEventListener("click", () => {
  const targetId = rbJoinInputEl.value.trim();
  if (!targetId) { setLobbyStatus("Please enter a Room ID.", true); return; }
  rbJoinRoom(targetId);
});

rbJoinInputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); rbJoinBtnEl.click(); }
});

document.getElementById("rb-dashboard-btn")?.addEventListener("click", () => {
  if (isCreator) window.location.href = "./Dev/";
});

document.getElementById("rb-uncreator-btn")?.addEventListener("click", () => {
  deactivateCreator();
  renderRoomBrowserCreatorBar();
});

// ═══════════════════════════════════════════════════
//  USERNAME SCREEN
// ═══════════════════════════════════════════════════

function attemptContinue() {
  const validationError = validateScreenName(screenNameInputEl.value);
  if (validationError) {
    usernameErrorEl.textContent = validationError;
    screenNameInputEl.focus();
    return;
  }
  screenName = screenNameInputEl.value.trim();
  persistUsername(screenName);
  usernameScreenEl.classList.add("hidden");

  // If the user arrived via a ?room= link, drop them straight into that room.
  const pendingUrlRoom     = sessionStorage.getItem("coterie_url_room");
  const pendingUrlRoomName = sessionStorage.getItem("coterie_url_room_name") ?? "";
  const pendingUrlPassword = sessionStorage.getItem("coterie_url_password") ?? "";
  if (pendingUrlRoom) {
    sessionStorage.removeItem("coterie_url_room");
    sessionStorage.removeItem("coterie_url_room_name");
    sessionStorage.removeItem("coterie_url_password");
    if (pendingUrlRoomName) currentRoomName = pendingUrlRoomName;
    // Pass the password forward so rooms.js can auto-submit it on the welcome message.
    if (pendingUrlPassword) sessionStorage.setItem("coterie_pending_password", pendingUrlPassword);
    setLobbyStatus(pendingUrlRoomName ? 'Joining "' + pendingUrlRoomName + '"…' : "Joining room from link…");
    startJoinRoom(pendingUrlRoom);
    return;
  }

  openRoomBrowser();
}

// Pre-fill saved username (if any) so the user doesn't have to retype it
const savedUsername = loadSavedUsername();
if (savedUsername) {
  screenNameInputEl.value         = savedUsername;
  screenNameCounterEl.textContent = savedUsername.length + " / 20";
  continueBtnEl.textContent       = `Continue as ${savedUsername} →`;
}

// Update the live character counter as the user types
screenNameInputEl.addEventListener("input", () => {
  const currentLength = screenNameInputEl.value.length;
  screenNameCounterEl.textContent = `${currentLength} / 20`;
  screenNameCounterEl.classList.toggle("near-limit", currentLength >= 16);
  usernameErrorEl.textContent   = "";
  // Reset button label to default once the user starts editing
  continueBtnEl.textContent = "Continue →";
});

screenNameInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); attemptContinue(); }
});

continueBtnEl.addEventListener("click", () => attemptContinue());

// If we were relocated by a creator/host, skip the menus and auto-join the
// target room as soon as we reload (the screen name is already saved).
let _resumedByPendingMove = false;
(function resumePendingMove() {
  const pendingRoomId = sessionStorage.getItem(STORAGE_KEY_PENDING_MOVE);
  if (!pendingRoomId) return;
  _resumedByPendingMove = true;
  sessionStorage.removeItem(STORAGE_KEY_PENDING_MOVE);

  const savedName = loadSavedUsername();
  if (!savedName) return; // can't auto-join without a screen name

  screenName = savedName;
  usernameScreenEl.classList.add("hidden");
  setLobbyStatus("Moving you to the new room…");
  startJoinRoom(pendingRoomId);
})();

// If the URL contains ?room=abc, auto-join that room on load.
// If the user has no saved name yet, store the ID for use after name entry.
(function resumeRoomFromUrl() {
  if (_resumedByPendingMove) return; // force-move already handled startup
  const params      = new URLSearchParams(window.location.search);
  const urlRoomId   = params.get("room");
  const urlRoomName = (params.get("name") ?? "").trim();
  const urlPassword = params.get("password") ?? "";
  if (!urlRoomId) return;

  const savedName = loadSavedUsername();
  if (!savedName) {
    // Stash all three — attemptContinue() will pick them up after name entry.
    sessionStorage.setItem("coterie_url_room", urlRoomId);
    if (urlRoomName) sessionStorage.setItem("coterie_url_room_name", urlRoomName);
    if (urlPassword) sessionStorage.setItem("coterie_url_password", urlPassword);
    return;
  }

  // Has a saved name — prepare shared state and hand off to rooms.js.
  //
  // We CANNOT call startJoinRoom() here: main.js executes before rooms.js
  // (deferred scripts run in listed order), so startJoinRoom is not yet
  // defined at this point. Instead we store the room ID in sessionStorage
  // with a dedicated key; the _resumeUrlRoomIfPending IIFE at the bottom
  // of rooms.js reads it and calls startJoinRoom() once the function exists.
  screenName = savedName;
  if (urlRoomName) currentRoomName = urlRoomName;
  if (urlPassword) sessionStorage.setItem("coterie_pending_password", urlPassword);
  sessionStorage.setItem("coterie_url_room_direct", urlRoomId);
  usernameScreenEl.classList.add("hidden");
  setLobbyStatus(urlRoomName ? 'Joining "' + urlRoomName + '"…' : "Joining room from link…");
})();

// ═══════════════════════════════════════════════════
//  GUEST PASSWORD MODAL
// ═══════════════════════════════════════════════════

function openGuestPasswordModal(roomName) {
  guestPasswordEntryEl.value       = "";
  guestPasswordErrorEl.textContent = "";
  guestPasswordDescEl.textContent  = roomName
    ? '"' + roomName + '" requires a password to join.'
    : "This room requires a password to join.";
  guestPasswordModalEl.classList.remove("hidden");
  setTimeout(() => guestPasswordEntryEl.focus(), 50);
}

function closeGuestPasswordModal() {
  guestPasswordModalEl.classList.add("hidden");
}

function showGuestPasswordError(message) {
  guestPasswordErrorEl.textContent = message;
  guestPasswordEntryEl.value       = "";
  guestPasswordEntryEl.focus();
}

function submitGuestPassword() {
  const password = guestPasswordEntryEl.value;
  if (!password) { showGuestPasswordError("Please enter the password."); return; }
  hostConnection?.send({ type: "password_attempt", password });
  guestPasswordSubmitBtnEl.disabled    = true;
  guestPasswordSubmitBtnEl.textContent = "Checking…";
  // Re-enable after a moment so the user can retry if the error comes back
  setTimeout(() => {
    guestPasswordSubmitBtnEl.disabled    = false;
    guestPasswordSubmitBtnEl.textContent = "Join →";
  }, 1500);
}

// ── Guest password modal event listeners ─────────────
guestPasswordSubmitBtnEl?.addEventListener("click", () => submitGuestPassword());

guestPasswordCancelBtnEl?.addEventListener("click", () => {
  closeGuestPasswordModal();
  peer?.destroy();
  clearRoomFromUrl();
  location.reload();
});

guestPasswordEntryEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitGuestPassword(); }
});

guestPasswordToggleBtnEl?.addEventListener("click", () => {
  const isHidden = guestPasswordEntryEl.type === "password";
  guestPasswordEntryEl.type = isHidden ? "text" : "password";
  guestPasswordToggleBtnEl.classList.toggle("is-showing", isHidden);
  guestPasswordToggleBtnEl.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
});

// ── Host password field: show/hide toggle ────────────
roomPasswordToggleBtnEl?.addEventListener("click", () => {
  const isHidden = roomPasswordInputEl.type === "password";
  roomPasswordInputEl.type = isHidden ? "text" : "password";
  roomPasswordToggleBtnEl.classList.toggle("is-showing", isHidden);
  roomPasswordToggleBtnEl.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
});

// ═══════════════════════════════════════════════════
//  CREATE ROOM MODAL
// ═══════════════════════════════════════════════════

function openCreateRoomModal() {
  roomNameInputEl.value         = "";
  roomNameCounterEl.textContent = "0 / 30";
  roomMaxSizeSelectEl.value     = "0";
  roomPasswordInputEl.value     = "";
  createRoomErrorEl.textContent = "";

  // Show the persistent room ID field only to verified creators.
  if (persistentRoomIdFieldEl) {
    persistentRoomIdFieldEl.classList.toggle("hidden", !isCreator);
    persistentRoomIdInputEl.value = "";
  }

  createRoomModalEl.classList.remove("hidden");
  setTimeout(() => roomNameInputEl.focus(), 50);
}

function closeCreateRoomModal() {
  createRoomModalEl.classList.add("hidden");
}

function submitCreateRoom() {
  const rawRoomName = roomNameInputEl.value.trim();

  if (rawRoomName.length > 0) {
    if (!/^[a-zA-Z0-9 _\-]+$/.test(rawRoomName)) {
      createRoomErrorEl.textContent = "Only letters, numbers, spaces, _ and - are allowed.";
      return;
    }
    const compressedName = rawRoomName.toLowerCase().replace(/[\s_\-]/g, "");
    for (const blockedWord of PROFANITY_BLOCKLIST) {
      if (compressedName.includes(blockedWord)) {
        createRoomErrorEl.textContent = "That name isn't allowed. Please choose something appropriate.";
        return;
      }
    }
  }

  currentRoomName    = rawRoomName;
  currentRoomMaxSize = parseInt(roomMaxSizeSelectEl.value, 10);
  currentRoomPassword = roomPasswordInputEl.value;   // empty = open room

  // ── Persistent room ID (dev-only) ────────────────────────────────────────
  // Reserved internal prefixes that must never be used as custom IDs.
  const RESERVED_ID_PREFIXES = ["coterie-fo-", "coterie-active-server-registry"];

  let persistentRoomId = "";
  if (isCreator && persistentRoomIdInputEl) {
    const rawPersistentId = persistentRoomIdInputEl.value.trim().toLowerCase();
    if (rawPersistentId.length > 0) {
      if (!/^[a-z0-9-]+$/.test(rawPersistentId)) {
        createRoomErrorEl.textContent = "Room ID: only lowercase letters, numbers, and hyphens allowed.";
        return;
      }
      if (rawPersistentId.length < 4) {
        createRoomErrorEl.textContent = "Room ID must be at least 4 characters.";
        return;
      }
      const usesReservedPrefix = RESERVED_ID_PREFIXES.some((prefix) =>
        rawPersistentId.startsWith(prefix)
      );
      if (usesReservedPrefix) {
        createRoomErrorEl.textContent = "That Room ID is reserved for internal use.";
        return;
      }
      persistentRoomId = rawPersistentId;
    }
  }

  closeCreateRoomModal();

  currentUsername          = screenName;
  isHost                   = true;
  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled   = true;
  setLobbyStatus("Creating room...");
  createRoom(persistentRoomId || undefined);
}

createRoomCancelBtnEl.addEventListener("click", () => closeCreateRoomModal());
createRoomConfirmBtnEl.addEventListener("click", () => submitCreateRoom());

roomNameInputEl.addEventListener("input", () => {
  roomNameCounterEl.textContent = roomNameInputEl.value.length + " / 30";
  createRoomErrorEl.textContent = "";
});

roomNameInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter")  { e.preventDefault(); submitCreateRoom(); }
  if (e.key === "Escape") { closeCreateRoomModal(); }
});

createRoomModalEl.addEventListener("click", (e) => {
  if (e.target === createRoomModalEl) closeCreateRoomModal();
});

// ─── Clean disconnect when the tab is closed or navigated away ───────────────
// "pagehide" fires reliably on mobile/modern browsers; "beforeunload" covers
// older desktop engines. peer.destroy() is safe to call even if already gone.
window.addEventListener("pagehide",     () => { peer?.destroy(); });
window.addEventListener("beforeunload", () => { peer?.destroy(); });

// ═══════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
//
//  Replaces bare alert() calls with non-blocking slide-in toasts.
//  Toasts stack from bottom-right and auto-dismiss after `durationMs`.
//  Calling code can pass type: 'info' | 'success' | 'error' | 'warn'.
// ═══════════════════════════════════════════════════

const TOAST_ICONS = {
  info:    'ℹ️',
  success: '✅',
  error:   '🚫',
  warn:    '⚠️',
};

const TOAST_TITLES = {
  info:    'Info',
  success: 'Done',
  error:   'Removed',
  warn:    'Warning',
};

function showToast(message, type = 'info', durationMs = 5000) {
  const containerEl = document.getElementById('toast-container');
  if (!containerEl) return;

  const toastEl = document.createElement('div');
  toastEl.className = `toast toast--${type}`;
  toastEl.setAttribute('role', 'alert');

  const iconEl = document.createElement('span');
  iconEl.className     = 'toast-icon';
  iconEl.textContent   = TOAST_ICONS[type] ?? 'ℹ️';
  iconEl.setAttribute('aria-hidden', 'true');

  const bodyEl = document.createElement('div');
  bodyEl.className = 'toast-body';

  const titleEl = document.createElement('div');
  titleEl.className   = 'toast-title';
  titleEl.textContent = TOAST_TITLES[type] ?? 'Notice';

  const messageEl = document.createElement('div');
  messageEl.className   = 'toast-message';
  messageEl.textContent = message;

  bodyEl.append(titleEl, messageEl);

  const closeBtn = document.createElement('button');
  closeBtn.className   = 'toast-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.addEventListener('click', () => dismissToast(toastEl));

  toastEl.append(iconEl, bodyEl, closeBtn);
  containerEl.appendChild(toastEl);

  // Auto-dismiss after the timeout.
  const dismissTimer = setTimeout(() => dismissToast(toastEl), durationMs);

  // Clear the auto-dismiss timer if the user manually closes it first.
  closeBtn.addEventListener('click', () => clearTimeout(dismissTimer), { once: true });
}

function dismissToast(toastEl) {
  if (!toastEl || !toastEl.isConnected) return;
  toastEl.classList.add('toast--dismissing');
  // Remove from DOM after the CSS fade-out completes.
  toastEl.addEventListener('transitionend', () => toastEl.remove(), { once: true });
  // Safety fallback in case transitionend never fires.
  setTimeout(() => toastEl.remove(), 400);
}

// ═══════════════════════════════════════════════════
//  CONNECTION STATUS PILL
//
//  Updates the #conn-status-dot element in the toolbar.
//  The pill's visual style (colour, animation) is driven entirely by
//  the data-status attribute — see .conn-status-dot[data-status="…"] in
//  style.css.  Called by rooms.js whenever the PeerJS peer opens, errors,
//  or the host connection closes.
// ═══════════════════════════════════════════════════

const CONNECTION_STATUS_LABELS = {
  connecting:   'Connecting…',
  connected:    'Connected',
  disconnected: 'Disconnected',
};

function setConnectionStatus(status) {
  const pillEl = document.getElementById('conn-status-dot');
  if (!pillEl) return;
  pillEl.dataset.status = status;
  pillEl.textContent    = CONNECTION_STATUS_LABELS[status] ?? status;
  pillEl.title          = CONNECTION_STATUS_LABELS[status] ?? status;
}
