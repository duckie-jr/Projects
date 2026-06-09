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

// ─── Screen name (set once on the username screen, used everywhere) ───────────
let screenName = "";

const guestConnectionMap = new Map();  // peerId → { conn, username }
const bannedUsernames    = new Set();
let   hostConnection     = null;
let   connectedUsers     = [];
const mediaCallMap       = new Map();  // peerId → PeerJS Call

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
const usersBarEl       = document.getElementById("users-bar");
const chatLogEl        = document.getElementById("chat-log");
const chatInputEl      = document.getElementById("chat-input");
const sendBtnEl        = document.getElementById("send-btn");
const leaveBtnEl       = document.getElementById("leave-btn");
const videoGridEl      = document.getElementById("video-grid");
const muteBtnEl        = document.getElementById("mute-btn");
const camBtnEl         = document.getElementById("cam-btn");

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
    connectedUsers = [{ peerId: assignedId, username: currentUsername }];
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
  }
}

// ═══════════════════════════════════════════════════
//  ROOMS — KICK / BAN
// ═══════════════════════════════════════════════════

function kickUser(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;
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
  }
}

// ═══════════════════════════════════════════════════
//  ROOMS — MEDIA
// ═══════════════════════════════════════════════════

async function initMedia(existingUsers) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
}

function removeMediaTile(peerId) {
  document.querySelector(`[data-peer-id="${peerId}"]`)?.remove();
}

// ═══════════════════════════════════════════════════
//  ROOMS — UI HELPERS
// ═══════════════════════════════════════════════════

function renderUsersList() {
  usersBarEl.innerHTML = "";
  for (const user of connectedUsers) {
    const chipEl = document.createElement("span");
    chipEl.className   = "user-chip";
    chipEl.textContent = user.username;
    if (isHost && user.peerId !== peer.id) {
      const kickBtnEl = document.createElement("button"); kickBtnEl.className = "kick-btn"; kickBtnEl.textContent = "Kick"; kickBtnEl.addEventListener("click", () => kickUser(user.peerId));
      const banBtnEl  = document.createElement("button"); banBtnEl.className  = "ban-btn";  banBtnEl.textContent  = "Ban";  banBtnEl.addEventListener("click",  () => banUser(user.peerId));
      chipEl.append(kickBtnEl, banBtnEl);
    }
    usersBarEl.appendChild(chipEl);
  }
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

leaveBtnEl.addEventListener("click", () => { peer?.destroy(); location.reload(); });

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
  isMuted = !isMuted;
  for (const track of localStream.getAudioTracks()) track.enabled = !isMuted;
  muteBtnEl.textContent = isMuted ? "Unmute" : "Mute";
  muteBtnEl.classList.toggle("btn-muted", isMuted);
});

camBtnEl.addEventListener("click", () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  for (const track of localStream.getVideoTracks()) track.enabled = !isCamOff;
  camBtnEl.textContent = isCamOff ? "Cam On" : "Cam Off";
  camBtnEl.classList.toggle("btn-muted", isCamOff);
});

// ═══════════════════════════════════════════════════
//  HOME SCREEN NAVIGATION
// ═══════════════════════════════════════════════════

document.getElementById("select-rooms-btn").addEventListener("click", () => {
  homeScreenEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
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
  usernameScreenEl.classList.add("hidden");
  homeScreenEl.classList.remove("hidden");
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
      outgoingCall.on("stream", (remoteStream) => { randomRemoteVideoEl.srcObject = remoteStream; hideRandomWaitingOverlay(); appendRandomSystemMsg("Connected! Say hi 👋"); });
      outgoingCall.on("close",  () => onStrangerLeft("Stranger disconnected."));
    } else if (message.type === "random_bye")  { onStrangerLeft("Stranger ended the chat."); }
      else if (message.type === "random_chat") { appendRandomChatMessage(message); }
  });
  dataConn.on("close", () => { if (randomActiveCall) onStrangerLeft("Stranger disconnected."); });
}

function handleRandomIncomingCall(call) {
  randomActiveCall = call;
  call.answer(randomLocalStream);
  call.on("stream", (remoteStream) => { randomRemoteVideoEl.srcObject = remoteStream; hideRandomWaitingOverlay(); appendRandomSystemMsg("Connected! Say hi 👋"); });
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
