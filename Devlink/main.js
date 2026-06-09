// ─── Globals from CDN ────────────────────────────────────────────────────────
// window.Peer      → PeerJS  (peerjs@1.5.4)
// window.CodeMirror → CodeMirror 5

// ─── State ───────────────────────────────────────────────────────────────────

let peer          = null;
let codeEditor    = null;
let isHost        = false;
let currentRoomId = "";
let currentUsername = "";
let roomType      = "text";   // "text" | "audio" | "video"
let isSyncingCode = false;

// Media
let localStream   = null;     // our own mic/camera MediaStream
let isMuted       = false;
let isCamOff      = false;

// Host only
const guestConnectionMap = new Map();  // peerId -> { conn, username }
const bannedUsernames    = new Set();  // lower-cased usernames

// Guest only
let hostConnection = null;

// Shared
let connectedUsers = [];               // [{ peerId, username }]
const mediaCallMap = new Map();        // peerId -> PeerJS Call

// ─── DOM refs ────────────────────────────────────────────────────────────────

const lobbyScreenEl    = document.getElementById("lobby-screen");
const appScreenEl      = document.getElementById("app-screen");
const usernameInputEl  = document.getElementById("username-input");
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
const languageSelectEl = document.getElementById("language-select");
const mediaControlsEl  = document.getElementById("media-controls");
const mediaPanelEl     = document.getElementById("media-panel");
const videoGridEl      = document.getElementById("video-grid");
const muteBtnEl        = document.getElementById("mute-btn");
const camBtnEl         = document.getElementById("cam-btn");

// ─── Code editor ─────────────────────────────────────────────────────────────

function initCodeEditor() {
  codeEditor = window.CodeMirror.fromTextArea(
    document.getElementById("code-editor"),
    {
      theme: "dracula",
      lineNumbers: true,
      mode: "javascript",
      tabSize: 2,
      indentWithTabs: false,
      lineWrapping: true,
      autofocus: true,
    }
  );

  codeEditor.setSize("100%", "100%");

  codeEditor.on("change", (_editor, changeObj) => {
    // Ignore changes that came from a remote sync to avoid echo loops
    if (isSyncingCode || changeObj.origin === "setValue") return;
    broadcastCodeUpdate(codeEditor.getValue());
  });
}

function applyRemoteCode(content) {
  isSyncingCode = true;
  const savedCursor = codeEditor.getCursor();
  codeEditor.setValue(content);
  codeEditor.setCursor(savedCursor);
  isSyncingCode = false;
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function sendToAll(message) {
  if (isHost) {
    for (const { conn } of guestConnectionMap.values()) conn.send(message);
  } else {
    hostConnection?.send(message);
  }
}

function broadcastCodeUpdate(content) {
  sendToAll({ type: "code_update", content });
}

function broadcastChatMessage(text) {
  const message = { type: "chat", sender: currentUsername, text, timestamp: Date.now() };
  renderChatMessage(message);
  sendToAll(message);
}

// Host only: relay a message to every guest except one sender
function relayToOthers(fromPeerId, message) {
  for (const [peerId, { conn }] of guestConnectionMap.entries()) {
    if (peerId !== fromPeerId) conn.send(message);
  }
}

// Host only: push updated user list to all guests
function broadcastUserList() {
  const message = { type: "user_list", users: connectedUsers };
  for (const { conn } of guestConnectionMap.values()) conn.send(message);
}


// ─── Show app screen ──────────────────────────────────────────────────────────

function showAppScreen() {
  lobbyScreenEl.classList.add("hidden");
  appScreenEl.classList.remove("hidden");
  roomIdLabelEl.textContent = currentRoomId;
  initCodeEditor();
  applyRoomTypeLayout();
}

// Apply the correct layout based on roomType.
// text  → editor always visible, normal widths
// code  → editor always visible, wider editor via CSS class
// video → editor hidden by default, media panel + controls shown
function applyRoomTypeLayout() {
  const editorPaneEl = document.getElementById("editor-pane");

  if (roomType === "video") {
    editorPaneEl.classList.add("hidden");
    mediaPanelEl.classList.remove("hidden");
    mediaControlsEl.classList.remove("hidden");
    toggleCodeBtnEl.classList.remove("hidden");
  } else if (roomType === "code") {
    appScreenEl.classList.add("layout-code");
  }
  // "text" uses the default layout — no changes needed
}

const toggleCodeBtnEl = document.getElementById("toggle-code-btn");

// ─── Host logic ───────────────────────────────────────────────────────────────

function createRoom() {
  peer = new window.Peer();

  peer.on("open", (assignedId) => {
    currentRoomId = assignedId;
    connectedUsers = [{ peerId: assignedId, username: currentUsername }];
    showAppScreen();
    renderUsersList();
    appendSystemMessage("Room created! Share the Room ID to invite others.");

    if (roomType === "video") initMedia([]);
  });

  peer.on("connection", (incomingConn) => {
    registerGuestConnection(incomingConn);
  });

  // Host also answers incoming media calls (guests call the host)
  peer.on("call", (call) => {
    handleIncomingCall(call);
  });

  peer.on("error", (err) => {
    setLobbyStatus("Error: " + err.message, true);
    resetLobbyButtons();
  });
}

function registerGuestConnection(conn) {
  conn.on("open", () => {
    guestConnectionMap.set(conn.peer, { conn, username: "Unknown" });
  });

  conn.on("data", (data) => {
    handleDataFromGuest(conn.peer, data);
  });

  conn.on("close", () => {
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
      // Reject immediately if the username is banned
      if (bannedUsernames.has(data.username.toLowerCase())) {
        const entry = guestConnectionMap.get(fromPeerId);
        if (entry) {
          entry.conn.send({ type: "banned" });
          entry.conn.close();
          guestConnectionMap.delete(fromPeerId);
        }
        return;
      }

      const guestEntry = guestConnectionMap.get(fromPeerId);
      guestEntry.username = data.username;
      connectedUsers.push({ peerId: fromPeerId, username: data.username });
      renderUsersList();

      // Send the new guest a full snapshot so they can catch up
      guestEntry.conn.send({
        type: "full_sync",
        codeContent: codeEditor.getValue(),
        users: connectedUsers,
        roomType,
      });

      appendSystemMessage(data.username + " joined the room.");

      // Tell all existing guests about the new arrival (includes peerId so
      // they can open a direct media call without going through the host)
      relayToOthers(fromPeerId, {
        type: "user_joined",
        username: data.username,
        peerId: fromPeerId,
      });

      broadcastUserList();
      break;
    }

    case "code_update": {
      applyRemoteCode(data.content);
      relayToOthers(fromPeerId, data);
      break;
    }

    case "chat": {
      renderChatMessage(data);
      relayToOthers(fromPeerId, data);
      break;
    }
  }
}

// ─── Host controls: kick / ban ────────────────────────────────────────────────

function kickUser(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;

  guest.conn.send({ type: "kicked" });
  guest.conn.close();

  if (mediaCallMap.has(peerId)) {
    mediaCallMap.get(peerId).close();
    mediaCallMap.delete(peerId);
  }

  guestConnectionMap.delete(peerId);
  connectedUsers = connectedUsers.filter((u) => u.peerId !== peerId);
  removeMediaTile(peerId);
  renderUsersList();
  broadcastUserList();
  appendSystemMessage(guest.username + " was kicked from the room.");
}

function banUser(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;
  bannedUsernames.add(guest.username.toLowerCase());
  guest.conn.send({ type: "banned" });
  // Reuse kick to clean up connections and state
  kickUser(peerId);
  appendSystemMessage(guest.username + " was banned.");
}

// ─── Guest logic ──────────────────────────────────────────────────────────────

function joinRoom(targetRoomId) {
  currentRoomId = targetRoomId;
  peer = new window.Peer();

  peer.on("open", () => {
    hostConnection = peer.connect(targetRoomId, { reliable: true });
    setupConnectionToHost(hostConnection);
  });

  // Guests answer incoming media calls from the host and other guests
  peer.on("call", (call) => {
    handleIncomingCall(call);
  });

  peer.on("error", (err) => {
    setLobbyStatus("Could not connect: " + err.message, true);
    resetLobbyButtons();
  });
}

function setupConnectionToHost(conn) {
  conn.on("open", () => {
    conn.send({ type: "hello", username: currentUsername });
    showAppScreen();
    appendSystemMessage("Connected! Waiting for room sync...");
  });

  conn.on("data", (data) => {
    handleDataFromHost(data);
  });

  conn.on("close", () => {
    appendSystemMessage("Disconnected from host.");
  });

  conn.on("error", (err) => {
    appendSystemMessage("Connection error: " + err.message);
  });
}

function handleDataFromHost(data) {
  switch (data.type) {

    case "full_sync": {
      applyRemoteCode(data.codeContent);
      connectedUsers = data.users;
      roomType = data.roomType;

      // Re-apply layout now that we know the room type
      applyRoomTypeLayout();
      renderUsersList();
      appendSystemMessage("Synced with room!");

      // Start media and call all peers already in the room
      if (roomType === "video") initMedia(data.users);
      break;
    }

    case "code_update": {
      applyRemoteCode(data.content);
      break;
    }

    case "chat": {
      renderChatMessage(data);
      break;
    }

    case "user_joined": {
      // A new guest joined — they will call us, so we just log it
      appendSystemMessage(data.username + " joined the room.");
      break;
    }

    case "user_list": {
      connectedUsers = data.users;
      renderUsersList();
      break;
    }

    case "kicked": {
      appendSystemMessage("You were kicked from the room.");
      setTimeout(() => location.reload(), 2500);
      break;
    }

    case "banned": {
      appendSystemMessage("You have been banned from this room.");
      setTimeout(() => location.reload(), 3000);
      break;
    }
  }
}

// ─── Media ────────────────────────────────────────────────────────────────────

async function initMedia(existingUsers) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (_videoErr) {
    // Fall back to audio-only if the camera is unavailable or denied
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } catch (audioErr) {
      appendSystemMessage("Could not access microphone: " + audioErr.message);
      return;
    }
  }

  addMediaTile("local", currentUsername, localStream);

  // Call every peer already in the room (skip ourselves)
  for (const user of existingUsers) {
    if (user.peerId === peer.id) continue;

    const outgoingCall = peer.call(user.peerId, localStream);
    mediaCallMap.set(user.peerId, outgoingCall);

    outgoingCall.on("stream", (remoteStream) => {
      addMediaTile(user.peerId, user.username, remoteStream);
    });
    outgoingCall.on("close", () => removeMediaTile(user.peerId));
  }
}

function handleIncomingCall(call) {
  call.answer(localStream ?? new MediaStream());
  mediaCallMap.set(call.peer, call);

  call.on("stream", (remoteStream) => {
    const callerUser = connectedUsers.find((u) => u.peerId === call.peer);
    const callerUsername = callerUser ? callerUser.username : "Unknown";
    addMediaTile(call.peer, callerUsername, remoteStream);
  });

  call.on("close", () => removeMediaTile(call.peer));
}

function addMediaTile(peerId, username, stream) {
  // Prevent duplicate tiles for the same peer
  if (document.querySelector(`[data-peer-id="${peerId}"]`)) return;

  const hasVideoTrack = stream.getVideoTracks().length > 0;

  if (hasVideoTrack) {
    const tileEl = document.createElement("div");
    tileEl.className = "video-tile";
    tileEl.dataset.peerId = peerId;

    const videoEl = document.createElement("video");
    videoEl.srcObject = stream;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    // Mute local preview to avoid feedback
    if (peerId === "local") videoEl.muted = true;

    const labelEl = document.createElement("div");
    labelEl.className = "video-tile-label";
    labelEl.textContent = peerId === "local" ? username + " (you)" : username;

    tileEl.append(videoEl, labelEl);
    videoGridEl.appendChild(tileEl);
  } else {
    // Audio-only: show an avatar tile and play audio in a hidden element
    const tileEl = document.createElement("div");
    tileEl.className = "audio-tile";
    tileEl.dataset.peerId = peerId;

    const avatarEl = document.createElement("div");
    avatarEl.className = "audio-avatar";
    avatarEl.textContent = username.charAt(0).toUpperCase();

    const nameEl = document.createElement("div");
    nameEl.className = "audio-name";
    nameEl.textContent = peerId === "local" ? username + " (you)" : username;

    if (peerId !== "local") {
      const audioEl = document.createElement("audio");
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      tileEl.appendChild(audioEl);
    }

    tileEl.append(avatarEl, nameEl);
    videoGridEl.appendChild(tileEl);
  }
}

function removeMediaTile(peerId) {
  document.querySelector(`[data-peer-id="${peerId}"]`)?.remove();
}

// ─── UI render helpers ────────────────────────────────────────────────────────

function renderUsersList() {
  usersBarEl.innerHTML = "";

  for (const user of connectedUsers) {
    const chipEl = document.createElement("span");
    chipEl.className = "user-chip";
    chipEl.textContent = user.username;

    // Host gets kick / ban controls on every guest chip
    if (isHost && user.peerId !== peer.id) {
      const kickBtnEl = document.createElement("button");
      kickBtnEl.className = "kick-btn";
      kickBtnEl.textContent = "Kick";
      kickBtnEl.addEventListener("click", () => kickUser(user.peerId));

      const banBtnEl = document.createElement("button");
      banBtnEl.className = "ban-btn";
      banBtnEl.textContent = "Ban";
      banBtnEl.addEventListener("click", () => banUser(user.peerId));

      chipEl.append(kickBtnEl, banBtnEl);
    }

    usersBarEl.appendChild(chipEl);
  }
}

function renderChatMessage(message) {
  const messageEl = document.createElement("div");
  messageEl.className = "chat-message";

  const metaEl = document.createElement("div");
  metaEl.className = "chat-meta";

  const senderEl = document.createElement("span");
  senderEl.className = "chat-sender";
  senderEl.textContent = message.sender;

  const timeEl = document.createElement("span");
  timeEl.className = "chat-time";
  timeEl.textContent = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const textEl = document.createElement("div");
  textEl.className = "chat-text";
  textEl.textContent = message.text;

  metaEl.append(senderEl, timeEl);
  messageEl.append(metaEl, textEl);
  chatLogEl.appendChild(messageEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function appendSystemMessage(text) {
  const messageEl = document.createElement("div");
  messageEl.className = "system-message";
  messageEl.textContent = text;
  chatLogEl.appendChild(messageEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setLobbyStatus(text, isError = false) {
  lobbyStatusEl.textContent = text;
  lobbyStatusEl.classList.toggle("error", isError);
}

function resetLobbyButtons() {
  createRoomBtnEl.disabled = false;
  joinRoomBtnEl.disabled = false;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

createRoomBtnEl.addEventListener("click", () => {
  const username = usernameInputEl.value.trim();
  if (!username) {
    setLobbyStatus("Please enter a username.", true);
    return;
  }

  currentUsername = username;
  isHost = true;
  roomType = document.querySelector('input[name="room-type"]:checked').value;

  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled = true;
  setLobbyStatus("Creating room...");
  createRoom();
});

joinRoomBtnEl.addEventListener("click", () => {
  const username = usernameInputEl.value.trim();
  const targetRoomId = roomIdInputEl.value.trim();

  if (!username) {
    setLobbyStatus("Please enter a username.", true);
    return;
  }
  if (!targetRoomId) {
    setLobbyStatus("Please enter a Room ID.", true);
    return;
  }

  currentUsername = username;
  isHost = false;

  createRoomBtnEl.disabled = true;
  joinRoomBtnEl.disabled = true;
  setLobbyStatus("Connecting...");
  joinRoom(targetRoomId);
});

copyIdBtnEl.addEventListener("click", () => {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    const originalText = copyIdBtnEl.textContent;
    copyIdBtnEl.textContent = "Copied!";
    setTimeout(() => { copyIdBtnEl.textContent = originalText; }, 1500);
  });
});

leaveBtnEl.addEventListener("click", () => {
  peer?.destroy();
  location.reload();
});

sendBtnEl.addEventListener("click", () => {
  const messageText = chatInputEl.value.trim();
  if (!messageText) return;
  chatInputEl.value = "";
  broadcastChatMessage(messageText);
});

chatInputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const messageText = chatInputEl.value.trim();
  if (!messageText) return;
  chatInputEl.value = "";
  broadcastChatMessage(messageText);
});

languageSelectEl.addEventListener("change", () => {
  if (codeEditor) codeEditor.setOption("mode", languageSelectEl.value);
});

toggleCodeBtnEl.addEventListener("click", () => {
  const editorPaneEl = document.getElementById("editor-pane");
  const isNowHidden = editorPaneEl.classList.toggle("hidden");

  toggleCodeBtnEl.textContent = isNowHidden ? "Show Code" : "Hide Code";

  // CodeMirror needs a manual refresh after its container becomes visible
  if (!isNowHidden && codeEditor) codeEditor.refresh();
});

muteBtnEl.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;

  for (const audioTrack of localStream.getAudioTracks()) {
    audioTrack.enabled = !isMuted;
  }

  muteBtnEl.textContent = isMuted ? "Unmute" : "Mute";
  muteBtnEl.classList.toggle("btn-muted", isMuted);
});

camBtnEl.addEventListener("click", () => {
  if (!localStream) return;
  isCamOff = !isCamOff;

  for (const videoTrack of localStream.getVideoTracks()) {
    videoTrack.enabled = !isCamOff;
  }

  camBtnEl.textContent = isCamOff ? "Cam On" : "Cam Off";
  camBtnEl.classList.toggle("btn-muted", isCamOff);
});
