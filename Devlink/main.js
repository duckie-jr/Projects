// window.CodeMirror and window.Peer are loaded via CDN scripts in index.html

// ─── State ────────────────────────────────────────────────────────────────────

let peer = null;
let codeEditor = null;
let currentUsername = '';
let isHost = false;
let currentRoomId = '';
let isSyncingCode = false;

// Host only: peerId -> { conn, username }
const guestConnectionMap = new Map();

// Guest only: single DataConnection to host
let hostConnection = null;

// Shared: array of { peerId, username }
let connectedUsers = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const lobbyScreenEl    = document.getElementById('lobby-screen');
const appScreenEl      = document.getElementById('app-screen');
const usernameInputEl  = document.getElementById('username-input');
const roomIdInputEl    = document.getElementById('room-id-input');
const createRoomBtnEl  = document.getElementById('create-room-btn');
const joinRoomBtnEl    = document.getElementById('join-room-btn');
const lobbyStatusEl    = document.getElementById('lobby-status');
const roomIdLabelEl    = document.getElementById('room-id-label');
const copyIdBtnEl      = document.getElementById('copy-id-btn');
const usersBarEl       = document.getElementById('users-bar');
const chatLogEl        = document.getElementById('chat-log');
const chatInputEl      = document.getElementById('chat-input');
const sendBtnEl        = document.getElementById('send-btn');
const leaveBtnEl       = document.getElementById('leave-btn');
const languageSelectEl = document.getElementById('language-select');

// ─── Code editor ──────────────────────────────────────────────────────────────

function initCodeEditor() {
  codeEditor = window.CodeMirror.fromTextArea(
    document.getElementById('code-editor'),
    {
      theme: 'dracula',
      lineNumbers: true,
      mode: 'javascript',
      tabSize: 2,
      indentWithTabs: false,
      lineWrapping: true,
      autofocus: true,
    }
  );

  codeEditor.setSize('100%', '100%');

  codeEditor.on('change', (_editor, changeObj) => {
    // Skip remote-applied changes to avoid echo loops
    if (isSyncingCode || changeObj.origin === 'setValue') return;
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

function broadcastCodeUpdate(content) {
  const message = { type: 'code_update', content };
  if (isHost) {
    for (const { conn } of guestConnectionMap.values()) conn.send(message);
  } else {
    hostConnection?.send(message);
  }
}

function broadcastChatMessage(text) {
  const message = { type: 'chat', sender: currentUsername, text, timestamp: Date.now() };
  renderChatMessage(message);
  if (isHost) {
    for (const { conn } of guestConnectionMap.values()) conn.send(message);
  } else {
    hostConnection?.send(message);
  }
}

function broadcastUserList() {
  const message = { type: 'user_list', users: connectedUsers };
  for (const { conn } of guestConnectionMap.values()) conn.send(message);
}

// ─── Host logic ───────────────────────────────────────────────────────────────

function createRoom() {
  peer = new window.Peer();

  peer.on('open', (assignedId) => {
    currentRoomId = assignedId;
    connectedUsers = [{ peerId: assignedId, username: currentUsername }];
    showAppScreen();
    renderUsersList();
    appendSystemMessage('Room created! Share the Room ID with others.');
  });

  peer.on('connection', (incomingConn) => {
    registerGuestConnection(incomingConn);
  });

  peer.on('error', (err) => {
    setLobbyStatus(`Error: ${err.message}`, true);
    resetLobbyButtons();
  });
}

function registerGuestConnection(conn) {
  conn.on('open', () => {
    guestConnectionMap.set(conn.peer, { conn, username: 'Unknown' });
  });

  conn.on('data', (data) => {
    handleDataFromGuest(conn.peer, data);
  });

  conn.on('close', () => {
    const guest = guestConnectionMap.get(conn.peer);
    if (!guest) return;
    appendSystemMessage(`${guest.username} left the room.`);
    guestConnectionMap.delete(conn.peer);
    connectedUsers = connectedUsers.filter((user) => user.peerId !== conn.peer);
    renderUsersList();
    broadcastUserList();
  });
}

function handleDataFromGuest(fromPeerId, data) {
  switch (data.type) {
    case 'hello': {
      const guestEntry = guestConnectionMap.get(fromPeerId);
      guestEntry.username = data.username;
      connectedUsers.push({ peerId: fromPeerId, username: data.username });
      renderUsersList();

      // Send the new guest a full snapshot of current state
      guestEntry.conn.send({
        type: 'full_sync',
        codeContent: codeEditor.getValue(),
        users: connectedUsers,
      });

      // Tell everyone else someone joined
      appendSystemMessage(`${data.username} joined the room.`);
      for (const [peerId, { conn }] of guestConnectionMap.entries()) {
        if (peerId === fromPeerId) continue;
        conn.send({ type: 'user_joined', username: data.username });
        conn.send({ type: 'user_list', users: connectedUsers });
      }
      break;
    }
    case 'code_update': {
      applyRemoteCode(data.content);
      // Relay to all other guests
      for (const [peerId, { conn }] of guestConnectionMap.entries()) {
        if (peerId !== fromPeerId) conn.send(data);
      }
      break;
    }
    case 'chat': {
      renderChatMessage(data);
      // Relay to all other guests
      for (const [peerId, { conn }] of guestConnectionMap.entries()) {
        if (peerId !== fromPeerId) conn.send(data);
      }
      break;
    }
  }
}

// ─── Guest logic ──────────────────────────────────────────────────────────────

function joinRoom(targetRoomId) {
  currentRoomId = targetRoomId;
  peer = new window.Peer();

  peer.on('open', () => {
    hostConnection = peer.connect(targetRoomId, { reliable: true });
    setupConnectionToHost(hostConnection);
  });

  peer.on('error', (err) => {
    setLobbyStatus(`Could not connect: ${err.message}`, true);
    resetLobbyButtons();
  });
}

function setupConnectionToHost(conn) {
  conn.on('open', () => {
    conn.send({ type: 'hello', username: currentUsername });
    showAppScreen();
    appendSystemMessage('Connected! Waiting for sync…');
  });

  conn.on('data', (data) => {
    handleDataFromHost(data);
  });

  conn.on('close', () => {
    appendSystemMessage('Disconnected from host.');
  });

  conn.on('error', (err) => {
    appendSystemMessage(`Connection error: ${err.message}`);
  });
}

function handleDataFromHost(data) {
  switch (data.type) {
    case 'full_sync': {
      applyRemoteCode(data.codeContent);
      connectedUsers = data.users;
      renderUsersList();
      appendSystemMessage('Synced with room!');
      break;
    }
    case 'code_update': {
      applyRemoteCode(data.content);
      break;
    }
    case 'chat': {
      renderChatMessage(data);
      break;
    }
    case 'user_joined': {
      appendSystemMessage(`${data.username} joined the room.`);
      break;
    }
    case 'user_list': {
      connectedUsers = data.users;
      renderUsersList();
      break;
    }
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showAppScreen() {
  lobbyScreenEl.classList.add('hidden');
  appScreenEl.classList.remove('hidden');
  roomIdLabelEl.textContent = currentRoomId;
  initCodeEditor();
}

function renderUsersList() {
  usersBarEl.innerHTML = connectedUsers
    .map((user) => `<span class="user-chip">${escapeHtml(user.username)}</span>`)
    .join('');
}

function renderChatMessage({ sender, text, timestamp }) {
  const messageEl = document.createElement('div');
  messageEl.className = 'chat-message';
  const timeStr = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  messageEl.innerHTML = `
    <div class="chat-meta">
      <span class="chat-sender">${escapeHtml(sender)}</span>
      <span class="chat-time">${timeStr}</span>
    </div>
    <div class="chat-text">${escapeHtml(text)}</div>
  `;
  chatLogEl.appendChild(messageEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function appendSystemMessage(text) {
  const messageEl = document.createElement('div');
  messageEl.className = 'chat-message system-message';
  messageEl.textContent = text;
  chatLogEl.appendChild(messageEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setLobbyStatus(text, isError = false) {
  lobbyStatusEl.textContent = text;
  lobbyStatusEl.className = isError ? 'error' : '';
}

function resetLobbyButtons() {
  createRoomBtnEl.disabled = false;
  createRoomBtnEl.textContent = 'Create Room';
  joinRoomBtnEl.disabled = false;
  joinRoomBtnEl.textContent = 'Join';
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendChatMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatInputEl.value = '';
  broadcastChatMessage(text);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

createRoomBtnEl.addEventListener('click', () => {
  const username = usernameInputEl.value.trim();
  if (!username) {
    setLobbyStatus('Please enter your name.', true);
    usernameInputEl.focus();
    return;
  }
  currentUsername = username;
  isHost = true;
  createRoomBtnEl.disabled = true;
  createRoomBtnEl.textContent = 'Connecting…';
  setLobbyStatus('Creating room…');
  createRoom();
});

joinRoomBtnEl.addEventListener('click', () => {
  const username = usernameInputEl.value.trim();
  const targetRoomId = roomIdInputEl.value.trim();
  if (!username) {
    setLobbyStatus('Please enter your name.', true);
    usernameInputEl.focus();
    return;
  }
  if (!targetRoomId) {
    setLobbyStatus('Please paste a Room ID.', true);
    roomIdInputEl.focus();
    return;
  }
  currentUsername = username;
  isHost = false;
  joinRoomBtnEl.disabled = true;
  joinRoomBtnEl.textContent = 'Joining…';
  setLobbyStatus('Connecting to room…');
  joinRoom(targetRoomId);
});

usernameInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const hasRoomId = roomIdInputEl.value.trim();
  if (hasRoomId) joinRoomBtnEl.click();
  else createRoomBtnEl.click();
});

roomIdInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoomBtnEl.click();
});

copyIdBtnEl.addEventListener('click', () => {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    copyIdBtnEl.textContent = '✓ Copied!';
    setTimeout(() => { copyIdBtnEl.textContent = 'Copy ID'; }, 2000);
  });
});

sendBtnEl.addEventListener('click', sendChatMessage);

chatInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
});

leaveBtnEl.addEventListener('click', () => {
  if (peer) peer.destroy();
  location.reload();
});

languageSelectEl.addEventListener('change', (event) => {
  if (codeEditor) codeEditor.setOption('mode', event.target.value);
});
