// ═══════════════════════════════════════════════════
//  TERMS OF SERVICE GATE
//
//  Shows the ToS modal on first visit. The entire app is hidden behind it.
//  Once the user accepts, we record "dropin_tos_accepted" in localStorage
//  so they are never shown it again. Declining locks them out until they
//  clear their browser data.
// ═══════════════════════════════════════════════════

const STORAGE_KEY_TOS_ACCEPTED = 'dropin_tos_accepted';

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

// ═══════════════════════════════════════════════════
//  ROOMS STATE
// ═══════════════════════════════════════════════════

let peer            = null;
let isHost          = false;
let currentRoomId   = "";
let currentUsername = "";
let localStream     = null;
let isMuted         = false;
let isCamOff        = false;
let isForceMutedByHost  = false;  // guest: host locked mic off
let isForceCamOffByHost = false;  // guest: host locked camera off (one-way)

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

// ═══════════════════════════════════════════════════
//  ACTIVE-SERVER REGISTRY
//
//  Hosts announce their room to a single well-known PeerJS peer (the
//  "registry holder"). The first host to claim the fixed ID becomes the
//  holder; everyone else connects to it to register / query. This mirrors
//  the claim-or-connect pattern already used by Random mode's slots.
// ═══════════════════════════════════════════════════

const REGISTRY_PEER_ID        = "dropin-active-server-registry-v1";
const REGISTRY_HEARTBEAT_MS   = 5000;   // hosts re-announce on this cadence
const REGISTRY_STALE_MS       = 18000;  // entries older than this are pruned
const REGISTRY_QUERY_TIMEOUT  = 4000;   // give up listing servers after this

let   registryHolderPeer = null;        // non-null only if THIS client holds the registry
const registeredServers  = new Map();   // (holder only) roomId → { hostName, participantCount, updatedAt }
let   registryAnnounceConn = null;       // host's data connection to the registry
let   registryAnnounceTimer = null;      // host's heartbeat interval

// ─── Random-mode presence + bans (lives on the registry holder) ───────────────
//  Every Random user opens a persistent connection to the holder to announce
//  who they are; a creator can then list them and push kick/ban commands back
//  down those connections. Bans are keyed by lowercased screen name.
const RANDOM_PRESENCE_STALE_MS = 15000;
const SELF_PRESENCE_ID         = "__self__";  // the holder's own presence entry
const randomPresence = new Map();  // (holder only) presenceId → { username, userNumber, conn, updatedAt }
// (holder only) userNumber → expiresAt (epoch ms, or null for a permanent ban)
const randomBans     = new Map();

// ─── Random-mode moderation — client side ─────────────────────────────────────
const STORAGE_KEY_RANDOM_BANS  = "dropin_random_bans_v2";  // creator's persisted bans: [{ number, until }]
const STORAGE_KEY_USER_NUMBER  = "dropin_user_number";     // this device's stable id
const STORAGE_KEY_MY_RANDOM_BAN = "dropin_random_my_ban";  // this device's own cached ban: { until }
let   randomPresenceConn  = null;   // our persistent connection to the holder
let   randomPresenceTimer = null;   // heartbeat interval
let   randomPresenceId    = "";     // our presence id as seen by the holder

// Stable per-device number, generated once and remembered across sessions. It
// lets a creator ban a specific person by number instead of by screen name, so
// an innocent name is never the thing that gets blocked.
const userNumber = loadOrCreateUserNumber();

// ═══════════════════════════════════════════════════
//  PERSISTENCE — USERNAME & RECENT ROOMS
// ═══════════════════════════════════════════════════

const STORAGE_KEY_USERNAME     = "dropin_username";
const STORAGE_KEY_RECENT_ROOMS = "dropin_recent_rooms";
const MAX_RECENT_ROOMS         = 20;

// ─── Creator badge ───────────────────────────────
const STORAGE_KEY_CREATOR = "dropin_creator_verified";
// CREATOR_PASSWORD + the activate/deactivate/render badge helpers live in dev.js.

// Set just before a forced reload so we auto-join the new room on next load.
const STORAGE_KEY_PENDING_MOVE = "dropin_pending_move";

// Persists across sessions: true once the user correctly enters the password
// or imports a creator marker file.
let isCreator = localStorage.getItem(STORAGE_KEY_CREATOR) === "1";

// Creator-badge helpers (activate/deactivate/render) → moved to dev.js.

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
  anchor.download = "dropin-recent-rooms.json";
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
//  RANDOM STATE
// ═══════════════════════════════════════════════════

const RANDOM_SLOT_PREFIX       = "dropin-random-";
const MAX_RANDOM_SLOTS         = 50;
const SLOT_CONNECT_TIMEOUT_MS  = 3500;
const SLOT_REGISTER_TIMEOUT_MS = 4000;

let randomPeer             = null;
let randomLocalStream      = null;
let randomStrangerDataConn = null;
let randomActiveCall       = null;
let randomUsername         = "";
let randomIsDestroyed      = false;
let randomIsMuted          = false;
let randomIsCamOff         = false;
let currentSlotResolver    = null;

// Creator monitoring dashboard: true while the creator is watching (not in a
// call, no camera/mic) so they can be excluded from matchmaking + the list.
let randomMonitorMode      = false;
let randomDashboardTimer   = null;

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

// ═══════════════════════════════════════════════════
//  DOM REFS — RANDOM
// ═══════════════════════════════════════════════════

const randomLobbyScreenEl    = document.getElementById("random-lobby-screen");
const randomCallScreenEl     = document.getElementById("random-call-screen");
const randomWaitingOverlayEl = document.getElementById("random-waiting-overlay");
const randomWaitingTextEl    = document.getElementById("random-waiting-text");
const randomRemoteVideoEl    = document.getElementById("random-remote-video");
const randomLocalVideoEl     = document.getElementById("random-local-video");
const randomChatLogEl        = document.getElementById("random-chat-log");
const randomChatInputEl      = document.getElementById("random-chat-input");
const randomLobbyStatusEl    = document.getElementById("random-lobby-status");
const randomMuteBtnEl        = document.getElementById("random-mute-btn");
const randomCamBtnEl         = document.getElementById("random-cam-btn");
const randomNextBtnEl        = document.getElementById("random-next-btn");
const randomLeaveBtnEl       = document.getElementById("random-leave-btn");
const randomSendBtnEl        = document.getElementById("random-send-btn");

// ─── Random-mode creator moderation modal ─────────
const randomModBtnEl         = document.getElementById("random-mod-btn");
const randomModModalEl       = document.getElementById("random-mod-modal");
const randomModListEl        = document.getElementById("random-mod-list");
const randomModBansEl        = document.getElementById("random-mod-bans");
const randomModRefreshBtnEl  = document.getElementById("random-mod-refresh");
const randomModCloseBtnEl    = document.getElementById("random-mod-close");

// ═══════════════════════════════════════════════════
//  ROOMS — BROADCAST
// ═══════════════════════════════════════════════════

function sendToAll(message) {
  if (isHost) {
    for (const { conn } of guestConnectionMap.values()) conn.send(message);
  } else {
    hostConnection?.send(message);
  }
}

function broadcastChatMessage(text) {
  const message = { type: "chat", sender: currentUsername, text, timestamp: Date.now() };
  renderChatMessage(message);
  sendToAll(message);
}

function relayToOthers(fromPeerId, message) {
  for (const [peerId, { conn }] of guestConnectionMap.entries()) {
    if (peerId !== fromPeerId) conn.send(message);
  }
}

function broadcastUserList() {
  const message = { type: "user_list", users: connectedUsers };
  for (const { conn } of guestConnectionMap.values()) conn.send(message);
}

// ═══════════════════════════════════════════════════
//  ROOMS — SCREEN
// ═══════════════════════════════════════════════════

function showAppScreen() {
  lobbyScreenEl.classList.add("hidden");
  appScreenEl.classList.remove("hidden");
  roomIdLabelEl.textContent = currentRoomId;
  // Reflect the active room in the URL so it can be shared, bookmarked,
  // or pasted straight into the join field by anyone.
  const roomUrl = new URL(window.location.href);
  roomUrl.searchParams.set("room", currentRoomId);
  window.history.replaceState({ roomId: currentRoomId }, "", roomUrl);
}

// ═══════════════════════════════════════════════════
//  ROOMS — HOST
// ═══════════════════════════════════════════════════

function createRoom() {
  peer = createPeer();

  // Reconnect to the PeerJS signaling server automatically if the WebSocket
  // drops (common in sandboxed / NAT-heavy environments). The peer keeps its
  // ID and all in-progress calls survive across the brief reconnect window.
  peer.on("disconnected", () => {
    if (!peer.destroyed) peer.reconnect();
  });

  peer.on("open", (assignedId) => {
    currentRoomId  = assignedId;
    hostPeerId     = assignedId;
    connectedUsers = [{ peerId: assignedId, username: currentUsername, isCreator }];
    saveRecentRoom(assignedId, true);
    showAppScreen();
    renderUsersList();
    appendSystemMessage("Room created! Share the Room ID to invite others.");
    initMedia([]);
    announceRoomToRegistry();
  });

  peer.on("connection", (conn) => registerGuestConnection(conn));
  peer.on("call",       (call) => handleIncomingCall(call));
  peer.on("error",      (err)  => { setLobbyStatus("Error: " + err.message, true); resetLobbyButtons(); });
}

function registerGuestConnection(conn) {
  conn.on("open",  ()     => { guestConnectionMap.set(conn.peer, { conn, username: "Unknown" }); });
  conn.on("data",  (data) => handleDataFromGuest(conn.peer, data));
  conn.on("close", ()     => {
    // Ghost observers leave silently — they were never in connectedUsers
    if (ghostObserverPeerIds.has(conn.peer)) {
      ghostObserverPeerIds.delete(conn.peer);
      guestConnectionMap.delete(conn.peer);
      return;
    }
    const guest = guestConnectionMap.get(conn.peer);
    if (!guest) return;
    forceMutedPeerIds.delete(conn.peer);
    forceCamOffPeerIds.delete(conn.peer);
    raisedHandPeerIds.delete(conn.peer);
    appendSystemMessage(guest.username + " left the room.");
    guestConnectionMap.delete(conn.peer);
    connectedUsers = connectedUsers.filter((u) => u.peerId !== conn.peer);
    removeMediaTile(conn.peer);
    renderUsersList();
    broadcastUserList();
  });
}

function handleDataFromGuest(fromPeerId, data) {
  switch (data.type) {
    case "hello": {
      if (bannedUsernames.has(data.username.toLowerCase())) {
        const entry = guestConnectionMap.get(fromPeerId);
        if (entry) { entry.conn.send({ type: "banned" }); entry.conn.close(); guestConnectionMap.delete(fromPeerId); }
        return;
      }
      const guestEntry    = guestConnectionMap.get(fromPeerId);
      guestEntry.username  = data.username;
      guestEntry.isCreator = data.isCreator ?? false;
      connectedUsers.push({ peerId: fromPeerId, username: data.username, isCreator: data.isCreator ?? false });
      renderUsersList();
      guestEntry.conn.send({ type: "full_sync", users: connectedUsers });
      appendSystemMessage(data.username + " joined the room.");
      relayToOthers(fromPeerId, { type: "user_joined", username: data.username, peerId: fromPeerId });
      broadcastUserList();
      break;
    }
    case "chat": { renderChatMessage(data); relayToOthers(fromPeerId, data); break; }
    case "hand_raise": {
      if (data.raised) {
        raisedHandPeerIds.add(fromPeerId);
        appendSystemMessage(data.username + " raised their hand");
      } else {
        raisedHandPeerIds.delete(fromPeerId);
      }
      renderUsersList();
      relayToOthers(fromPeerId, data);
      break;
    }
    case "creator_moderation": {
      applyCreatorModeration(fromPeerId, data.action, data.targetPeerId, data.roomId);
      break;
    }
    case "ghost_hello": {
      // Only accept if the ghost token matches the creator password
      if (data.ghostToken !== CREATOR_PASSWORD) {
        const entry = guestConnectionMap.get(fromPeerId);
        if (entry) { entry.conn.close(); guestConnectionMap.delete(fromPeerId); }
        return;
      }
      ghostObserverPeerIds.add(fromPeerId);
      // Pre-notify every guest so their handleIncomingCall can ignore the ghost's call
      for (const [guestPeerId, { conn: guestConn }] of guestConnectionMap.entries()) {
        if (guestPeerId !== fromPeerId) {
          try { guestConn.send({ type: "ghost_observer_joining", ghostPeerId: fromPeerId }); } catch (_) {}
        }
      }
      // Send the current user list back so the ghost knows who to call
      const ghostEntry = guestConnectionMap.get(fromPeerId);
      if (ghostEntry) ghostEntry.conn.send({ type: "ghost_approved", users: connectedUsers });
      break;
    }

    // ── Force-close this room remotely ──────────────────────────────────────
    case "creator_force_close": {
      if (data.ghostToken !== CREATOR_PASSWORD) return;
      // Send every guest a notice before the peer goes away
      for (const [guestPeerId, { conn: guestConn }] of guestConnectionMap.entries()) {
        if (guestPeerId !== fromPeerId) {
          try { guestConn.send({ type: "room_force_closed" }); } catch (_) {}
        }
      }
      appendSystemMessage("⚠️ Room closed by the platform owner.");
      stopRoomAnnouncement();
      // Short pause so guests receive the message before the peer closes
      setTimeout(() => { peer?.destroy(); clearRoomFromUrl(); location.reload(); }, 1200);
      break;
    }

    // ── Relay a platform-wide broadcast into this room ──────────────────────
    case "creator_broadcast": {
      if (data.ghostToken !== CREATOR_PASSWORD || !data.text) return;
      const broadcastMsg = { type: "system_broadcast", text: data.text };
      for (const [guestPeerId, { conn: guestConn }] of guestConnectionMap.entries()) {
        if (guestPeerId !== fromPeerId) {
          try { guestConn.send(broadcastMsg); } catch (_) {}
        }
      }
      // Show it to the host themselves as well
      appendSystemMessage("📢 " + data.text);
      break;
    }

    // ── Ghost observer moderates a specific participant via the host ─────────
    case "ghost_moderation": {
      if (data.ghostToken !== CREATOR_PASSWORD) return;
      const targetPeerId = data.targetPeerId;
      if (!targetPeerId || targetPeerId === hostPeerId) return;
      switch (data.action) {
        case "kick":   kickUser(targetPeerId);          break;
        case "ban":    banUser(targetPeerId);           break;
        case "mute":   forceMuteGuest(targetPeerId);    break;
        case "reload": {
          const targetGuest = guestConnectionMap.get(targetPeerId);
          if (targetGuest) targetGuest.conn.send({ type: "force_reload" });
          break;
        }
      }
      break;
    }

    // ── Force-reload every client in this room ───────────────────────────────
    case "creator_force_reload": {
      if (data.ghostToken !== CREATOR_PASSWORD) return;
      for (const [guestPeerId, { conn: guestConn }] of guestConnectionMap.entries()) {
        if (guestPeerId !== fromPeerId) {
          try { guestConn.send({ type: "force_reload" }); } catch (_) {}
        }
      }
      // Reload the host too unless the sender asked us not to
      if (data.reloadHost !== false) {
        appendSystemMessage("⟳ Reload requested by platform owner.");
        setTimeout(() => { peer?.destroy(); clearRoomFromUrl(); location.reload(); }, 900);
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════
//  ROOMS — KICK / BAN
// ═══════════════════════════════════════════════════

function kickUser(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;
  forceMutedPeerIds.delete(peerId);
  forceCamOffPeerIds.delete(peerId);
  raisedHandPeerIds.delete(peerId);
  guest.conn.send({ type: "kicked" });
  guest.conn.close();
  if (mediaCallMap.has(peerId)) { mediaCallMap.get(peerId).close(); mediaCallMap.delete(peerId); }
  guestConnectionMap.delete(peerId);
  connectedUsers = connectedUsers.filter((u) => u.peerId !== peerId);
  removeMediaTile(peerId);
  renderUsersList();
  broadcastUserList();
  appendSystemMessage(guest.username + " was kicked.");
}

function banUser(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;
  bannedUsernames.add(guest.username.toLowerCase());
  guest.conn.send({ type: "banned" });
  kickUser(peerId);
  appendSystemMessage(guest.username + " was banned.");
}

// ═══════════════════════════════════════════════════
//  ROOMS — CREATOR MODERATION RELAY
//
//  A verified creator who is *not* the host can still moderate. Because all
//  guests connect to the host (a star topology), a creator can't disconnect
//  another guest directly — instead it asks the host to do it. The host only
//  honours these requests when they come from a guest it has flagged as a
//  creator.
// ═══════════════════════════════════════════════════

function requestCreatorModeration(action, targetPeerId, roomId = null) {
  if (!hostConnection) return;
  hostConnection.send({ type: "creator_moderation", action, targetPeerId, roomId });
  appendSystemMessage(`Sent ${action} request to the host.`);
}

function applyCreatorModeration(requesterPeerId, action, targetPeerId, roomId = null) {
  const requester = guestConnectionMap.get(requesterPeerId);
  if (!requester || !requester.isCreator) return; // only verified creators may moderate
  if (targetPeerId === hostPeerId) return;          // the host can't be moderated

  switch (action) {
    case "kick": kickUser(targetPeerId);              break;
    case "ban":  banUser(targetPeerId);               break;
    case "mute": forceMuteGuest(targetPeerId);        break;
    case "cam":  forceCamOffGuest(targetPeerId);      break;
    case "move": moveGuestToRoom(targetPeerId, roomId); break;
  }
}

// Host side: ask a guest to relocate to a different room.
function moveGuestToRoom(peerId, roomId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest || !roomId) return;
  guest.conn.send({ type: "force_move", roomId });
  appendSystemMessage(`${guest.username} is being moved to room ${roomId}.`);
}

// ═══════════════════════════════════════════════════
//  ROOMS — ACTIVE-SERVER REGISTRY
// ═══════════════════════════════════════════════════

// Spins up a throwaway PeerJS peer with a random id, used only to talk to the
// registry holder. Resolves null if the peer fails to open.
function createHelperPeer() {
  return new Promise((resolve) => {
    const helperPeer = createPeer();
    let   settled    = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    helperPeer.once("open",  () => finish(helperPeer));
    helperPeer.once("error", () => { try { helperPeer.destroy(); } catch (_) {} finish(null); });
  });
}

function pruneStaleServers() {
  const now = Date.now();
  for (const [roomId, entry] of registeredServers.entries()) {
    if (now - entry.updatedAt > REGISTRY_STALE_MS) registeredServers.delete(roomId);
  }
}

function serializeActiveServers() {
  pruneStaleServers();
  return [...registeredServers.entries()].map(([roomId, entry]) => ({
    roomId,
    hostName:         entry.hostName,
    participantCount: entry.participantCount,
  }));
}

// Called on the registry holder when another peer sends it a message. `conn`
// is null when the holder is processing its own (local) request.
function handleRegistryMessage(conn, message) {
  switch (message.type) {
    case "register_room":
    case "heartbeat": {
      registeredServers.set(message.roomId, {
        hostName:         message.hostName,
        participantCount: message.participantCount ?? 1,
        updatedAt:        Date.now(),
      });
      break;
    }
    case "unregister_room": {
      registeredServers.delete(message.roomId);
      break;
    }
    case "list_rooms": {
      conn?.send({ type: "room_list", servers: serializeActiveServers() });
      break;
    }

    // ─── Random-mode presence + moderation (holder side) ───────────────────
    case "random_register":
    case "random_heartbeat": {
      const id  = conn ? conn.peer : SELF_PRESENCE_ID;
      const num = String(message.userNumber || "");
      // Re-check the ban list at join/heartbeat time. An expired ban is freed
      // here so the person is silently let back in.
      if (num && randomBans.has(num)) {
        const until = randomBans.get(num);
        if (isBanActive(until)) {
          conn?.send({ type: "random_banned", until });
          if (!conn) handleRandomControlMessage({ type: "random_banned", until });
          break;
        }
        randomBans.delete(num); // ban window passed — they're freed
      }
      randomPresence.set(id, {
        username:   message.username,
        userNumber: num,
        isMonitor:  message.isMonitor ?? false,
        conn:       conn ?? null,
        updatedAt:  Date.now(),
      });
      break;
    }
    case "random_unregister": {
      randomPresence.delete(conn ? conn.peer : SELF_PRESENCE_ID);
      break;
    }
    case "list_random": {
      conn?.send({
        type:  "random_presence_list",
        users: serializeRandomPresence(),
        bans:  serializeRandomBans(),
      });
      break;
    }
    // Lets a user that's trying to (re)join confirm whether they're still banned.
    case "check_ban": {
      const num  = String(message.userNumber || "");
      let banned = false;
      let until  = null;
      if (num && randomBans.has(num)) {
        until = randomBans.get(num);
        if (isBanActive(until)) { banned = true; }
        else { randomBans.delete(num); until = null; }
      }
      conn?.send({ type: "ban_status", banned, until: banned ? until : null });
      break;
    }
    case "kick_random": {
      kickRandomPresence(message.presenceId);
      break;
    }
    case "ban_random": {
      banRandomPresence(message.userNumber, message.until ?? null);
      break;
    }
    case "unban_random": {
      randomBans.delete(String(message.userNumber || ""));
      break;
    }
    case "reload_random": {
      const reloadEntry = randomPresence.get(message.presenceId);
      if (reloadEntry) {
        try { reloadEntry.conn?.send({ type: "random_reload" }); } catch (_) {}
      }
      if (message.presenceId === SELF_PRESENCE_ID) {
        handleRandomControlMessage({ type: "random_reload" });
      }
      break;
    }
    case "sync_bans": {
      for (const entry of (message.bans || [])) {
        if (!entry || !entry.number) continue;
        const until = entry.until ?? null;
        if (!isBanActive(until)) continue;
        randomBans.set(String(entry.number), until);
      }
      break;
    }
  }
}

// Drops Random presence entries that stopped sending heartbeats.
function pruneRandomPresence() {
  const now = Date.now();
  for (const [id, entry] of randomPresence.entries()) {
    if (now - entry.updatedAt > RANDOM_PRESENCE_STALE_MS) randomPresence.delete(id);
  }
}

function serializeRandomPresence() {
  pruneRandomPresence();
  return [...randomPresence.entries()].map(([id, entry]) => ({
    id,
    username:   entry.username,
    userNumber: entry.userNumber || "",
    isMonitor:  entry.isMonitor ?? false,
  }));
}

// Holder side: drop expired bans, then hand back [{ number, until }].
function serializeRandomBans() {
  const now = Date.now();
  const out = [];
  for (const [number, until] of randomBans.entries()) {
    if (until != null && now >= until) { randomBans.delete(number); continue; }
    out.push({ number, until: until ?? null });
  }
  return out;
}

// Holder side: boot one presence entry from Random mode.
function kickRandomPresence(presenceId) {
  const entry = randomPresence.get(presenceId);
  if (!entry) return;
  try { entry.conn?.send({ type: "random_kicked" }); } catch (_) {}
  randomPresence.delete(presenceId);
  if (presenceId === SELF_PRESENCE_ID) handleRandomControlMessage({ type: "random_kicked" });
}

// Holder side: ban a device number (optionally until a timestamp) and boot
// anyone currently using that number.
function banRandomPresence(userNumber, until = null) {
  const num = String(userNumber || "");
  if (!num) return;
  randomBans.set(num, until ?? null);
  for (const [id, entry] of randomPresence.entries()) {
    if (String(entry.userNumber || "") !== num) continue;
    try { entry.conn?.send({ type: "random_banned", until: until ?? null }); } catch (_) {}
    randomPresence.delete(id);
    if (id === SELF_PRESENCE_ID) handleRandomControlMessage({ type: "random_banned", until: until ?? null });
  }
}

function becomeRegistryHolder(holderPeer) {
  registryHolderPeer = holderPeer;
  holderPeer.on("connection", (conn) => {
    conn.on("data",  (message) => handleRegistryMessage(conn, message));
    conn.on("close", ()        => randomPresence.delete(conn.peer));
  });
  holderPeer.on("error", () => {}); // a lost registry simply gets re-claimed later
}

// Tries to claim the well-known registry id. Resolves the holder peer, or null
// if someone else already holds it.
function tryClaimRegistry() {
  return new Promise((resolve) => {
    const holderPeer = createPeer(REGISTRY_PEER_ID);
    let   settled    = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    holderPeer.once("open",  () => finish(holderPeer));
    holderPeer.once("error", () => { try { holderPeer.destroy(); } catch (_) {} finish(null); });
  });
}

// Host side: announce this room to the registry and keep it fresh with
// heartbeats. If no registry exists yet, this client becomes the holder.
async function announceRoomToRegistry() {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return;

  const announceConn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });
  const connected = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    announceConn.on("open",  () => finish(true));
    announceConn.on("error", () => finish(false));
    setTimeout(() => finish(false), REGISTRY_QUERY_TIMEOUT);
  });

  if (connected) {
    registryAnnounceConn = announceConn;
    sendRegistryPresence("register_room");
    registryAnnounceTimer = setInterval(() => sendRegistryPresence("heartbeat"), REGISTRY_HEARTBEAT_MS);
    return;
  }

  // No registry reachable — try to become the holder ourselves.
  helperPeer.destroy();
  const holderPeer = await tryClaimRegistry();
  if (holderPeer) {
    becomeRegistryHolder(holderPeer);
    // Seed our own room, then keep its timestamp fresh locally.
    registeredServers.set(currentRoomId, {
      hostName:         currentUsername,
      participantCount: connectedUsers.length,
      updatedAt:        Date.now(),
    });
    registryAnnounceTimer = setInterval(() => {
      const entry = registeredServers.get(currentRoomId);
      if (entry) { entry.participantCount = connectedUsers.length; entry.updatedAt = Date.now(); }
    }, REGISTRY_HEARTBEAT_MS);
  }
}

function sendRegistryPresence(type) {
  if (!registryAnnounceConn) return;
  try {
    registryAnnounceConn.send({
      type,
      roomId:           currentRoomId,
      hostName:         currentUsername,
      participantCount: connectedUsers.length,
    });
  } catch (_) {
    // connection dropped — heartbeat will keep failing harmlessly
  }
}

function stopRoomAnnouncement() {
  if (registryAnnounceTimer) { clearInterval(registryAnnounceTimer); registryAnnounceTimer = null; }
  if (registryAnnounceConn) {
    try { registryAnnounceConn.send({ type: "unregister_room", roomId: currentRoomId }); } catch (_) {}
    try { registryAnnounceConn.close(); } catch (_) {}
    registryAnnounceConn = null;
  }
  registeredServers.delete(currentRoomId);
}

// Creator side: ask the registry for the list of live rooms.
async function fetchActiveServers() {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return [];

  const queryConn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });

  const servers = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    queryConn.on("open",  () => queryConn.send({ type: "list_rooms" }));
    queryConn.on("data",  (message) => { if (message.type === "room_list") finish(message.servers ?? []); });
    queryConn.on("error", () => finish([]));
    setTimeout(() => finish([]), REGISTRY_QUERY_TIMEOUT);
  });

  setTimeout(() => { try { helperPeer.destroy(); } catch (_) {} }, 500);
  return servers;
}

// ═══════════════════════════════════════════════════
//  ROOMS — GUEST
// ═══════════════════════════════════════════════════

function joinRoom(targetRoomId) {
  currentRoomId = targetRoomId;
  peer = createPeer();
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on("open",  ()     => { hostConnection = peer.connect(targetRoomId, { reliable: true }); setupConnectionToHost(hostConnection); });
  peer.on("call",  (call) => handleIncomingCall(call));
  peer.on("error", (err)  => { setLobbyStatus("Could not connect: " + err.message, true); resetLobbyButtons(); });
}

function setupConnectionToHost(conn) {
  conn.on("open",  ()     => { conn.send({ type: "hello", username: currentUsername, isCreator }); showAppScreen(); appendSystemMessage("Connected! Waiting for sync..."); });
  conn.on("data",  (data) => handleDataFromHost(data));
  conn.on("close", ()     => appendSystemMessage("Disconnected from host."));
  conn.on("error", (err)  => appendSystemMessage("Connection error: " + err.message));
}

function handleDataFromHost(data) {
  switch (data.type) {
    case "full_sync": {
      connectedUsers = data.users;
      hostPeerId     = data.users[0]?.peerId ?? "";
      saveRecentRoom(currentRoomId, false);
      renderUsersList();
      appendSystemMessage("Synced with room!");
      initMedia(data.users);
      break;
    }
    case "chat":        { renderChatMessage(data); break; }
    case "user_joined": { appendSystemMessage(data.username + " joined the room."); break; }
    case "user_list":   { connectedUsers = data.users; renderUsersList(); break; }
    case "kicked":      { appendSystemMessage("You were kicked."); clearRoomFromUrl(); setTimeout(() => location.reload(), 2500); break; }
    case "banned":      { appendSystemMessage("You have been banned."); clearRoomFromUrl(); setTimeout(() => location.reload(), 3000); break; }
    case "force_mute": {
      // Creators are immune — the host cannot lock their microphone
      if (isCreator) break;
      isMuted            = true;
      isForceMutedByHost = true;
      if (localStream) for (const track of localStream.getAudioTracks()) track.enabled = false;
      muteBtnEl.textContent = "Muted";
      muteBtnEl.classList.add("btn-muted");
      muteBtnEl.disabled = true;
      appendSystemMessage("The host muted your microphone.");
      break;
    }
    case "force_unmute": {
      isMuted            = false;
      isForceMutedByHost = false;
      if (localStream) for (const track of localStream.getAudioTracks()) track.enabled = true;
      muteBtnEl.textContent = "Mute";
      muteBtnEl.classList.remove("btn-muted");
      muteBtnEl.disabled = false;
      appendSystemMessage("The host unmuted your microphone.");
      break;
    }
    case "force_cam_off": {
      // Creators are immune — the host cannot lock their camera
      if (isCreator) break;
      isCamOff            = true;
      isForceCamOffByHost = true;
      if (localStream) for (const track of localStream.getVideoTracks()) track.enabled = false;
      camBtnEl.textContent = "Cam Off";
      camBtnEl.classList.add("btn-muted");
      camBtnEl.disabled = true;
      appendSystemMessage("The host turned off your camera.");
      break;
    }
    case "force_cam_on": {
      isCamOff            = false;
      isForceCamOffByHost = false;
      if (localStream) for (const track of localStream.getVideoTracks()) track.enabled = true;
      camBtnEl.textContent = "Cam Off";
      camBtnEl.classList.remove("btn-muted");
      camBtnEl.disabled = false;
      appendSystemMessage("The host re-enabled your camera.");
      break;
    }
    case "hand_raise": {
      if (data.raised) {
        raisedHandPeerIds.add(data.peerId);
      } else {
        raisedHandPeerIds.delete(data.peerId);
      }
      renderUsersList();
      break;
    }
    case "force_move": {
      // Creator/host is relocating us to another room. Remember the target,
      // then reload and auto-join it on the next page load.
      if (!data.roomId) break;
      appendSystemMessage(`You're being moved to room ${data.roomId}…`);
      sessionStorage.setItem(STORAGE_KEY_PENDING_MOVE, data.roomId);
      stopRoomAnnouncement();
      clearRoomFromUrl();
      setTimeout(() => location.reload(), 1500);
      break;
    }
    case "ghost_observer_joining": {
      // Host notified us a ghost observer is about to call — mark it so we
      // answer the call but never render a tile for them.
      ghostObserverPeerIds.add(data.ghostPeerId);
      break;
    }

    // ── Platform owner closed this room ─────────────────────────────────────
    case "room_force_closed": {
      appendSystemMessage("⚠️ This room was closed by the platform owner.");
      clearRoomFromUrl();
      setTimeout(() => location.reload(), 2500);
      break;
    }

    // ── Platform-wide broadcast message ─────────────────────────────────────
    case "system_broadcast": {
      appendSystemMessage("📢 " + data.text);
      break;
    }

    // ── Platform owner wants this client to reload ───────────────────────────
    case "force_reload": {
      appendSystemMessage("⟳ Reloading at platform owner's request…");
      setTimeout(() => location.reload(), 600);
      break;
    }
  }
}

// ═══════════════════════════════════════════════════
//  ROOMS — MEDIA
// ═══════════════════════════════════════════════════

// Computes the tightest square-ish grid that fills the panel without scrolling.
// Called whenever a tile is added or removed, and on panel resize.
function recomputeGridLayout() {
  const tileCount = videoGridEl.children.length;
  if (tileCount === 0) return;

  const columns = tileCount === 1 ? 1 : Math.ceil(Math.sqrt(tileCount));
  const rows    = Math.ceil(tileCount / columns);

  videoGridEl.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  videoGridEl.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;
}

// Returns ideal video constraints for a given participant count.
// More participants → lower resolution to conserve bandwidth.
function getVideoConstraintsForCount(participantCount) {
  if (participantCount <= 3)  return { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } };
  if (participantCount <= 6)  return { width: { ideal: 640  }, height: { ideal: 480  }, frameRate: { ideal: 24 } };
  if (participantCount <= 12) return { width: { ideal: 320  }, height: { ideal: 240  }, frameRate: { ideal: 20 } };
  return                             { width: { ideal: 160  }, height: { ideal: 120  }, frameRate: { ideal: 15 } };
}

// Applies updated constraints to the local video track without restarting the stream.
async function updateVideoQualityForParticipantCount() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  const constraints = getVideoConstraintsForCount(connectedUsers.length);
  try {
    await videoTrack.applyConstraints(constraints);
  } catch (_) {
    // applyConstraints is not universally supported — silently ignore
  }
}

async function initMedia(existingUsers) {
  const participantCount  = existingUsers.length + 1; // +1 for self
  const videoConstraints  = getVideoConstraintsForCount(participantCount);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
  } catch (_) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); }
    catch (err) { appendSystemMessage("Could not access mic/camera: " + err.message); return; }
  }

  addMediaTile("local", currentUsername, localStream);

  for (const user of existingUsers) {
    if (user.peerId === peer.id) continue;
    const outgoingCall = peer.call(user.peerId, localStream);
    mediaCallMap.set(user.peerId, outgoingCall);
    outgoingCall.on("stream", (remoteStream) => addMediaTile(user.peerId, user.username, remoteStream));
    outgoingCall.on("close",  ()             => removeMediaTile(user.peerId));
  }
}

function handleIncomingCall(call) {
  call.answer(localStream ?? new MediaStream());
  mediaCallMap.set(call.peer, call);
  call.on("stream", (remoteStream) => {
    // Ghost observers are invisible — answer their call but never render a tile
    if (ghostObserverPeerIds.has(call.peer)) return;
    const callerUser = connectedUsers.find((u) => u.peerId === call.peer);
    addMediaTile(call.peer, callerUser ? callerUser.username : "Unknown", remoteStream);
  });
  call.on("close", () => removeMediaTile(call.peer));
}

function addMediaTile(peerId, username, stream) {
  if (document.querySelector(`[data-peer-id="${peerId}"]`)) return;
  const label = peerId === "local" ? username + " (you)" : username;

  if (stream.getVideoTracks().length > 0) {
    const tileEl  = document.createElement("div");   tileEl.className = "video-tile"; tileEl.dataset.peerId = peerId;
    const videoEl = document.createElement("video"); videoEl.srcObject = stream; videoEl.autoplay = true; videoEl.playsInline = true;
    if (peerId === "local") videoEl.muted = true;
    const labelEl = document.createElement("div");   labelEl.className = "video-tile-label"; labelEl.textContent = label;
    tileEl.append(videoEl, labelEl);
    videoGridEl.appendChild(tileEl);
  } else {
    const tileEl   = document.createElement("div"); tileEl.className = "audio-tile"; tileEl.dataset.peerId = peerId;
    const avatarEl = document.createElement("div"); avatarEl.className = "audio-avatar"; avatarEl.textContent = username.charAt(0).toUpperCase();
    const nameEl   = document.createElement("div"); nameEl.className  = "audio-name";   nameEl.textContent   = label;
    if (peerId !== "local") {
      const audioEl = document.createElement("audio"); audioEl.srcObject = stream; audioEl.autoplay = true; tileEl.appendChild(audioEl);
    }
    tileEl.append(avatarEl, nameEl);
    videoGridEl.appendChild(tileEl);
  }

  recomputeGridLayout();
  updateVideoQualityForParticipantCount();
  attachSpeakingAnalyser(peerId, stream);
  ensureSpeakingLoopActive();
}

function removeMediaTile(peerId) {
  document.querySelector(`[data-peer-id="${peerId}"]`)?.remove();
  detachSpeakingAnalyser(peerId);
  recomputeGridLayout();
  updateVideoQualityForParticipantCount();
}

// ═══════════════════════════════════════════════════
//  ROOMS — UI HELPERS
// ═══════════════════════════════════════════════════

function renderUsersList() {
  const count = connectedUsers.length;
  usersCountEl.textContent = count;

  participantsListEl.innerHTML = "";
  for (const user of connectedUsers) {
    const rowEl  = document.createElement("div");  rowEl.className  = "participant-row";
    const nameEl = document.createElement("span"); nameEl.className = "participant-name"; nameEl.textContent = user.username;

    if (user.peerId === peer?.id) {
      const youTagEl = document.createElement("span"); youTagEl.className = "participant-you-tag"; youTagEl.textContent = " (you)";
      nameEl.appendChild(youTagEl);
    }
    rowEl.appendChild(nameEl);

    if (user.peerId === hostPeerId) {
      const hostBadgeEl       = document.createElement("span");
      hostBadgeEl.className   = "participant-host-badge";
      hostBadgeEl.textContent = "Host";
      hostBadgeEl.title       = "Room owner";
      rowEl.appendChild(hostBadgeEl);
    }

    if (user.isCreator) {
      const creatorBadgeEl       = document.createElement("span");
      creatorBadgeEl.className   = "participant-creator-badge";
      creatorBadgeEl.textContent = "Creator";
      creatorBadgeEl.title       = "Site creator";
      rowEl.appendChild(creatorBadgeEl);
    }

    if (raisedHandPeerIds.has(user.peerId)) {
      const handIconEl       = document.createElement("span");
      handIconEl.className   = "participant-status-icon";
      handIconEl.innerHTML    = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
      handIconEl.title       = "Hand raised";
      rowEl.appendChild(handIconEl);
    }

    // The host can moderate everyone; a verified creator can moderate everyone
    // except the host (and never themselves).
    const canModerate =
      user.peerId !== peer?.id &&
      (isHost || (isCreator && user.peerId !== hostPeerId));

    if (canModerate) {
      nameEl.classList.add("participant-name--clickable");
      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openHostActionMenu(user.peerId, user.username, e);
      });
    }

    // Force-mute / force-cam status icons reflect host-only bookkeeping.
    if (isHost && user.peerId !== peer.id) {
      if (forceMutedPeerIds.has(user.peerId)) {
        const mutedIconEl       = document.createElement("span");
        mutedIconEl.className   = "participant-status-icon";
        mutedIconEl.innerHTML    = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
        mutedIconEl.title       = "Force muted by host";
        rowEl.appendChild(mutedIconEl);
      }

      if (forceCamOffPeerIds.has(user.peerId)) {
        const camOffIconEl       = document.createElement("span");
        camOffIconEl.className   = "participant-status-icon";
        camOffIconEl.innerHTML    = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
        camOffIconEl.title       = "Camera disabled by host";
        rowEl.appendChild(camOffIconEl);
      }
    }
    participantsListEl.appendChild(rowEl);
  }
}

// ═══════════════════════════════════════════════════
//  ROOMS — HOST ACTION MENU
// ═══════════════════════════════════════════════════

function openHostActionMenu(targetPeerId, targetUsername, clickEvent) {
  hostActionMenuTargetPeerId = targetPeerId;

  const nameEl    = hostActionMenuEl.querySelector(".host-action-menu-name");
  const muteBtn   = hostActionMenuEl.querySelector(".host-action-mute-btn");
  const camOffBtn = hostActionMenuEl.querySelector(".host-action-cam-off-btn");

  nameEl.textContent  = targetUsername;
  muteBtn.textContent   = forceMutedPeerIds.has(targetPeerId)  ? "Unmute"          : "Mute";
  camOffBtn.textContent = forceCamOffPeerIds.has(targetPeerId) ? "Re-enable Camera" : "Turn Off Camera";
  camOffBtn.disabled    = false;
  camOffBtn.title       = "";

  // Position near the click, clamped so it never overflows the viewport
  const menuWidth  = 180;
  const menuHeight = 170;
  let   menuLeft   = clickEvent.clientX;
  let   menuTop    = clickEvent.clientY;

  if (menuLeft + menuWidth  > window.innerWidth)  menuLeft = menuLeft - menuWidth;
  if (menuTop  + menuHeight > window.innerHeight) menuTop  = menuTop  - menuHeight;

  hostActionMenuEl.style.left = menuLeft + "px";
  hostActionMenuEl.style.top  = menuTop  + "px";
  hostActionMenuEl.classList.remove("hidden");
}

function closeHostActionMenu() {
  hostActionMenuEl.classList.add("hidden");
  hostActionMenuTargetPeerId = null;
}

function forceMuteGuest(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;

  if (forceMutedPeerIds.has(peerId)) {
    forceMutedPeerIds.delete(peerId);
    guest.conn.send({ type: "force_unmute" });
    appendSystemMessage(guest.username + "'s microphone was re-enabled.");
  } else {
    forceMutedPeerIds.add(peerId);
    guest.conn.send({ type: "force_mute" });
    appendSystemMessage(guest.username + " was muted by the host.");
  }

  closeHostActionMenu();
  renderUsersList();
}

function forceCamOffGuest(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;

  if (forceCamOffPeerIds.has(peerId)) {
    forceCamOffPeerIds.delete(peerId);
    guest.conn.send({ type: "force_cam_on" });
    appendSystemMessage(guest.username + "'s camera was re-enabled by the host.");
  } else {
    forceCamOffPeerIds.add(peerId);
    guest.conn.send({ type: "force_cam_off" });
    appendSystemMessage(guest.username + "'s camera was turned off by the host.");
  }

  closeHostActionMenu();
  renderUsersList();
}

function renderChatMessage(message) {
  const messageEl = document.createElement("div"); messageEl.className = "chat-message";
  const metaEl    = document.createElement("div"); metaEl.className    = "chat-meta";
  const senderEl  = document.createElement("span"); senderEl.className = "chat-sender"; senderEl.textContent = message.sender;
  const timeEl    = document.createElement("span"); timeEl.className   = "chat-time";   timeEl.textContent   = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const textEl    = document.createElement("div");  textEl.className   = "chat-text";   textEl.textContent   = message.text;
  metaEl.append(senderEl, timeEl);
  messageEl.append(metaEl, textEl);
  chatLogEl.appendChild(messageEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function appendSystemMessage(text) {
  const el = document.createElement("div"); el.className = "system-message"; el.textContent = text;
  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setLobbyStatus(text, isError = false) {
  lobbyStatusEl.textContent = text;
  lobbyStatusEl.classList.toggle("error", isError);
}

function resetLobbyButtons() {
  createRoomBtnEl.disabled = false;
  joinRoomBtnEl.disabled   = false;
}

// ═══════════════════════════════════════════════════
//  ROOMS — SCREEN SHARING
// ═══════════════════════════════════════════════════

async function startScreenShare() {
  if (!localStream) return;
  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (_) {
    appendSystemMessage("Screen share cancelled.");
    return;
  }

  const screenVideoTrack = screenShareStream.getVideoTracks()[0];
  if (!screenVideoTrack) { screenShareStream.getTracks().forEach(t => t.stop()); screenShareStream = null; return; }

  // Replace video sender in every active peer connection
  for (const call of mediaCallMap.values()) {
    if (!call.peerConnection) continue;
    const videoSender = call.peerConnection.getSenders().find(s => s.track?.kind === "video");
    if (videoSender) videoSender.replaceTrack(screenVideoTrack).catch(() => {});
  }

  // Update local preview tile to show the screen instead of the camera
  const localTile = document.querySelector('[data-peer-id="local"]');
  if (localTile) {
    const videoEl = localTile.querySelector("video");
    if (videoEl) {
      videoEl.srcObject = new MediaStream([screenVideoTrack, ...localStream.getAudioTracks()]);
    }
  }

  // When the user stops sharing from the browser's native controls
  screenVideoTrack.addEventListener("ended", () => { if (isScreenSharing) stopScreenShare(); });

  isScreenSharing = true;
  screenShareBtnEl.textContent = "Stop Sharing";
  screenShareBtnEl.classList.add("btn-muted");
  appendSystemMessage("You are now sharing your screen.");
}

async function stopScreenShare() {
  if (!isScreenSharing) return;

  const cameraVideoTrack = localStream.getVideoTracks()[0];

  // Restore camera track in all peer connections
  for (const call of mediaCallMap.values()) {
    if (!call.peerConnection) continue;
    const videoSender = call.peerConnection.getSenders().find(s => s.track?.kind === "video");
    if (videoSender && cameraVideoTrack) videoSender.replaceTrack(cameraVideoTrack).catch(() => {});
  }

  // Restore local preview tile
  const localTile = document.querySelector('[data-peer-id="local"]');
  if (localTile) {
    const videoEl = localTile.querySelector("video");
    if (videoEl) videoEl.srcObject = localStream;
  }

  // Stop all screen-share tracks
  screenShareStream?.getTracks().forEach(t => t.stop());
  screenShareStream = null;

  isScreenSharing = false;
  screenShareBtnEl.textContent = "Share Screen";
  screenShareBtnEl.classList.remove("btn-muted");
  appendSystemMessage("Screen sharing stopped.");
}

// ═══════════════════════════════════════════════════
//  ROOMS — SPEAKING INDICATOR
// ═══════════════════════════════════════════════════

function getOrCreateAudioContext() {
  if (!audioContextInstance) {
    audioContextInstance = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContextInstance.state === "suspended") audioContextInstance.resume();
  return audioContextInstance;
}

function attachSpeakingAnalyser(peerId, stream) {
  if (stream.getAudioTracks().length === 0) return;
  try {
    const ctx      = getOrCreateAudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize               = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    peerIdToAnalyser.set(peerId, { analyser, source });
  } catch (_) {
    // AudioContext not available in this environment — silently skip
  }
}

function detachSpeakingAnalyser(peerId) {
  const entry = peerIdToAnalyser.get(peerId);
  if (!entry) return;
  try { entry.source.disconnect(); } catch (_) {}
  peerIdToAnalyser.delete(peerId);
}

function ensureSpeakingLoopActive() {
  if (speakingLoopActive) return;
  speakingLoopActive = true;
  tickSpeakingDetection();
}

function tickSpeakingDetection() {
  for (const [peerId, { analyser }] of peerIdToAnalyser.entries()) {
    analyser.getByteFrequencyData(speakingDataBuffer);
    const averageLevel = speakingDataBuffer.reduce((sum, val) => sum + val, 0) / speakingDataBuffer.length;
    const isSpeaking   = averageLevel > 12;

    // Don't highlight local user as speaking when they are muted
    if (peerId === "local" && isMuted) {
      document.querySelector('[data-peer-id="local"]')?.classList.remove("speaking");
      continue;
    }

    document.querySelector(`[data-peer-id="${peerId}"]`)?.classList.toggle("speaking", isSpeaking);
  }
  requestAnimationFrame(tickSpeakingDetection);
}

// ═══════════════════════════════════════════════════
//  ROOMS — EVENT LISTENERS
// ═══════════════════════════════════════════════════

createRoomBtnEl.addEventListener("click", () => {
  currentUsername          = screenName;
  isHost                   = true;
  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled   = true;
  setLobbyStatus("Creating room...");
  createRoom();
});

// Shared by the Join button and the active-servers menu.
function startJoinRoom(targetRoomId) {
  currentUsername          = screenName;
  isHost                   = false;
  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled   = true;
  setLobbyStatus("Connecting...");
  joinRoom(targetRoomId);
}

joinRoomBtnEl.addEventListener("click", () => {
  const targetRoomId = roomIdInputEl.value.trim();

  // Secret creator command: typing "creator" opens the active-servers list.
  if (targetRoomId.toLowerCase() === "creator") {
    roomIdInputEl.value = "";
    if (isCreator) openServerListModal();
    else           showCreatorModal();
    return;
  }

  // Secret command: typing "uncreator" removes the creator badge.
  if (targetRoomId.toLowerCase() === "uncreator") {
    roomIdInputEl.value = "";
    if (isCreator) { deactivateCreator(); setLobbyStatus("Creator badge removed."); }
    else           setLobbyStatus("You don't have a creator badge.");
    return;
  }

  if (!targetRoomId) { setLobbyStatus("Please enter a Room ID.", true); return; }
  startJoinRoom(targetRoomId);
});

copyIdBtnEl.addEventListener("click", () => {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    const original = copyIdBtnEl.textContent;
    copyIdBtnEl.textContent = "Copied!";
    setTimeout(() => { copyIdBtnEl.textContent = original; }, 1500);
  });
});

roomIdLabelEl.addEventListener("click", () => {
  roomCodeOverlayTextEl.textContent = currentRoomId;
  roomCodeOverlayEl.classList.remove("hidden");
});

roomCodeOverlayEl.addEventListener("click", () => {
  roomCodeOverlayEl.classList.add("hidden");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    roomCodeOverlayEl.classList.add("hidden");
    participantsPanelEl.classList.add("hidden");
    closeHostActionMenu();
  }
});

// Removes ?room= from the URL before a reload so auto-join doesn't re-fire.
function clearRoomFromUrl() {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("room");
  window.history.replaceState({}, "", cleanUrl);
}

leaveBtnEl.addEventListener("click", () => {
  // Stop screen share cleanly before leaving
  if (isScreenSharing) {
    screenShareStream?.getTracks().forEach(t => t.stop());
    screenShareStream = null;
    isScreenSharing   = false;
  }
  stopRoomAnnouncement();
  peer?.destroy();
  clearRoomFromUrl();
  location.reload();
});

sendBtnEl.addEventListener("click", () => {
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = "";
  broadcastChatMessage(text);
});

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = "";
  broadcastChatMessage(text);
});

muteBtnEl.addEventListener("click", () => {
  if (!localStream) return;
  // Creators can always toggle their mic, even if the host tried to force-mute them
  if (isForceMutedByHost && !isCreator) return;
  if (isForceMutedByHost && isCreator) {
    isForceMutedByHost    = false;
    muteBtnEl.disabled    = false;
  }
  isMuted = !isMuted;
  for (const track of localStream.getAudioTracks()) track.enabled = !isMuted;
  muteBtnEl.textContent = isMuted ? "Unmute" : "Mute";
  muteBtnEl.classList.toggle("btn-muted", isMuted);
});

camBtnEl.addEventListener("click", () => {
  if (!localStream) return;
  // Creators can always toggle their camera, even if the host tried to force it off
  if (isForceCamOffByHost && !isCreator) return;
  if (isForceCamOffByHost && isCreator) {
    isForceCamOffByHost = false;
    camBtnEl.disabled   = false;
  }
  isCamOff = !isCamOff;
  for (const track of localStream.getVideoTracks()) track.enabled = !isCamOff;
  camBtnEl.textContent = isCamOff ? "Cam On" : "Cam Off";
  camBtnEl.classList.toggle("btn-muted", isCamOff);
});

usersCountBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  participantsPanelEl.classList.toggle("hidden");
});

closePanelBtnEl.addEventListener("click", () => {
  participantsPanelEl.classList.add("hidden");
});

// Close panel and host action menu when clicking outside of them
document.addEventListener("click", (e) => {
  if (
    !participantsPanelEl.classList.contains("hidden") &&
    !participantsPanelEl.contains(e.target) &&
    e.target !== usersCountBtnEl
  ) {
    participantsPanelEl.classList.add("hidden");
  }

  if (
    !hostActionMenuEl.classList.contains("hidden") &&
    !hostActionMenuEl.contains(e.target)
  ) {
    closeHostActionMenu();
  }
});

// ═══════════════════════════════════════════════════
//  ROOMS — HOST ACTION MENU BUTTONS
// ═══════════════════════════════════════════════════

// The host acts directly; a verified creator relays the action to the host.
function runMenuAction(hostAction, creatorAction) {
  const targetPeerId = hostActionMenuTargetPeerId;
  if (!targetPeerId) return;
  if (isHost) {
    hostAction(targetPeerId);
  } else if (isCreator) {
    requestCreatorModeration(creatorAction, targetPeerId);
  }
  closeHostActionMenu();
}

hostActionMenuEl.querySelector(".host-action-mute-btn").addEventListener("click", () => {
  runMenuAction(forceMuteGuest, "mute");
});

hostActionMenuEl.querySelector(".host-action-cam-off-btn").addEventListener("click", () => {
  runMenuAction(forceCamOffGuest, "cam");
});

hostActionMenuEl.querySelector(".host-action-kick-btn").addEventListener("click", () => {
  runMenuAction(kickUser, "kick");
});

hostActionMenuEl.querySelector(".host-action-ban-btn").addEventListener("click", () => {
  runMenuAction(banUser, "ban");
});

// Recompute grid on panel resize (e.g. window resize or sidebar toggle)
const gridResizeObserver = new ResizeObserver(() => recomputeGridLayout());
gridResizeObserver.observe(videoGridEl.parentElement);


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
//  CREATOR / DEVELOPER-ONLY UI  →  moved to dev.js
//  (creator badge modal, active-servers menu, move-participant modal,
//   and the Random-mode moderation modal). dev.js shares this file's
//   global scope and is loaded right after it in index.html.
// ═══════════════════════════════════════════════════

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


document.getElementById("select-random-btn").addEventListener("click", () => {
  homeScreenEl.classList.add("hidden");
  randomLobbyScreenEl.classList.remove("hidden");
  const yourIdEl = document.getElementById("random-your-id-num");
  if (yourIdEl) yourIdEl.textContent = "#" + userNumber;
});

document.getElementById("lobby-back-btn").addEventListener("click", () => {
  lobbyScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
  setLobbyStatus("");
  createRoomBtnEl.disabled = false;
  joinRoomBtnEl.disabled   = false;
});

document.getElementById("random-lobby-back-btn").addEventListener("click", () => {
  randomLobbyScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
  randomLobbyStatusEl.textContent = "";
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
  const pendingUrlRoom = sessionStorage.getItem("dropin_url_room");
  if (pendingUrlRoom) {
    sessionStorage.removeItem("dropin_url_room");
    lobbyScreenEl.classList.remove("hidden");
    setLobbyStatus("Joining room from link…");
    startJoinRoom(pendingUrlRoom);
    return;
  }

  homeScreenEl.classList.remove("hidden");
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
  lobbyScreenEl.classList.remove("hidden");
  setLobbyStatus("Moving you to the new room…");
  startJoinRoom(pendingRoomId);
})();

// If the URL contains ?room=abc, auto-join that room on load.
// If the user has no saved name yet, store the ID for use after name entry.
(function resumeRoomFromUrl() {
  if (_resumedByPendingMove) return; // force-move already handled startup
  const urlRoomId = new URLSearchParams(window.location.search).get("room");
  if (!urlRoomId) return;

  const savedName = loadSavedUsername();
  if (!savedName) {
    // Stash it — attemptContinue() will pick it up after the name is entered.
    sessionStorage.setItem("dropin_url_room", urlRoomId);
    return;
  }

  // Has a saved name — skip straight to joining the room.
  screenName = savedName;
  usernameScreenEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
  setLobbyStatus("Joining room from link…");
  startJoinRoom(urlRoomId);
})();

// ═══════════════════════════════════════════════════
//  RANDOM MODE — HELPERS
// ═══════════════════════════════════════════════════

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function buildSlotId(slotIndex) {
  return `${RANDOM_SLOT_PREFIX}${getTodayDateString()}-${slotIndex}`;
}

function setRandomWaitingText(text) { randomWaitingTextEl.textContent = text; }
function showRandomWaitingOverlay() { randomWaitingOverlayEl.classList.remove("hidden"); }
function hideRandomWaitingOverlay() { randomWaitingOverlayEl.classList.add("hidden"); }

function appendRandomSystemMsg(text) {
  const el = document.createElement("div"); el.className = "system-message"; el.textContent = text;
  randomChatLogEl.appendChild(el);
  randomChatLogEl.scrollTop = randomChatLogEl.scrollHeight;
}

function appendRandomChatMessage(message) {
  const messageEl = document.createElement("div"); messageEl.className = "chat-message";
  const metaEl    = document.createElement("div"); metaEl.className    = "chat-meta";
  const senderEl  = document.createElement("span"); senderEl.className = "chat-sender"; senderEl.textContent = message.sender;
  const timeEl    = document.createElement("span"); timeEl.className   = "chat-time";   timeEl.textContent   = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const textEl    = document.createElement("div");  textEl.className   = "chat-text";   textEl.textContent   = message.text;
  metaEl.append(senderEl, timeEl);
  messageEl.append(metaEl, textEl);
  randomChatLogEl.appendChild(messageEl);
  randomChatLogEl.scrollTop = randomChatLogEl.scrollHeight;
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — MEDIA
// ═══════════════════════════════════════════════════

async function acquireRandomLocalStream() {
  try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch (_) {
    try { return await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); }
    catch (err) { throw new Error("Camera/mic access denied: " + err.message); }
  }
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — MATCHMAKING
// ═══════════════════════════════════════════════════

function tryGuestConnectToSlot(slotId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      currentSlotResolver = null;
      clearTimeout(timer);
      resolve(result);
    };
    currentSlotResolver = finish;
    const timer = setTimeout(() => finish(null), SLOT_CONNECT_TIMEOUT_MS);
    const dataConn = randomPeer.connect(slotId, { reliable: true });
    dataConn.on("open",  () => finish(dataConn));
    dataConn.on("error", () => finish(null));
  });
}

function tryClaimWaiterSlot(slotId) {
  return new Promise((resolve) => {
    const waiterPeer = createPeer(slotId);
    const timer = setTimeout(() => { waiterPeer.destroy(); resolve(null); }, SLOT_REGISTER_TIMEOUT_MS);
    waiterPeer.on("open",  () => { clearTimeout(timer); resolve(waiterPeer); });
    waiterPeer.on("error", () => { clearTimeout(timer); waiterPeer.destroy(); resolve(null); });
  });
}

async function searchForRandomMatch(startSlotIndex) {
  if (randomIsDestroyed) return;

  randomPeer = createPeer();

  const peerReady = await new Promise((resolve) => {
    randomPeer.once("open",  () => resolve(true));
    randomPeer.once("error", () => resolve(false));
  });

  if (!peerReady || randomIsDestroyed) {
    if (!randomIsDestroyed) { setRandomWaitingText("Connection failed, retrying..."); setTimeout(() => searchForRandomMatch(startSlotIndex), 3000); }
    return;
  }

  randomPeer.on("call", (incomingCall) => handleRandomIncomingCall(incomingCall));
  randomPeer.on("error", (err) => { if (err.type === "peer-unavailable" && currentSlotResolver) currentSlotResolver(null); });

  for (let slotIndex = startSlotIndex; slotIndex < MAX_RANDOM_SLOTS; slotIndex++) {
    if (randomIsDestroyed) return;

    const slotId   = buildSlotId(slotIndex);
    const dataConn = await tryGuestConnectToSlot(slotId);

    if (randomIsDestroyed) return;

    if (dataConn) {
      randomStrangerDataConn = dataConn;
      setupRandomDataConnectionHandlers(dataConn);
      dataConn.send({ type: "random_hello", username: randomUsername });
      setRandomWaitingText("Matched! Connecting...");
      return;
    }

    const waiterPeer = await tryClaimWaiterSlot(slotId);

    if (randomIsDestroyed) { waiterPeer?.destroy(); return; }

    if (waiterPeer) {
      randomPeer.destroy();
      randomPeer = waiterPeer;
      randomPeer.on("call",       (incomingCall) => handleRandomIncomingCall(incomingCall));
      randomPeer.on("connection", (incomingConn) => handleRandomGuestArrived(incomingConn));
      setRandomWaitingText("Waiting for someone to drop in...");
      return;
    }

    // Slot snatched by a third party — recreate guest peer and try the next slot
    randomPeer.destroy();
    randomPeer = createPeer();
    const nextReady = await new Promise((resolve) => {
      randomPeer.once("open",  () => resolve(true));
      randomPeer.once("error", () => resolve(false));
    });
    if (!nextReady || randomIsDestroyed) return;
    randomPeer.on("call",  (incomingCall) => handleRandomIncomingCall(incomingCall));
    randomPeer.on("error", (err) => { if (err.type === "peer-unavailable" && currentSlotResolver) currentSlotResolver(null); });
  }

  setRandomWaitingText("Slots full, retrying...");
  setTimeout(() => { if (!randomIsDestroyed) searchForRandomMatch(0); }, 2500);
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — CONNECTION HANDLERS
// ═══════════════════════════════════════════════════

function handleRandomGuestArrived(dataConn) {
  randomStrangerDataConn = dataConn;
  dataConn.on("data", (message) => {
    if (message.type === "random_hello") {
      const outgoingCall = randomPeer.call(dataConn.peer, randomLocalStream);
      randomActiveCall   = outgoingCall;
      outgoingCall.on("stream", (remoteStream) => { randomRemoteVideoEl.srcObject = remoteStream; hideRandomWaitingOverlay(); appendRandomSystemMsg("Connected! Say hi"); });
      outgoingCall.on("close",  () => onStrangerLeft("Stranger disconnected."));
    } else if (message.type === "random_bye")  { onStrangerLeft("Stranger ended the chat."); }
      else if (message.type === "random_chat") { appendRandomChatMessage(message); }
  });
  dataConn.on("close", () => { if (randomActiveCall) onStrangerLeft("Stranger disconnected."); });
}

function handleRandomIncomingCall(call) {
  randomActiveCall = call;
  call.answer(randomLocalStream);
  call.on("stream", (remoteStream) => { randomRemoteVideoEl.srcObject = remoteStream; hideRandomWaitingOverlay(); appendRandomSystemMsg("Connected! Say hi"); });
  call.on("close",  () => onStrangerLeft("Stranger disconnected."));
}

function setupRandomDataConnectionHandlers(dataConn) {
  dataConn.on("data",  (message) => {
    if      (message.type === "random_bye")  onStrangerLeft("Stranger ended the chat.");
    else if (message.type === "random_chat") appendRandomChatMessage(message);
  });
  dataConn.on("close", () => { if (randomActiveCall) onStrangerLeft("Stranger disconnected."); });
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — LIFECYCLE
// ═══════════════════════════════════════════════════

function onStrangerLeft(reason) {
  cleanupRandomMatch();
  showRandomWaitingOverlay();
  setRandomWaitingText(reason);
  appendRandomSystemMsg(reason);
  setTimeout(() => {
    if (randomIsDestroyed) return;
    randomChatLogEl.innerHTML = "";
    setRandomWaitingText("Finding someone new...");
    searchForRandomMatch(0);
  }, 2500);
}

function cleanupRandomMatch() {
  if (randomActiveCall)       { randomActiveCall.close();       randomActiveCall       = null; }
  if (randomStrangerDataConn) { randomStrangerDataConn.close(); randomStrangerDataConn = null; }
  randomRemoteVideoEl.srcObject = null;
  currentSlotResolver = null;
}

function cleanupRandomMode() {
  randomIsDestroyed   = true;
  currentSlotResolver = null;
  stopRandomPresence();
  cleanupRandomMatch();
  if (randomPeer)        { randomPeer.destroy(); randomPeer = null; }
  if (randomLocalStream) { for (const track of randomLocalStream.getTracks()) track.stop(); randomLocalStream = null; }
  randomLocalVideoEl.srcObject  = null;
  randomRemoteVideoEl.srcObject = null;
  randomChatLogEl.innerHTML     = "";
  randomIsMuted  = false;
  randomIsCamOff = false;
  randomMuteBtnEl.textContent = "Mute";    randomMuteBtnEl.classList.remove("btn-muted");
  randomCamBtnEl.textContent  = "Cam Off"; randomCamBtnEl.classList.remove("btn-muted");
  showRandomWaitingOverlay();
  setRandomWaitingText("Finding someone...");
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — CREATOR MODERATION (client side)
//
//  Every Random user opens a persistent connection to the registry holder to
//  announce their presence. A creator can list everyone, kick them out, or
//  ban them by screen name. Bans are persisted in the creator's localStorage
//  and re-synced to the holder so they survive sessions and holder changes.
// ═══════════════════════════════════════════════════

// Returns this device's stable number, creating + persisting one on first use.
function loadOrCreateUserNumber() {
  let stored = localStorage.getItem(STORAGE_KEY_USER_NUMBER);
  if (!stored) {
    // 8-digit number: easy to read aloud and very unlikely to collide.
    stored = String(Math.floor(10000000 + Math.random() * 90000000));
    localStorage.setItem(STORAGE_KEY_USER_NUMBER, stored);
  }
  return stored;
}

// True while a ban is still in effect. `until` is null for a permanent ban.
function isBanActive(until) {
  return until == null || Date.now() < until;
}

// Human-friendly "2h 15m" / "3d" style duration from a millisecond span.
function formatDuration(milliseconds) {
  if (milliseconds <= 0) return "0m";
  const totalMinutes = Math.ceil(milliseconds / 60000);
  if (totalMinutes < 60) return totalMinutes + "m";
  const hours   = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days           = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}

// Message shown to a banned user, reflecting whether the ban is timed.
function randomBanMessage(until) {
  if (until == null) return "You are permanently banned from Random.";
  return "You're banned from Random for " + formatDuration(until - Date.now()) + ".";
}

// ─── Creator's persisted ban list: [{ number, until }] ───────────────────────

function loadRandomBans() {
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_RANDOM_BANS) ?? "[]"); }
  catch (_) { return []; }
  if (!Array.isArray(parsed)) return [];
  // Keep only well-formed, still-active entries.
  return parsed
    .filter((entry) => entry && typeof entry === "object" && entry.number)
    .map((entry) => ({ number: String(entry.number), until: entry.until ?? null }))
    .filter((entry) => isBanActive(entry.until));
}

function saveRandomBans(list) {
  // Dedupe by number (keep latest expiry) and drop anything already expired.
  const numberToUntil = new Map();
  for (const entry of list) {
    if (!entry || !entry.number) continue;
    const until = entry.until ?? null;
    if (!isBanActive(until)) continue;
    numberToUntil.set(String(entry.number), until);
  }
  const cleaned = [...numberToUntil].map(([number, until]) => ({ number, until }));
  localStorage.setItem(STORAGE_KEY_RANDOM_BANS, JSON.stringify(cleaned));
  return cleaned;
}

// Sends every persisted ban to the holder so enforcement is active right away.
function syncBansToRegistry() {
  const bans = loadRandomBans();
  if (bans.length === 0) return;
  sendRandomModeration({ type: "sync_bans", bans });
}

// ─── This device's own cached ban (so it knows before reaching the holder) ───

function loadMyRandomBan() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_MY_RANDOM_BAN) ?? "null"); }
  catch (_) { return null; }
}

function saveMyRandomBan(until) {
  localStorage.setItem(
    STORAGE_KEY_MY_RANDOM_BAN,
    JSON.stringify({ until: until ?? null, savedAt: Date.now() })
  );
}

function clearMyRandomBan() {
  localStorage.removeItem(STORAGE_KEY_MY_RANDOM_BAN);
}

// Boot-out handler: runs on the kicked/banned user's own client. A ban also
// records the freed-time locally so a returning user sees the countdown.
function handleRandomControlMessage(message) {
  if (!message) return;
  if (message.type === "random_kicked") {
    leaveRandomToHome("A creator removed you from Random.");
  } else if (message.type === "random_banned") {
    saveMyRandomBan(message.until ?? null);
    leaveRandomToHome(randomBanMessage(message.until ?? null));
  } else if (message.type === "random_reload") {
    setTimeout(() => location.reload(), 600);
  }
}

function leaveRandomToHome(reason) {
  if (randomCallScreenEl.classList.contains("hidden") &&
      randomLobbyScreenEl.classList.contains("hidden")) return; // not in Random
  cleanupRandomMode();
  hideRandomModModal();
  randomCallScreenEl.classList.add("hidden");
  randomLobbyScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
  if (reason) setTimeout(() => alert(reason), 50);
}

// Opens (or re-uses) a persistent connection to the registry holder used for
// presence + receiving kick/ban commands. Mirrors announceRoomToRegistry's
// claim-or-connect pattern so Random works even with no rooms around.
async function announceRandomPresence() {
  const helperPeer = await createHelperPeer();
  if (!helperPeer || randomIsDestroyed) { helperPeer?.destroy(); return; }
  randomPresenceId = helperPeer.id;

  const conn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });
  const connected = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    conn.on("open",  () => finish(true));
    conn.on("error", () => finish(false));
    setTimeout(() => finish(false), REGISTRY_QUERY_TIMEOUT);
  });

  if (randomIsDestroyed) { helperPeer.destroy(); return; }

  if (connected) {
    randomPresenceConn = conn;
    conn.on("data", (message) => handleRandomControlMessage(message));

    // If the connection drops (e.g. the holder peer goes away after a call
    // tears down), clear the stale reference and try to re-establish presence
    // so the user stays visible on the dashboard while they wait for a new match.
    conn.on("close", () => {
      if (randomPresenceConn === conn) randomPresenceConn = null;
      if (randomPresenceTimer) { clearInterval(randomPresenceTimer); randomPresenceTimer = null; }
      if (!randomIsDestroyed && !registryHolderPeer) {
        setTimeout(() => {
          if (!randomIsDestroyed && !randomPresenceConn && !registryHolderPeer) {
            announceRandomPresence();
          }
        }, 2500);
      }
    });

    conn.on("error", () => {
      if (randomPresenceConn === conn) randomPresenceConn = null;
    });

    if (isCreator) syncBansToRegistry();
    sendRandomPresence("random_register");
    randomPresenceTimer = setInterval(() => sendRandomPresence("random_heartbeat"), REGISTRY_HEARTBEAT_MS);
    return;
  }

  // Nobody holds the registry — become the holder ourselves.
  helperPeer.destroy();
  const holderPeer = await tryClaimRegistry();
  if (!holderPeer || randomIsDestroyed) { holderPeer?.destroy(); return; }
  becomeRegistryHolder(holderPeer);
  randomPresenceId = SELF_PRESENCE_ID;
  if (isCreator) for (const ban of loadRandomBans()) randomBans.set(ban.number, ban.until);
  randomPresence.set(SELF_PRESENCE_ID, { username: randomUsername, userNumber, conn: null, updatedAt: Date.now() });
  randomPresenceTimer = setInterval(() => {
    const entry = randomPresence.get(SELF_PRESENCE_ID);
    if (entry) entry.updatedAt = Date.now();
  }, REGISTRY_HEARTBEAT_MS);
}

function sendRandomPresence(type) {
  if (!randomPresenceConn) return;
  try { randomPresenceConn.send({ type, username: randomUsername, userNumber, isMonitor: randomMonitorMode }); } catch (_) {}
}

function stopRandomPresence() {
  if (randomPresenceTimer) { clearInterval(randomPresenceTimer); randomPresenceTimer = null; }
  if (randomPresenceConn) {
    try { randomPresenceConn.send({ type: "random_unregister" }); } catch (_) {}
    try { randomPresenceConn.close(); } catch (_) {}
    randomPresenceConn = null;
  }
  randomPresence.delete(SELF_PRESENCE_ID);
  randomPresenceId = "";
}

// Creator side: read the live presence list + ban list from the holder.
async function queryRandomPresence() {
  if (registryHolderPeer) {
    return { users: serializeRandomPresence(), bans: serializeRandomBans() };
  }
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return { users: [], bans: [] };
  const conn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    conn.on("open",  () => conn.send({ type: "list_random" }));
    conn.on("data",  (m) => { if (m.type === "random_presence_list") finish({ users: m.users ?? [], bans: m.bans ?? [] }); });
    conn.on("error", () => finish({ users: [], bans: [] }));
    setTimeout(() => finish({ users: [], bans: [] }), REGISTRY_QUERY_TIMEOUT);
  });
  setTimeout(() => { try { helperPeer.destroy(); } catch (_) {} }, 500);
  return result;
}

// Join-time recheck: ask the holder whether THIS device's number is banned.
// Resolves { banned, until }. Expired bans are reported as not-banned.
async function checkRandomBanStatus() {
  if (registryHolderPeer) {
    if (randomBans.has(userNumber)) {
      const until = randomBans.get(userNumber);
      if (isBanActive(until)) return { banned: true, until };
      randomBans.delete(userNumber);
    }
    return { banned: false, until: null };
  }
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return { banned: false, until: null };
  const conn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    conn.on("open",  () => conn.send({ type: "check_ban", userNumber }));
    conn.on("data",  (m) => { if (m.type === "ban_status") finish({ banned: !!m.banned, until: m.until ?? null }); });
    conn.on("error", () => finish({ banned: false, until: null }));
    setTimeout(() => finish({ banned: false, until: null }), REGISTRY_QUERY_TIMEOUT);
  });
  setTimeout(() => { try { helperPeer.destroy(); } catch (_) {} }, 500);
  return result;
}

// Creator side: apply a moderation command — locally if we hold the registry,
// otherwise relayed down our presence connection to whoever does.
function sendRandomModeration(message) {
  if (registryHolderPeer) { handleRegistryMessage(null, message); return; }
  if (randomPresenceConn) { try { randomPresenceConn.send(message); } catch (_) {} }
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — START
// ═══════════════════════════════════════════════════

async function startRandomMode() {
  randomUsername = screenName;

  // Join-time ban recheck: confirm with the holder whether this device's
  // number is still banned (an expired window frees them automatically).
  randomLobbyStatusEl.textContent = "Checking access…";
  const banStatus = await checkRandomBanStatus();
  if (banStatus.banned) {
    saveMyRandomBan(banStatus.until);
    randomLobbyStatusEl.textContent = randomBanMessage(banStatus.until);
    return;
  }
  clearMyRandomBan();

  randomLobbyStatusEl.textContent = "Getting camera...";
  try { randomLocalStream = await acquireRandomLocalStream(); }
  catch (err) { randomLobbyStatusEl.textContent = err.message; return; }

  randomIsDestroyed = false; randomIsMuted = false; randomIsCamOff = false;
  randomActiveCall = null; randomStrangerDataConn = null; randomPeer = null; currentSlotResolver = null;
  randomChatLogEl.innerHTML = "";
  randomLocalVideoEl.srcObject = randomLocalStream;

  // The Creator moderation button only appears for verified creators.
  if (randomModBtnEl) randomModBtnEl.classList.toggle("hidden", !isCreator);

  randomLobbyScreenEl.classList.add("hidden");
  randomCallScreenEl.classList.remove("hidden");
  showRandomWaitingOverlay();
  setRandomWaitingText("Finding someone...");
  announceRandomPresence();
  searchForRandomMatch(0);
}

// ═══════════════════════════════════════════════════
//  RANDOM MODE — EVENT LISTENERS
// ═══════════════════════════════════════════════════

document.getElementById("start-random-btn").addEventListener("click", () => startRandomMode());

randomNextBtnEl.addEventListener("click", () => {
  if (randomStrangerDataConn) { try { randomStrangerDataConn.send({ type: "random_bye" }); } catch (_) {} }
  cleanupRandomMatch();
  if (randomPeer && !randomPeer.destroyed) { randomPeer.destroy(); randomPeer = null; }
  randomChatLogEl.innerHTML = "";
  showRandomWaitingOverlay();
  setRandomWaitingText("Finding someone new...");
  searchForRandomMatch(0);
});

randomLeaveBtnEl.addEventListener("click", () => {
  if (randomStrangerDataConn) { try { randomStrangerDataConn.send({ type: "random_bye" }); } catch (_) {} }
  cleanupRandomMode();
  hideRandomModModal();
  randomCallScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
});

randomSendBtnEl.addEventListener("click", () => {
  const text = randomChatInputEl.value.trim();
  if (!text || !randomStrangerDataConn) return;
  randomChatInputEl.value = "";
  const message = { type: "random_chat", sender: randomUsername, text, timestamp: Date.now() };
  appendRandomChatMessage(message);
  randomStrangerDataConn.send(message);
});

randomChatInputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  const text = randomChatInputEl.value.trim();
  if (!text || !randomStrangerDataConn) return;
  randomChatInputEl.value = "";
  const message = { type: "random_chat", sender: randomUsername, text, timestamp: Date.now() };
  appendRandomChatMessage(message);
  randomStrangerDataConn.send(message);
});

randomMuteBtnEl.addEventListener("click", () => {
  if (!randomLocalStream) return;
  randomIsMuted = !randomIsMuted;
  for (const track of randomLocalStream.getAudioTracks()) track.enabled = !randomIsMuted;
  randomMuteBtnEl.textContent = randomIsMuted ? "Unmute" : "Mute";
  randomMuteBtnEl.classList.toggle("btn-muted", randomIsMuted);
});

randomCamBtnEl.addEventListener("click", () => {
  if (!randomLocalStream) return;
  randomIsCamOff = !randomIsCamOff;
  for (const track of randomLocalStream.getVideoTracks()) track.enabled = !randomIsCamOff;
  randomCamBtnEl.textContent = randomIsCamOff ? "Cam On" : "Cam Off";
  randomCamBtnEl.classList.toggle("btn-muted", randomIsCamOff);
});

screenShareBtnEl.addEventListener("click", () => {
  if (isScreenSharing) stopScreenShare();
  else                 startScreenShare();
});

raiseHandBtnEl.addEventListener("click", () => {
  if (!peer) return;
  localHandRaised = !localHandRaised;

  if (localHandRaised) {
    raisedHandPeerIds.add(peer.id);
    raiseHandBtnEl.classList.add("btn-hand-active");
  } else {
    raisedHandPeerIds.delete(peer.id);
    raiseHandBtnEl.classList.remove("btn-hand-active");
  }

  sendToAll({ type: "hand_raise", peerId: peer.id, username: currentUsername, raised: localHandRaised });
  renderUsersList();
});
