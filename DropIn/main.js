// window.Peer → PeerJS (peerjs@1.5.4)

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
let   hostActionMenuTargetPeerId = null;      // peerId the action menu is currently open for
let   hostPeerId               = "";          // peerId of the room owner (known on both sides)

// ═══════════════════════════════════════════════════
//  PERSISTENCE — USERNAME & RECENT ROOMS
// ═══════════════════════════════════════════════════

const STORAGE_KEY_USERNAME     = "dropin_username";
const STORAGE_KEY_RECENT_ROOMS = "dropin_recent_rooms";
const MAX_RECENT_ROOMS         = 20;

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
}

// ═══════════════════════════════════════════════════
//  ROOMS — HOST
// ═══════════════════════════════════════════════════

function createRoom() {
  peer = new window.Peer();

  peer.on("open", (assignedId) => {
    currentRoomId  = assignedId;
    hostPeerId     = assignedId;
    connectedUsers = [{ peerId: assignedId, username: currentUsername }];
    saveRecentRoom(assignedId, true);
    showAppScreen();
    renderUsersList();
    appendSystemMessage("Room created! Share the Room ID to invite others.");
    initMedia([]);
  });

  peer.on("connection", (conn) => registerGuestConnection(conn));
  peer.on("call",       (call) => handleIncomingCall(call));
  peer.on("error",      (err)  => { setLobbyStatus("Error: " + err.message, true); resetLobbyButtons(); });
}

function registerGuestConnection(conn) {
  conn.on("open",  ()     => { guestConnectionMap.set(conn.peer, { conn, username: "Unknown" }); });
  conn.on("data",  (data) => handleDataFromGuest(conn.peer, data));
  conn.on("close", ()     => {
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
      guestEntry.username = data.username;
      connectedUsers.push({ peerId: fromPeerId, username: data.username });
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
//  ROOMS — GUEST
// ═══════════════════════════════════════════════════

function joinRoom(targetRoomId) {
  currentRoomId = targetRoomId;
  peer = new window.Peer();
  peer.on("open",  ()     => { hostConnection = peer.connect(targetRoomId, { reliable: true }); setupConnectionToHost(hostConnection); });
  peer.on("call",  (call) => handleIncomingCall(call));
  peer.on("error", (err)  => { setLobbyStatus("Could not connect: " + err.message, true); resetLobbyButtons(); });
}

function setupConnectionToHost(conn) {
  conn.on("open",  ()     => { conn.send({ type: "hello", username: currentUsername }); showAppScreen(); appendSystemMessage("Connected! Waiting for sync..."); });
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
    case "kicked":      { appendSystemMessage("You were kicked."); setTimeout(() => location.reload(), 2500); break; }
    case "banned":      { appendSystemMessage("You have been banned."); setTimeout(() => location.reload(), 3000); break; }
    case "force_mute": {
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

    if (raisedHandPeerIds.has(user.peerId)) {
      const handIconEl       = document.createElement("span");
      handIconEl.className   = "participant-status-icon";
      handIconEl.innerHTML    = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
      handIconEl.title       = "Hand raised";
      rowEl.appendChild(handIconEl);
    }

    if (isHost && user.peerId !== peer.id) {
      nameEl.classList.add("participant-name--clickable");
      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openHostActionMenu(user.peerId, user.username, e);
      });

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

joinRoomBtnEl.addEventListener("click", () => {
  const targetRoomId = roomIdInputEl.value.trim();
  if (!targetRoomId) { setLobbyStatus("Please enter a Room ID.", true); return; }
  currentUsername          = screenName;
  isHost                   = false;
  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled   = true;
  setLobbyStatus("Connecting...");
  joinRoom(targetRoomId);
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

leaveBtnEl.addEventListener("click", () => {
  // Stop screen share cleanly before leaving
  if (isScreenSharing) {
    screenShareStream?.getTracks().forEach(t => t.stop());
    screenShareStream = null;
    isScreenSharing   = false;
  }
  peer?.destroy();
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
  if (!localStream || isForceMutedByHost) return;
  isMuted = !isMuted;
  for (const track of localStream.getAudioTracks()) track.enabled = !isMuted;
  muteBtnEl.textContent = isMuted ? "Unmute" : "Mute";
  muteBtnEl.classList.toggle("btn-muted", isMuted);
});

camBtnEl.addEventListener("click", () => {
  if (!localStream || isForceCamOffByHost) return;
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

hostActionMenuEl.querySelector(".host-action-mute-btn").addEventListener("click", () => {
  if (hostActionMenuTargetPeerId) forceMuteGuest(hostActionMenuTargetPeerId);
});

hostActionMenuEl.querySelector(".host-action-cam-off-btn").addEventListener("click", () => {
  if (hostActionMenuTargetPeerId) forceCamOffGuest(hostActionMenuTargetPeerId);
});

hostActionMenuEl.querySelector(".host-action-kick-btn").addEventListener("click", () => {
  if (!hostActionMenuTargetPeerId) return;
  kickUser(hostActionMenuTargetPeerId);
  closeHostActionMenu();
});

hostActionMenuEl.querySelector(".host-action-ban-btn").addEventListener("click", () => {
  if (!hostActionMenuTargetPeerId) return;
  banUser(hostActionMenuTargetPeerId);
  closeHostActionMenu();
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
//  HOME SCREEN NAVIGATION
// ═══════════════════════════════════════════════════

document.getElementById("select-rooms-btn").addEventListener("click", () => {
  homeScreenEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
  renderRecentRoomsList();
});

document.getElementById("select-random-btn").addEventListener("click", () => {
  homeScreenEl.classList.add("hidden");
  randomLobbyScreenEl.classList.remove("hidden");
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
  homeScreenEl.classList.remove("hidden");
}

// Pre-fill saved username (if any) so the user doesn't have to retype it
const savedUsername = loadSavedUsername();
if (savedUsername) {
  screenNameInputEl.value         = savedUsername;
  screenNameCounterEl.textContent = savedUsername.length + " / 20";
}

// Update the live character counter as the user types
screenNameInputEl.addEventListener("input", () => {
  const currentLength = screenNameInputEl.value.length;
  screenNameCounterEl.textContent = `${currentLength} / 20`;
  screenNameCounterEl.classList.toggle("near-limit", currentLength >= 16);
  usernameErrorEl.textContent = "";
});

screenNameInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); attemptContinue(); }
});

continueBtnEl.addEventListener("click", () => attemptContinue());

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
    const waiterPeer = new window.Peer(slotId);
    const timer = setTimeout(() => { waiterPeer.destroy(); resolve(null); }, SLOT_REGISTER_TIMEOUT_MS);
    waiterPeer.on("open",  () => { clearTimeout(timer); resolve(waiterPeer); });
    waiterPeer.on("error", () => { clearTimeout(timer); waiterPeer.destroy(); resolve(null); });
  });
}

async function searchForRandomMatch(startSlotIndex) {
  if (randomIsDestroyed) return;

  randomPeer = new window.Peer();

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
    randomPeer = new window.Peer();
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
//  RANDOM MODE — START
// ═══════════════════════════════════════════════════

async function startRandomMode() {
  randomUsername = screenName;
  randomLobbyStatusEl.textContent = "Getting camera...";
  try { randomLocalStream = await acquireRandomLocalStream(); }
  catch (err) { randomLobbyStatusEl.textContent = err.message; return; }

  randomIsDestroyed = false; randomIsMuted = false; randomIsCamOff = false;
  randomActiveCall = null; randomStrangerDataConn = null; randomPeer = null; currentSlotResolver = null;
  randomChatLogEl.innerHTML = "";
  randomLocalVideoEl.srcObject = randomLocalStream;

  randomLobbyScreenEl.classList.add("hidden");
  randomCallScreenEl.classList.remove("hidden");
  showRandomWaitingOverlay();
  setRandomWaitingText("Finding someone...");
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
