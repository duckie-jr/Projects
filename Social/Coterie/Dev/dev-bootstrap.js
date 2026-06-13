// ═══════════════════════════════════════════════════
//  dev-bootstrap.js — Standalone runtime for dev/index.html
//
//  Provides every symbol that dev.js needs from main.js and rooms.js so the
//  dev control panel can run completely independently from the main app.
//
//  Load order for /dev/index.html:
//    1. PeerJS CDN  (window.Peer)
//    2. dev-bootstrap.js   ← this file
//    3. dev.js
// ═══════════════════════════════════════════════════


// ─── WebRTC / ICE config ─────────────────────────
// Mirrors the same config used in main.js so the dev panel connects to the
// same PeerJS network and signaling server as the main app.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const TURN_SERVERS = [
  { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

let PEER_OPTIONS = { config: { iceServers: [...STUN_SERVERS, ...TURN_SERVERS] } };

// Auto-detect local PeerJS server (same probe logic as main.js).
(async () => {
  try {
    const controller   = new AbortController();
    const probeTimeout = setTimeout(() => controller.abort(), 1500);
    const response     = await fetch('/peerjs/peerjs/id', { signal: controller.signal });
    clearTimeout(probeTimeout);
    if (response.ok) {
      const text = await response.text();
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
    // No local server — keep the public cloud default.
  }
})();

function createPeer(peerId) {
  return peerId ? new window.Peer(peerId, PEER_OPTIONS) : new window.Peer(PEER_OPTIONS);
}


// ─── Registry constants ───────────────────────────

const REGISTRY_PEER_ID       = "coterie-active-server-registry-v1";
const REGISTRY_HEARTBEAT_MS  = 5000;
const REGISTRY_STALE_MS      = 18000;
const REGISTRY_QUERY_TIMEOUT = 4000;


// ─── Registry state ───────────────────────────────

let   registryHolderPeer = null;
const registeredServers  = new Map();

let registryStatsRoomsCreatedToday   = 0;
let registryStatsPeakConcurrentUsers = 0;
let registryStatsTotalBansIssued     = 0;

function calculateCurrentConcurrentUsers() {
  let count = 0;
  for (const server of registeredServers.values()) {
    count += server.participantCount ?? 1;
  }
  return count;
}

function updateRegistryPeakConcurrentUsers() {
  const current = calculateCurrentConcurrentUsers();
  if (current > registryStatsPeakConcurrentUsers) {
    registryStatsPeakConcurrentUsers = current;
  }
}


// ─── Registry functions ───────────────────────────
// Duplicated from rooms.js so /dev/index.html has no dependency on the main app.

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
    roomName:         entry.roomName         ?? "",
    maxSize:          entry.maxSize          ?? 0,
    participantCount: entry.participantCount,
    participants:     entry.participants     ?? [],
    isPassworded:     entry.isPassworded     ?? false,
  }));
}

function handleRegistryMessage(conn, message) {
  switch (message.type) {
    case "register_room":
    case "heartbeat": {
      if (message.type === "register_room" && !registeredServers.has(message.roomId)) {
        registryStatsRoomsCreatedToday++;
      }
      registeredServers.set(message.roomId, {
        hostName:         message.hostName,
        roomName:         message.roomName         ?? "",
        maxSize:          message.maxSize          ?? 0,
        participantCount: message.participantCount ?? 1,
        participants:     message.participants     ?? [],
        isPassworded:     message.isPassworded     ?? false,
        updatedAt:        Date.now(),
      });
      updateRegistryPeakConcurrentUsers();
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
  }
}

function becomeRegistryHolder(holderPeer) {
  registryHolderPeer = holderPeer;
  holderPeer.on("connection", (conn) => {
    conn.on("data",  (message) => handleRegistryMessage(conn, message));
    conn.on("close", () => {});
  });
  holderPeer.on("error", () => {});
}

function tryClaimRegistry() {
  return new Promise((resolve) => {
    const holderPeer = createPeer(REGISTRY_PEER_ID);
    let   settled    = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    holderPeer.once("open",  () => finish(holderPeer));
    holderPeer.once("error", () => { try { holderPeer.destroy(); } catch (_) {} finish(null); });
  });
}

async function fetchActiveServers() {
  const helperPeer = await createHelperPeer();
  if (!helperPeer) return [];

  const queryConn = helperPeer.connect(REGISTRY_PEER_ID, { reliable: true });

  const servers = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    queryConn.on("open",  () => queryConn.send({ type: "list_rooms" }));
    queryConn.on("data",  (msg) => { if (msg.type === "room_list") finish(msg.servers ?? []); });
    queryConn.on("error", () => finish([]));
    setTimeout(() => finish([]), REGISTRY_QUERY_TIMEOUT);
  });

  setTimeout(() => { try { helperPeer.destroy(); } catch (_) {} }, 500);
  return servers;
}

// Returns live platform stats gathered by this session's registry holder state.
async function queryPlatformStats() {
  return {
    roomsCreatedToday:   registryStatsRoomsCreatedToday,
    peakConcurrentUsers: registryStatsPeakConcurrentUsers,
    totalBansIssued:     registryStatsTotalBansIssued,
  };
}


// ─── Creator auth ─────────────────────────────────

const STORAGE_KEY_CREATOR = "coterie_creator_verified";
let   isCreator = localStorage.getItem(STORAGE_KEY_CREATOR) === "1";


// ─── Stubs for room-context symbols ───────────────
// These symbols are used by dev.js but have no meaning in the standalone
// dev panel (there is no active room, no participant list, etc.).

let currentRoomId = "";          // no active room in the dev panel
let hostActionMenuTargetPeerId = null;

// Stub element — dev.js wires a "Move to Room" click listener onto the host
// action menu's move button. We create a detached element so the querySelector
// calls don't throw; the button simply never appears in the UI.
const hostActionMenuEl = (() => {
  const containerEl = document.createElement("div");
  containerEl.id    = "host-action-menu";

  const nameEl      = document.createElement("span");
  nameEl.className  = "host-action-menu-name";

  const moveBtnEl      = document.createElement("button");
  moveBtnEl.className  = "host-action-move-btn";

  containerEl.append(nameEl, moveBtnEl);
  return containerEl;
})();

function closeHostActionMenu() { /* no-op in dev panel */ }

// Log system messages to the browser console instead of a chat pane.
function appendSystemMessage(text) {
  console.info("[dev panel]", text);
}

// "Join" from the active-servers list opens the main app in a new tab so the
// creator can hop into a room without leaving the control panel.
function startJoinRoom(roomId) {
  window.open("../index.html?room=" + encodeURIComponent(roomId), "_blank");
}
