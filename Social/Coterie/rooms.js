// ═══════════════════════════════════════════════════
//  rooms.js  —  Room registry + WebRTC lifecycle
//
//  Globals consumed from main.js (resolved at call-time):
//    peer, isHost, currentRoomId, currentUsername, currentRoomName,
//    currentRoomMaxSize, currentRoomPassword, localStream, isMuted,
//    isCamOff, connectedUsers, guestConnectionMap, mediaCallMap,
//    hostConnection, hostPeerId, bannedUsernames, ghostObserverPeerIds,
//    forceMutedPeerIds, forceCamOffPeerIds, raisedHandPeerIds,
//    isScreenSharing, screenShareStream, localHandRaised, userNumber,
//    isCreator, screenName, failoverInProgress,
//    REGISTRY_PEER_ID, REGISTRY_HEARTBEAT_MS, REGISTRY_STALE_MS,
//    REGISTRY_QUERY_TIMEOUT, registryHolderPeer, registeredServers,
//    registryAnnounceConn, registryAnnounceTimer,
//    registryStatsRoomsCreatedToday, registryStatsPeakConcurrentUsers,
//    registryStatsTotalBansIssued, STORAGE_KEY_PENDING_MOVE,
//    hostActionMenuTargetPeerId,
//    broadcastCountdownTimer, FAILOVER_PEER_PREFIX, FAILOVER_GRACE_MS,
//    FAILOVER_TIMEOUT_MS,
//    createPeer, PEER_OPTIONS, saveRecentRoom, loadRecentRooms,
//    updateRegistryPeakConcurrentUsers, calculateCurrentConcurrentUsers,
//    queryPlatformStats,
//  DOM refs (all defined in main.js):
//    usernameScreenEl, homeScreenEl, lobbyScreenEl, appScreenEl,
//    roomBrowserScreenEl, roomIdLabelEl, roomNameLabelEl, roomLockBadgeEl,
//    roomCodeOverlayEl, roomCodeOverlayTextEl, usersCountEl, usersBarEl,
//    chatLogEl, chatInputEl, sendBtnEl, leaveBtnEl, videoGridEl,
//    muteBtnEl, camBtnEl, screenShareBtnEl, raiseHandBtnEl,
//    participantsListEl, hostActionMenuEl, copyIdBtnEl,
//    broadcastOverlayEl, broadcastMessageTextEl, broadcastDismissBtnEl,
//    broadcastTimerBadgeEl, usersCountBtnEl, participantsPanelEl,
//    closePanelBtnEl, lobbyStatusEl, rbStatusEl, rbCreateBtnEl,
//    guestPasswordModalEl, guestPasswordDescEl, guestPasswordEntryEl,
//    guestPasswordErrorEl, guestPasswordSubmitBtnEl,
//  Globals consumed from dev.js (available at runtime, loaded after):
//    CREATOR_PASSWORD, isCreator
// ═══════════════════════════════════════════════════

// ─── Tuning constants ────────────────────────────────────────────────────────
const GUEST_PING_INTERVAL_MS = 5_000;
const GUEST_PONG_TIMEOUT_MS  = 15_000;

// Shim required by dev.js forceCloseRoom — when this browser IS the registry
// holder, blocked room IDs are tracked here so re-registration is refused.
const blockedRoomIds = new Map();   // roomId → expiry timestamp

let _guestHeartbeatTimer = null;


// ═══════════════════════════════════════════════════
//  STATUS / URL HELPERS
// ═══════════════════════════════════════════════════

function setLobbyStatus(message, isError = false) {
  [rbStatusEl, lobbyStatusEl].forEach((el) => {
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", isError);
  });
}

function clearRoomFromUrl() {
  if (window.location.search) {
    window.history.replaceState({}, "", window.location.origin + window.location.pathname);
  }
}

// Push the current room into the URL so it's shareable.
// Only includes ?name= and ?password= when they are non-empty.
function _setRoomUrl() {
  if (!currentRoomId) return;
  const params = new URLSearchParams();
  params.set("room", currentRoomId);
  if (currentRoomName)     params.set("name",     currentRoomName);
  if (currentRoomPassword) params.set("password", currentRoomPassword);
  window.history.replaceState({}, "", window.location.pathname + "?" + params.toString());
}


// ═══════════════════════════════════════════════════
//  PEER-JS ROOM REGISTRY
//
//  One browser claims REGISTRY_PEER_ID and becomes the holder.
//  All others connect to it to register, heartbeat, query, and unregister.
//  If the holder disappears a new one self-elects on the next createRoom /
//  fetchActiveServers call.
// ═══════════════════════════════════════════════════

// Attempt to become the registry holder.  Resolves to true if we claimed it,
// false if someone else already holds it.
async function _tryClaimRegistry() {
  return new Promise((resolve) => {
    const claimPeer = new window.Peer(REGISTRY_PEER_ID, PEER_OPTIONS);
    const timer = setTimeout(() => {
      try { claimPeer.destroy(); } catch (_) {}
      resolve(false);
    }, 3_000);

    claimPeer.once("open", () => {
      clearTimeout(timer);
      // We got the ID — become the holder.
      registryHolderPeer = claimPeer;
      _attachHolderHandlers(claimPeer);
      resolve(true);
    });

    claimPeer.once("error", (err) => {
      clearTimeout(timer);
      try { claimPeer.destroy(); } catch (_) {}
      // "unavailable-id" means another peer already holds it — that is fine.
      resolve(false);
    });
  });
}

// Wire up the data-connection handler so the holder can serve requests.
function _attachHolderHandlers(holderPeer) {
  holderPeer.on("connection", (conn) => {
    conn.on("data", (msg) => {
      if (!msg?.type) return;
      handleRegistryMessage(conn, msg);
    });
  });
}

// Called both by the holder (directly) and externally from dev.js.
function handleRegistryMessage(conn, msg) {
  if (!msg?.type) return;

  const now = Date.now();

  // Expire blocked-room entries on each message to avoid memory growth.
  for (const [rid, expiry] of blockedRoomIds) {
    if (now > expiry) blockedRoomIds.delete(rid);
  }

  switch (msg.type) {
    case "register_room": {
      if (!msg.roomId || blockedRoomIds.has(msg.roomId)) break;
      registeredServers.set(msg.roomId, { ...msg, updatedAt: now });
      registryStatsRoomsCreatedToday++;
      updateRegistryPeakConcurrentUsers();
      break;
    }

    case "heartbeat": {
      if (!msg.roomId) break;
      if (blockedRoomIds.has(msg.roomId)) break;
      const existing = registeredServers.get(msg.roomId);
      if (existing) {
        Object.assign(existing, msg, { updatedAt: now });
      } else {
        registeredServers.set(msg.roomId, { ...msg, updatedAt: now });
      }
      updateRegistryPeakConcurrentUsers();
      break;
    }

    case "unregister_room": {
      registeredServers.delete(msg.roomId);
      break;
    }

    case "query_rooms": {
      // Prune stale entries before replying.
      for (const [rid, room] of registeredServers) {
        if (now - room.updatedAt > REGISTRY_STALE_MS) registeredServers.delete(rid);
      }
      conn.send({ type: "rooms_list", rooms: [...registeredServers.values()] });
      break;
    }
  }
}

// Return the live room list.  If this browser holds the registry we answer
// directly; otherwise we open a temporary peer, connect to the holder, and
// ask for the list.
async function fetchActiveServers() {
  // ── Holder fast-path ─────────────────────────────────────────────────────
  if (registryHolderPeer) {
    const now = Date.now();
    for (const [rid, room] of registeredServers) {
      if (now - room.updatedAt > REGISTRY_STALE_MS) registeredServers.delete(rid);
    }
    return [...registeredServers.values()];
  }

  // ── Connect to holder ────────────────────────────────────────────────────
  const queryPeer = createPeer();

  const peerOpened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4_000);
    queryPeer.once("open",  () => { clearTimeout(timer); resolve(true);  });
    queryPeer.once("error", () => { clearTimeout(timer); resolve(false); });
  });

  if (!peerOpened) {
    try { queryPeer.destroy(); } catch (_) {}
    return [];
  }

  const conn = queryPeer.connect(REGISTRY_PEER_ID, { reliable: true });

  const rooms = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), REGISTRY_QUERY_TIMEOUT);

    conn.once("open", () => conn.send({ type: "query_rooms" }));

    conn.once("data", (response) => {
      clearTimeout(timer);
      resolve(Array.isArray(response?.rooms) ? response.rooms : []);
    });

    conn.once("error", () => { clearTimeout(timer); resolve([]); });
    conn.once("close", () => { clearTimeout(timer); resolve([]); });
  });

  try { queryPeer.destroy(); } catch (_) {}
  return rooms;
}

// ── Register this host's room with the registry ───────────────────────────

async function _registerRoomWithRegistry(roomData) {
  // Holder registers locally without a round-trip.
  if (registryHolderPeer) {
    if (!blockedRoomIds.has(roomData.roomId)) {
      registeredServers.set(roomData.roomId, { ...roomData, updatedAt: Date.now() });
      registryStatsRoomsCreatedToday++;
      updateRegistryPeakConcurrentUsers();
    }
    _startRegistryHeartbeat();
    return;
  }

  // Non-holder: open a persistent peer just for registry comms.
  const regPeer = createPeer();

  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    regPeer.once("open",  () => { clearTimeout(timer); resolve(true);  });
    regPeer.once("error", () => { clearTimeout(timer); resolve(false); });
  });

  if (!opened) { try { regPeer.destroy(); } catch (_) {} return; }

  const conn = regPeer.connect(REGISTRY_PEER_ID, { reliable: true });

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4_000);
    conn.once("open", () => {
      conn.send({ type: "register_room", ...roomData });
      clearTimeout(timer);
      setTimeout(resolve, 300);
    });
    conn.once("error", () => { clearTimeout(timer); resolve(); });
  });

  registryAnnounceConn = conn;
  _startRegistryHeartbeat();
  // regPeer intentionally kept alive — it owns registryAnnounceConn.
}

function _startRegistryHeartbeat() {
  _stopRegistryHeartbeat();
  registryAnnounceTimer = setInterval(_sendRegistryHeartbeat, REGISTRY_HEARTBEAT_MS);
}

function _stopRegistryHeartbeat() {
  if (registryAnnounceTimer) {
    clearInterval(registryAnnounceTimer);
    registryAnnounceTimer = null;
  }
}

function _sendRegistryHeartbeat() {
  if (!currentRoomId) return;
  const payload = {
    type:             "heartbeat",
    roomId:           currentRoomId,
    hostName:         currentUsername,
    roomName:         currentRoomName,
    participantCount: connectedUsers.length,
    maxSize:          currentRoomMaxSize,
    isPassworded:     !!currentRoomPassword,
    participants:     connectedUsers.map((u) => ({
      peerId:     u.peerId,
      username:   u.username,
      userNumber: u.userNumber,
    })),
  };

  if (registryHolderPeer) {
    const entry = registeredServers.get(currentRoomId);
    if (entry) Object.assign(entry, payload, { updatedAt: Date.now() });
    updateRegistryPeakConcurrentUsers();
  } else if (registryAnnounceConn) {
    try { registryAnnounceConn.send(payload); } catch (_) {}
  }
}

function _unregisterRoomFromRegistry() {
  _stopRegistryHeartbeat();
  if (registryHolderPeer) {
    registeredServers.delete(currentRoomId);
  } else if (registryAnnounceConn) {
    try {
      registryAnnounceConn.send({ type: "unregister_room", roomId: currentRoomId });
    } catch (_) {}
    registryAnnounceConn = null;
  }
}


// ═══════════════════════════════════════════════════
//  HELPER PEER  (dev.js uses this to send one-off creator commands)
// ═══════════════════════════════════════════════════

async function createHelperPeer() {
  const helperPeer = createPeer();
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    helperPeer.once("open",  () => { clearTimeout(timer); resolve(true);  });
    helperPeer.once("error", () => { clearTimeout(timer); resolve(false); });
  });
  if (!opened) { try { helperPeer.destroy(); } catch (_) {} return null; }
  return helperPeer;
}

// ═══════════════════════════════════════════════════
//  LOCAL MEDIA
// ═══════════════════════════════════════════════════

async function acquireLocalMedia() {
  // getUserMedia can hang indefinitely if the browser shows a permission prompt
  // that the user never dismisses (common in sandboxed environments like CoderPad).
  // We race it against a 9-second timeout so it can never block room creation.
  const MEDIA_ACQUIRE_TIMEOUT_MS = 9_000;

  const tryGetMedia = async () => {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (_) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (_) { return null; }
    }
  };

  localStream = await Promise.race([
    tryGetMedia(),
    new Promise((resolve) => setTimeout(() => resolve(null), MEDIA_ACQUIRE_TIMEOUT_MS)),
  ]);

  if (!localStream) return;
  addVideoTile('local', currentUsername, localStream, true);
  localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  localStream.getVideoTracks().forEach((t) => { t.enabled = !isCamOff; });
}

// ═══════════════════════════════════════════════════
//  APP SCREEN — UI HELPERS
// ═══════════════════════════════════════════════════

function showAppScreen() {
  [usernameScreenEl, homeScreenEl, lobbyScreenEl, roomBrowserScreenEl]
    .forEach((el) => el?.classList.add('hidden'));
  appScreenEl?.classList.remove('hidden');
  _setRoomUrl();
  updateRoomHeader();

  // Show host-only controls when this client is the room host.
  const hostControlsEl     = document.getElementById('host-controls');
  const chatHostControlsEl = document.getElementById('chat-host-controls');
  if (hostControlsEl)     hostControlsEl.classList.toggle('hidden', !isHost);
  if (chatHostControlsEl) chatHostControlsEl.classList.toggle('hidden', !isHost);

  // Restore persisted chat history from sessionStorage.
  _restoreChatHistory();

  // If returning from a break-out room, show the return bar.
  _checkBreakoutReturnBar();
}

function updateRoomHeader() {
  if (roomIdLabelEl)         roomIdLabelEl.textContent         = currentRoomId;
  if (roomNameLabelEl)       roomNameLabelEl.textContent       = currentRoomName || 'Unnamed Room';
  if (roomLockBadgeEl)       roomLockBadgeEl.classList.toggle('hidden', !currentRoomPassword);
  if (roomCodeOverlayTextEl) roomCodeOverlayTextEl.textContent = currentRoomId;
  // Only flash the room-code overlay for the host — guests already know the ID.
  if (isHost && roomCodeOverlayEl) {
    roomCodeOverlayEl.classList.remove('hidden');
    setTimeout(() => roomCodeOverlayEl?.classList.add('hidden'), 4000);
  }
  document.title = currentRoomName ? 'Coterie \u2014 ' + currentRoomName : 'Coterie';
}

function appendChatMessage(senderName, text, isSystem = false, skipHistory = false) {
  if (!chatLogEl) return;
  const rowEl = document.createElement('div');
  rowEl.className = isSystem ? 'chat-row chat-row--system' : 'chat-row';
  if (!isSystem) {
    const authorEl = document.createElement('span');
    authorEl.className = 'chat-author';
    authorEl.textContent = senderName + ': ';
    rowEl.appendChild(authorEl);
  }
  const textEl = document.createElement('span');
  textEl.className = 'chat-text';
  textEl.textContent = text;
  rowEl.appendChild(textEl);
  chatLogEl.appendChild(rowEl);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  // Persist to sessionStorage for chat history restore.
  if (!skipHistory && !isSystem) {
    _saveChatMessage(senderName, text);
  }

  // Sound notification for incoming messages (not own messages, not system).
  if (!isSystem && !skipHistory && senderName !== currentUsername) {
    _playSound('chat');
  }
}

function updateUsersBar() {
  if (usersBarEl) {
    usersBarEl.innerHTML = '';
    for (const user of connectedUsers) {
      const chipEl = document.createElement('span');
      chipEl.className = 'user-chip';
      chipEl.textContent = user.username;
      if (user.peerId === hostPeerId) chipEl.classList.add('user-chip--host');
      usersBarEl.appendChild(chipEl);
    }
  }
  if (usersCountEl) usersCountEl.textContent = connectedUsers.length;
}

function renderParticipantsList() {
  if (!participantsListEl) return;
  participantsListEl.innerHTML = '';
  for (const user of connectedUsers) {
    const rowEl = document.createElement('div');
    rowEl.className = 'participant-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'participant-name';
    nameEl.textContent = user.username + (user.peerId === hostPeerId ? ' 👑' : '');
    rowEl.appendChild(nameEl);
    if (isHost && user.peerId !== peer?.id) {
      const menuBtnEl = document.createElement('button');
      menuBtnEl.className = 'participant-action-btn';
      menuBtnEl.textContent = '⋯';
      menuBtnEl.addEventListener('click', (e) => { e.stopPropagation(); openHostActionMenu(user.peerId, user.username); });
      rowEl.appendChild(menuBtnEl);
    }
    participantsListEl.appendChild(rowEl);
  }
}

function addVideoTile(peerId, username, stream, isLocal = false) {
  if (!videoGridEl) return;
  removeVideoTile(peerId);
  const tileEl = document.createElement('div');
  tileEl.className = 'video-tile';
  tileEl.dataset.peerId = peerId;
  const videoEl = document.createElement('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = isLocal;
  videoEl.srcObject = stream;
  videoEl.className = 'video-tile-video';
  const labelEl = document.createElement('div');
  labelEl.className = 'video-tile-label';
  labelEl.textContent = username + (isLocal ? ' (you)' : '');
  tileEl.append(videoEl, labelEl);
  videoGridEl.appendChild(tileEl);
}

function removeVideoTile(peerId) {
  videoGridEl?.querySelector('[data-peer-id="' + peerId + '"]')?.remove();
}

function openHostActionMenu(targetPeerId, targetUsername) {
  hostActionMenuTargetPeerId = targetPeerId;
  const nameEl = hostActionMenuEl?.querySelector('.host-action-menu-name');
  if (nameEl) nameEl.textContent = targetUsername ?? '';
  hostActionMenuEl?.classList.remove('hidden');
}

function closeHostActionMenu() {
  hostActionMenuEl?.classList.add('hidden');
  hostActionMenuTargetPeerId = null;
}

function showBroadcastOverlay(text, dismissAfterSeconds = 0) {
  if (!broadcastOverlayEl) return;
  broadcastMessageTextEl.textContent = text;
  broadcastOverlayEl.classList.remove('hidden');
  if (broadcastCountdownTimer) clearInterval(broadcastCountdownTimer);
  if (dismissAfterSeconds > 0) {
    broadcastTimerBadgeEl.textContent = dismissAfterSeconds + 's';
    broadcastTimerBadgeEl?.classList.remove('hidden');
    let remaining = dismissAfterSeconds;
    broadcastCountdownTimer = setInterval(() => {
      remaining--;
      broadcastTimerBadgeEl.textContent = remaining + 's';
      if (remaining <= 0) { clearInterval(broadcastCountdownTimer); broadcastOverlayEl?.classList.add('hidden'); }
    }, 1000);
  } else {
    broadcastTimerBadgeEl?.classList.add('hidden');
  }
}

broadcastDismissBtnEl?.addEventListener('click', () => {
  if (broadcastCountdownTimer) clearInterval(broadcastCountdownTimer);
  broadcastOverlayEl?.classList.add('hidden');
});


// ═══════════════════════════════════════════════════
//  HOST MODE — createRoom + guest lifecycle
// ═══════════════════════════════════════════════════

// persistentRoomId — optional custom PeerJS ID (dev-only feature).
// When supplied, PeerJS registers the peer under that fixed ID so the room
// URL is stable across sessions.  When omitted, PeerJS assigns a random UUID.
async function createRoom(persistentRoomId) {
  setLobbyStatus('Creating room…');
  if (rbCreateBtnEl) rbCreateBtnEl.disabled = true;

  setConnectionStatus('connecting');

  // Delay the registry claim by 300ms so the main room peer gets a head start
  // on the signaling server WebSocket. Both would otherwise race for the same
  // free-tier server simultaneously, which can cause transient failures.
  setTimeout(() => _tryClaimRegistry(), 300);

  // Race peer creation (with automatic retry) against camera/mic acquisition.
  // Both are pure I/O with no dependency on each other.
  let peerResult;
  [peerResult] = await Promise.all([
    createPeerWithRetry(persistentRoomId)
      .then((openPeer) => ({ ok: true, peer: openPeer }))
      .catch((errorType) => ({ ok: false, errorType })),
    acquireLocalMedia(),
  ]);

  if (!peerResult.ok) {
    setConnectionStatus('disconnected');
    const errorType = peerResult.errorType ?? 'unknown';
    const errorMessage = errorType === 'unavailable-id'
      ? 'That Room ID is already taken — try a different one.'
      : errorType === 'timeout'
        ? 'Could not reach the signaling server. Check your connection and try again.'
        : 'Could not create room (' + errorType + ')';
    setLobbyStatus(errorMessage, true);
    if (rbCreateBtnEl) rbCreateBtnEl.disabled = false;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    return;
  }

  peer = peerResult.peer;
  setConnectionStatus('connected');

  currentRoomId  = peer.id;
  hostPeerId     = peer.id;
  connectedUsers = [{ peerId: peer.id, username: currentUsername, userNumber }];

  // Register in background — don't block showing the app screen.
  const roomMeta = {
    roomId:           currentRoomId,
    hostName:         currentUsername,
    roomName:         currentRoomName,
    participantCount: 1,
    maxSize:          currentRoomMaxSize,
    isPassworded:     !!currentRoomPassword,
    participants:     [{ peerId: peer.id, username: currentUsername, userNumber }],
  };
  _registerRoomWithRegistry(roomMeta);

  saveRecentRoom(currentRoomId, true);

  peer.on('connection', handleGuestConnection);
  peer.on('call',       _handleIncomingCall);
  peer.on('error',      (err) => appendChatMessage('System', 'Connection error: ' + err.type, true));

  showAppScreen();
  updateUsersBar();
  renderParticipantsList();
  _startGuestHeartbeat();
}

// Ping every connected guest; drop any that have gone silent.
function _startGuestHeartbeat() {
  if (_guestHeartbeatTimer) clearInterval(_guestHeartbeatTimer);
  _guestHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [peerId, guest] of guestConnectionMap) {
      if (ghostObserverPeerIds.has(peerId)) continue;
      if (now - (guest.lastPong ?? now) > GUEST_PONG_TIMEOUT_MS) {
        _removeGuest(peerId, null);
      } else {
        try { guest.conn.send({ type: 'ping' }); } catch (_) {}
      }
    }
  }, GUEST_PING_INTERVAL_MS);
}

function handleGuestConnection(conn) {
  // Reject if room is at capacity.
  const visibleGuests = [...guestConnectionMap.keys()]
    .filter((pid) => !ghostObserverPeerIds.has(pid)).length;
  if (currentRoomMaxSize > 0 && visibleGuests >= currentRoomMaxSize - 1) {
    conn.once('open', () => { conn.send({ type: 'room_full' }); conn.close(); });
    return;
  }

  // Reject if room is locked (ghost observers bypass this check).
  if (isRoomLocked && !ghostObserverPeerIds.has(conn.peer)) {
    conn.once('open', () => { conn.send({ type: 'room_locked' }); conn.close(); });
    return;
  }

  conn.once('open', () =>
    conn.send({ type: 'welcome', roomName: currentRoomName, requiresPassword: !!currentRoomPassword })
  );

  let guestUsername   = 'Guest';
  let guestUserNumber = '';
  let admitted        = !currentRoomPassword;

  conn.on('data', (data) => {
    if (!data?.type) return;

    if (!admitted && data.type !== 'ghost_hello' && data.type !== 'password_attempt') return;

    switch (data.type) {

      case 'password_attempt':
        if (data.password === currentRoomPassword) {
          admitted = true;
          conn.send({ type: 'password_ok' });
        } else {
          conn.send({ type: 'password_wrong' });
        }
        break;

      case 'ghost_hello':
        if (data.ghostToken === CREATOR_PASSWORD) {
          ghostObserverPeerIds.add(conn.peer);
          conn.send({
            type:  'ghost_approved',
            users: connectedUsers.map((u) => ({
              peerId: u.peerId, username: u.username, userNumber: u.userNumber,
            })),
          });
        } else {
          conn.send({ type: 'ghost_rejected' });
          conn.close();
        }
        break;

      case 'user_info':
        guestUsername   = data.username   || 'Guest';
        guestUserNumber = data.userNumber || '';
        if (bannedUsernames.has(guestUsername)) {
          conn.send({ type: 'kicked', reason: 'You are banned from this room.' });
          conn.close();
          return;
        }
        guestConnectionMap.set(conn.peer, { conn, username: guestUsername, userNumber: guestUserNumber, lastPong: Date.now() });
        connectedUsers.push({ peerId: conn.peer, username: guestUsername, userNumber: guestUserNumber });
        appendChatMessage('System', guestUsername + ' joined.', true);
        _playSound('join');
        _broadcastUserList();
        updateUsersBar();
        renderParticipantsList();
        // Call the new guest so they receive the host's audio/video.
        if (localStream) {
          const call = peer.call(conn.peer, localStream);
          mediaCallMap.set(conn.peer, call);
          call.on('stream', (stream) => addVideoTile(conn.peer, guestUsername, stream));
          call.on('close',  () => removeVideoTile(conn.peer));
        }
        break;

      case 'pong':
        if (guestConnectionMap.has(conn.peer))
          guestConnectionMap.get(conn.peer).lastPong = Date.now();
        break;

      case 'chat':
        if (data.text) {
          const senderName = guestConnectionMap.get(conn.peer)?.username ?? 'Guest';
          appendChatMessage(senderName, data.text);
          _broadcastToGuests({ type: 'chat', senderName, text: data.text }, conn.peer);
        }
        break;

      case 'raise_hand':
        raisedHandPeerIds.add(conn.peer);
        _broadcastToGuests({ type: 'hand_raised', peerId: conn.peer });
        break;

      case 'lower_hand':
        raisedHandPeerIds.delete(conn.peer);
        _broadcastToGuests({ type: 'hand_lowered', peerId: conn.peer });
        break;

      case 'poll_vote':
        _handlePollVote(data.optionIndex);
        break;

      // ── Creator commands forwarded through the guest connection ────────────
      case 'creator_force_close':
        if (data.ghostToken === CREATOR_PASSWORD) shutdownRoom('Admin closed this room.');
        break;

      case 'creator_broadcast':
        if (data.ghostToken === CREATOR_PASSWORD) {
          showBroadcastOverlay(data.text, data.dismissAfterSeconds ?? 0);
          _broadcastToGuests({ type: 'system_broadcast', text: data.text, dismissAfterSeconds: data.dismissAfterSeconds ?? 0 });
        }
        break;

      case 'creator_rename_room':
        if (data.ghostToken === CREATOR_PASSWORD && data.newName) {
          currentRoomName = data.newName;
          updateRoomHeader();
          _broadcastToGuests({ type: 'room_renamed', newName: currentRoomName });
        }
        break;

      case 'creator_force_reload':
        if (data.ghostToken === CREATOR_PASSWORD) {
          _broadcastToGuests({ type: 'force_reload' });
          setTimeout(() => location.reload(), 500);
        }
        break;

      case 'creator_prank':
        if (data.ghostToken === CREATOR_PASSWORD)
          _broadcastToGuests({ type: 'prank', action: data.action });
        break;

      case 'creator_moderate_user':
        if (data.ghostToken === CREATOR_PASSWORD)
          _handleCreatorModeration(data.action, data.userNumber, data.extra);
        break;
    }
  });

  conn.on('close', () => _removeGuest(conn.peer, null));
  conn.on('error', () => _removeGuest(conn.peer, null));
}

// ── Host helpers ──────────────────────────────────

function _removeGuest(peerId, reason) {
  const guest = guestConnectionMap.get(peerId);
  if (!guest) return;
  if (reason) { try { guest.conn.send({ type: 'kicked', reason }); } catch (_) {} }
  guestConnectionMap.delete(peerId);
  ghostObserverPeerIds.delete(peerId);
  const leavingUser = connectedUsers.find((u) => u.peerId === peerId);
  connectedUsers    = connectedUsers.filter((u) => u.peerId !== peerId);
  mediaCallMap.get(peerId)?.close();
  mediaCallMap.delete(peerId);
  removeVideoTile(peerId);
  if (leavingUser && !ghostObserverPeerIds.has(peerId)) {
    appendChatMessage('System', (leavingUser.username || 'Guest') + ' left.', true);
    _playSound('leave');
    _broadcastUserList();
    updateUsersBar();
    renderParticipantsList();
  }
}

function _broadcastToGuests(message, excludePeerId = null) {
  for (const [peerId, guest] of guestConnectionMap) {
    if (peerId === excludePeerId) continue;
    try { guest.conn.send(message); } catch (_) {}
  }
}

function _broadcastUserList() {
  _broadcastToGuests({
    type:  'user_list',
    users: connectedUsers.map((u) => ({ peerId: u.peerId, username: u.username, userNumber: u.userNumber })),
    hostPeerId,
  });
}

function kickGuest(peerId, reason = 'Kicked by host.') {
  _removeGuest(peerId, reason);
}

function banGuest(peerId) {
  const guest = guestConnectionMap.get(peerId);
  if (guest) bannedUsernames.add(guest.username);
  _removeGuest(peerId, 'You have been banned from this room.');
}

function forceMuteGuest(peerId) {
  forceMutedPeerIds.add(peerId);
  guestConnectionMap.get(peerId)?.conn.send({ type: 'force_mute' });
}

function forceCamOffGuest(peerId) {
  forceCamOffPeerIds.add(peerId);
  guestConnectionMap.get(peerId)?.conn.send({ type: 'force_cam_off' });
}

function moveGuestToRoom(peerId, targetRoomId) {
  guestConnectionMap.get(peerId)?.conn.send({ type: 'move_to_room', roomId: targetRoomId });
  setTimeout(() => _removeGuest(peerId, null), 1_500);
}

function shutdownRoom(reason = 'The host closed this room.') {
  _broadcastToGuests({ type: 'room_closed', reason });
  _unregisterRoomFromRegistry();
  if (_guestHeartbeatTimer) { clearInterval(_guestHeartbeatTimer); _guestHeartbeatTimer = null; }
  setTimeout(() => leaveRoom(), 800);
}

function _handleCreatorModeration(action, targetUserNumber, extra) {
  const targetUser = connectedUsers.find((u) => String(u.userNumber) === String(targetUserNumber));
  if (!targetUser) return;
  switch (action) {
    case 'kick':   kickGuest(targetUser.peerId, 'Kicked by admin.'); break;
    case 'ban':    banGuest(targetUser.peerId);                      break;
    case 'mute':   forceMuteGuest(targetUser.peerId);                break;
    case 'cam':    forceCamOffGuest(targetUser.peerId);              break;
    case 'move':   moveGuestToRoom(targetUser.peerId, extra);        break;
  }
}

// Answer any incoming calls (from other guests or ghost observers).
function _handleIncomingCall(call) {
  call.answer(localStream ?? undefined);
  call.on('stream', (remoteStream) => {
    const callerInfo = guestConnectionMap.get(call.peer);
    addVideoTile(call.peer, callerInfo?.username ?? 'Guest', remoteStream);
  });
  call.on('close', () => removeVideoTile(call.peer));
}


// ═══════════════════════════════════════════════════
//  GUEST MODE — joinRoom + host message handling
// ═══════════════════════════════════════════════════

async function joinRoom(roomId) {
  setLobbyStatus('Connecting…');
  setConnectionStatus('connecting');
  peer = createPeer();

  const opened = await new Promise((resolve) => {
    peer.once('open',  ()    => { setConnectionStatus('connecting'); resolve(true); });
    peer.once('error', (err) => {
      setConnectionStatus('disconnected');
      setLobbyStatus('Could not connect: ' + err.type, true);
      resolve(false);
    });
  });

  if (!opened) return;

  isHost     = false;
  hostPeerId = roomId;

  // Answer any media calls that come in (from host or ghost observers).
  peer.on('call', (call) => {
    call.answer(localStream ?? undefined);
    const callerUsername = call.peer === hostPeerId
      ? (connectedUsers.find((u) => u.peerId === hostPeerId)?.username ?? 'Host')
      : 'Guest';
    call.on('stream', (remoteStream) => addVideoTile(call.peer, callerUsername, remoteStream));
    call.on('close',  () => removeVideoTile(call.peer));
    mediaCallMap.set(call.peer, call);
  });

  peer.on('error', (err) => appendChatMessage('System', 'Connection error: ' + err.type, true));

  hostConnection = peer.connect(roomId, { reliable: true });

  hostConnection.once('open', () => {
    // user_info sent after welcome / password_ok
  });

  hostConnection.on('data', (data) => _handleHostMessage(data));

  hostConnection.on('close', () => {
    if (appScreenEl?.classList.contains('hidden')) return;
    setConnectionStatus('disconnected');
    appendChatMessage('System', 'Disconnected from host.', true);
    _showReconnectOverlay();
  });

  hostConnection.on('error', (err) => {
    setLobbyStatus('Connection failed: ' + err.type, true);
  });
}

// Alias used when auto-joining from a ?room= URL or pending-move.
function startJoinRoom(roomId) {
  isHost          = false;
  currentUsername = screenName;
  acquireLocalMedia().then(() => joinRoom(roomId));
}

function _sendUserInfo() {
  hostConnection?.send({
    type:       'user_info',
    username:   currentUsername,
    userNumber: userNumber,
  });
}

function _handleHostMessage(data) {
  if (!data?.type) return;

  switch (data.type) {

    case 'welcome':
      currentRoomName = data.roomName || currentRoomName;
      if (data.requiresPassword) {
        const autoPassword = sessionStorage.getItem('coterie_pending_password');
        if (autoPassword) {
          // Password was supplied in the URL — submit it silently.
          sessionStorage.removeItem('coterie_pending_password');
          hostConnection?.send({ type: 'password_attempt', password: autoPassword });
        } else {
          openGuestPasswordModal(currentRoomName);
        }
      } else {
        _sendUserInfo();
      }
      break;

    case 'password_ok':
      closeGuestPasswordModal?.();
      _sendUserInfo();
      break;

    case 'password_wrong':
      showGuestPasswordError?.('Incorrect password — try again.');
      break;

    case 'room_full':
      setLobbyStatus('That room is full.', true);
      peer?.destroy();
      break;

    case 'kicked':
      showToast(data.reason || 'You were removed from this room.', 'error', 8000);
      peer?.destroy();
      // Delay the reload so the toast has time to slide in and be read.
      setTimeout(() => location.reload(), 3000);
      break;

    case 'user_list':
      connectedUsers = (data.users ?? []);
      if (data.hostPeerId) hostPeerId = data.hostPeerId;
      // Show app screen on first user_list if not already visible.
      // Media was already acquired in startJoinRoom — don't call again.
      if (appScreenEl?.classList.contains('hidden')) {
        saveRecentRoom(currentRoomId || hostPeerId, false);
        currentRoomId = hostPeerId;
        showAppScreen();
      }
      updateUsersBar();
      renderParticipantsList();
      break;

    case 'chat':
      appendChatMessage(data.senderName ?? 'Guest', data.text);
      break;

    case 'ping':
      hostConnection?.send({ type: 'pong' });
      break;

    case 'force_mute':
      isForceMutedByHost = true;
      isMuted            = true;
      localStream?.getAudioTracks().forEach((t) => { t.enabled = false; });
      muteBtnEl?.classList.add('active');
      appendChatMessage('System', 'The host muted you.', true);
      break;

    case 'force_cam_off':
      isForceCamOffByHost = true;
      isCamOff            = true;
      localStream?.getVideoTracks().forEach((t) => { t.enabled = false; });
      camBtnEl?.classList.add('active');
      appendChatMessage('System', 'The host turned off your camera.', true);
      break;

    case 'hand_raised':
      raisedHandPeerIds.add(data.peerId);
      _playSound('hand');
      break;

    case 'hand_lowered':
      raisedHandPeerIds.delete(data.peerId);
      break;

    case 'system_broadcast':
      showBroadcastOverlay(data.text, data.dismissAfterSeconds ?? 0);
      break;

    case 'prank':
      if (data.action === 'air_horn') {
        try {
          const audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
          const oscillator = audioCtx.createOscillator();
          const gainNode   = audioCtx.createGain();
          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          oscillator.type      = 'sawtooth';
          oscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
          gainNode.gain.setValueAtTime(0.8, audioCtx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5);
          oscillator.start();
          oscillator.stop(audioCtx.currentTime + 1.5);
        } catch (_) {}
      }
      break;

    case 'room_renamed':
      currentRoomName = data.newName || currentRoomName;
      updateRoomHeader();
      break;

    case 'move_to_room':
      if (data.roomId) {
        sessionStorage.setItem(STORAGE_KEY_PENDING_MOVE, data.roomId);
        location.reload();
      }
      break;

    case 'force_reload':
      location.reload();
      break;

    case 'room_locked':
      showToast('This room is locked — new participants cannot join right now.', 'warn', 6000);
      peer?.destroy();
      setTimeout(() => location.reload(), 3000);
      break;

    case 'room_lock_state':
      // Host broadcast: lock state changed.
      document.getElementById('room-locked-indicator')?.classList.toggle('hidden', !data.locked);
      break;

    case 'timer_sync':
      _applyTimerSync(data);
      break;

    case 'poll_start':
      _receivePoll(data);
      break;

    case 'poll_update':
      _updatePollResults(data.votes);
      break;

    case 'poll_end':
      _closePollOverlay();
      break;

    case 'break_out_create':
      // This client is designated as the sub-room host.
      sessionStorage.setItem('coterie_breakout_main_room', data.mainRoomId);
      if (data.endsAt) sessionStorage.setItem('coterie_breakout_ends_at', String(data.endsAt));
      sessionStorage.setItem('coterie_breakout_create_room_id', data.breakoutRoomId);
      location.reload();
      break;

    case 'break_out_join':
      // This client joins an existing sub-room.
      sessionStorage.setItem('coterie_breakout_main_room', data.mainRoomId);
      if (data.endsAt) sessionStorage.setItem('coterie_breakout_ends_at', String(data.endsAt));
      sessionStorage.setItem(STORAGE_KEY_PENDING_MOVE, data.breakoutRoomId);
      location.reload();
      break;

    case 'room_closed':
      appendChatMessage('System', data.reason || 'The room was closed.', true);
      setTimeout(() => { peer?.destroy(); location.reload(); }, 1_500);
      break;
  }
}

// Send a creator moderation request through the host connection.
function requestCreatorModeration(action, targetPeerId, extra) {
  hostConnection?.send({
    type:        'creator_moderate_user',
    action,
    userNumber:  connectedUsers.find((u) => u.peerId === targetPeerId)?.userNumber ?? '',
    extra,
    ghostToken:  CREATOR_PASSWORD,
  });
}


// ═══════════════════════════════════════════════════
//  LEAVE ROOM
// ═══════════════════════════════════════════════════

function leaveRoom() {
  if (isHost) _unregisterRoomFromRegistry();
  if (_guestHeartbeatTimer) { clearInterval(_guestHeartbeatTimer); _guestHeartbeatTimer = null; }

  // Stop local media tracks.
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;

  // Close all media calls.
  for (const call of mediaCallMap.values()) { try { call.close(); } catch (_) {} }
  mediaCallMap.clear();

  // Close all guest data connections (host side).
  for (const guest of guestConnectionMap.values()) { try { guest.conn.close(); } catch (_) {} }
  guestConnectionMap.clear();

  // Close host connection (guest side).
  try { hostConnection?.close(); } catch (_) {}
  hostConnection = null;

  try { peer?.destroy(); } catch (_) {}
  peer = null;

  // Reset state.
  isHost             = false;
  currentRoomId      = '';
  currentRoomName    = '';
  currentRoomPassword = '';
  currentRoomMaxSize = 0;
  hostPeerId         = '';
  connectedUsers     = [];
  isMuted            = false;
  isCamOff           = false;
  isForceMutedByHost  = false;
  isForceCamOffByHost = false;
  localHandRaised    = false;
  raisedHandPeerIds.clear();

  // Clear video grid.
  if (videoGridEl) videoGridEl.innerHTML = '';

  // Clear room params from URL and return to room browser.
  clearRoomFromUrl();
  document.title = 'Coterie';
  appScreenEl?.classList.add('hidden');
  roomBrowserScreenEl?.classList.remove('hidden');
  if (rbCreateBtnEl) rbCreateBtnEl.disabled = false;
  setLobbyStatus('');
  refreshRoomBrowser?.();
}


// ═══════════════════════════════════════════════════
//  EVENT LISTENERS — in-room controls
// ═══════════════════════════════════════════════════

// ── Leave ─────────────────────────────────────────
leaveBtnEl?.addEventListener('click', () => leaveRoom());

// ── Copy shareable link ───────────────────────────
// The URL is already set to ?room=ID&name=...&password=... by _setRoomUrl(),
// so copying window.location.href gives a fully working join link.
copyIdBtnEl?.addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href);
  const originalText = copyIdBtnEl.textContent;
  copyIdBtnEl.textContent = 'Link Copied!';
  setTimeout(() => { copyIdBtnEl.textContent = originalText; }, 1_500);
});

// ── Participants panel ────────────────────────────
usersCountBtnEl?.addEventListener('click', () => {
  participantsPanelEl?.classList.toggle('hidden');
  renderParticipantsList();
});
closePanelBtnEl?.addEventListener('click', () => participantsPanelEl?.classList.add('hidden'));

// ── Mute ──────────────────────────────────────────
function _applyMuteButtonState() {
  if (!muteBtnEl) return;
  muteBtnEl.classList.toggle('btn-secondary', !isMuted);
  muteBtnEl.classList.toggle('btn-danger',    isMuted);
  muteBtnEl.textContent = isMuted ? 'Unmute' : 'Mute';
}

muteBtnEl?.addEventListener('click', () => {
  if (isForceMutedByHost) return;
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  _applyMuteButtonState();
});

// ── Camera ────────────────────────────────────────
function _applyCamButtonState() {
  if (!camBtnEl) return;
  camBtnEl.classList.toggle('btn-secondary', !isCamOff);
  camBtnEl.classList.toggle('btn-danger',    isCamOff);
  camBtnEl.textContent = isCamOff ? 'Cam On' : 'Cam Off';
}

camBtnEl?.addEventListener('click', () => {
  if (isForceCamOffByHost) return;
  isCamOff = !isCamOff;
  localStream?.getVideoTracks().forEach((t) => { t.enabled = !isCamOff; });
  _applyCamButtonState();
});

// ── Screen share ──────────────────────────────────
screenShareBtnEl?.addEventListener('click', async () => {
  if (isScreenSharing) {
    screenShareStream?.getTracks().forEach((t) => t.stop());
    screenShareStream = null;
    isScreenSharing   = false;
    screenShareBtnEl.classList.remove('active');
    // Restore camera track in all outgoing calls.
    const cameraTrack = localStream?.getVideoTracks()[0];
    if (cameraTrack) {
      for (const call of mediaCallMap.values()) {
        const sender = call.peerConnection?.getSenders()
          .find((s) => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(cameraTrack).catch(() => {});
      }
    }
    return;
  }
  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    isScreenSharing   = true;
    screenShareBtnEl.classList.add('active');
    const screenTrack = screenShareStream.getVideoTracks()[0];
    // Push new track to all outgoing calls.
    for (const call of mediaCallMap.values()) {
      const sender = call.peerConnection?.getSenders()
        .find((s) => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack).catch(() => {});
    }
    // Auto-stop when the browser's native sharing stops.
    screenTrack.onended = () => screenShareBtnEl?.click();
  } catch (_) {}
});

// ── Raise hand ────────────────────────────────────
raiseHandBtnEl?.addEventListener('click', () => {
  localHandRaised = !localHandRaised;
  raiseHandBtnEl.classList.toggle('active', localHandRaised);
  if (isHost) {
    if (localHandRaised) raisedHandPeerIds.add(peer?.id);
    else                 raisedHandPeerIds.delete(peer?.id);
    _broadcastToGuests({ type: localHandRaised ? 'hand_raised' : 'hand_lowered', peerId: peer?.id });
  } else {
    hostConnection?.send({ type: localHandRaised ? 'raise_hand' : 'lower_hand' });
  }
});

// ── Chat ──────────────────────────────────────────
function _sendChat() {
  const text = chatInputEl?.value.trim();
  if (!text) return;
  chatInputEl.value = '';
  appendChatMessage(currentUsername, text);
  if (isHost) {
    _broadcastToGuests({ type: 'chat', senderName: currentUsername, text });
  } else {
    hostConnection?.send({ type: 'chat', text });
  }
}

sendBtnEl?.addEventListener('click', () => _sendChat());
chatInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); }
});

// ── Host action menu ──────────────────────────────
hostActionMenuEl?.addEventListener('click', (e) => {
  if (e.target === hostActionMenuEl) closeHostActionMenu();
});

hostActionMenuEl?.querySelector('.host-action-kick-btn')
  ?.addEventListener('click', () => {
    const targetPeerId = hostActionMenuTargetPeerId;
    closeHostActionMenu();
    if (targetPeerId) kickGuest(targetPeerId, 'Kicked by host.');
  });

hostActionMenuEl?.querySelector('.host-action-ban-btn')
  ?.addEventListener('click', () => {
    const targetPeerId = hostActionMenuTargetPeerId;
    closeHostActionMenu();
    if (targetPeerId) banGuest(targetPeerId);
  });

hostActionMenuEl?.querySelector('.host-action-mute-btn')
  ?.addEventListener('click', () => {
    const targetPeerId = hostActionMenuTargetPeerId;
    closeHostActionMenu();
    if (targetPeerId) forceMuteGuest(targetPeerId);
  });

hostActionMenuEl?.querySelector('.host-action-cam-btn')
  ?.addEventListener('click', () => {
    const targetPeerId = hostActionMenuTargetPeerId;
    closeHostActionMenu();
    if (targetPeerId) forceCamOffGuest(targetPeerId);
  });

// ═══════════════════════════════════════════════════
//  GLOBAL KEYBOARD SHORTCUTS
//
//  Only active when the main room screen (#app-screen) is visible.
//
//    M             — toggle mute        (blocked when a text input has focus)
//    V             — toggle camera      (blocked when a text input has focus)
//    H             — toggle raise hand  (blocked when a text input has focus)
//    Ctrl/⌘+Enter  — send chat message  (works from anywhere in the room)
//    Escape        — close the topmost visible panel (menu → participants → overlay)
// ═══════════════════════════════════════════════════

document.addEventListener('keydown', (keyboardEvent) => {
  // Only fire shortcuts when the room workspace is actually on screen.
  if (appScreenEl?.classList.contains('hidden')) return;

  const focusedElement     = document.activeElement;
  const focusedTagName     = focusedElement?.tagName?.toLowerCase() ?? '';
  const focusIsOnTextInput = focusedTagName === 'input' || focusedTagName === 'textarea';

  // Ctrl+Enter / Cmd+Enter — send chat from anywhere inside the room.
  if (keyboardEvent.key === 'Enter' && (keyboardEvent.ctrlKey || keyboardEvent.metaKey)) {
    keyboardEvent.preventDefault();
    _sendChat();
    return;
  }

  // Escape — close the topmost visible overlay or panel.
  if (keyboardEvent.key === 'Escape') {
    if (hostActionMenuEl && !hostActionMenuEl.classList.contains('hidden')) {
      closeHostActionMenu();
      return;
    }
    if (participantsPanelEl && !participantsPanelEl.classList.contains('hidden')) {
      participantsPanelEl.classList.add('hidden');
      return;
    }
    if (roomCodeOverlayEl && !roomCodeOverlayEl.classList.contains('hidden')) {
      roomCodeOverlayEl.classList.add('hidden');
      return;
    }
    return;
  }

  // Single-letter shortcuts must not fire when the user is typing.
  if (focusIsOnTextInput) return;

  switch (keyboardEvent.key.toLowerCase()) {
    case 'm':
      keyboardEvent.preventDefault();
      muteBtnEl?.click();
      break;
    case 'v':
      keyboardEvent.preventDefault();
      camBtnEl?.click();
      break;
    case 'h':
      keyboardEvent.preventDefault();
      raiseHandBtnEl?.click();
      break;
    case 'f':
      keyboardEvent.preventDefault();
      toggleFocusMode();
      break;
  }
});

// ═══════════════════════════════════════════════════
//  FEATURE STATE VARIABLES
// ═══════════════════════════════════════════════════

let isRoomLocked = false;
let soundEnabled = true;

// Timer state — host owns this; guests mirror via timer_sync.
let _timerMode       = 'stopwatch';  // 'stopwatch' | 'countdown'
let _timerRunning    = false;
let _timerElapsedMs  = 0;            // accumulated ms at last pause
let _timerStartedAt  = 0;            // Date.now() when last started
let _timerTargetMs   = 5 * 60_000;   // countdown only: total duration
let _timerIntervalId = null;

// Poll state — host owns; guests mirror via poll_start / poll_update.
let _activePoll = null;   // { question: string, options: string[], votes: number[] }
let _myPollVote = null;   // voted option index, or null




// ═══════════════════════════════════════════════════
//  SOUND NOTIFICATIONS  (Web Audio API synthesis)
// ═══════════════════════════════════════════════════

function _playSound(soundType) {
  if (!soundEnabled) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);

    const scheduleBeep = (frequency, startTime, duration, gainPeak) => {
      const oscillator = audioCtx.createOscillator();
      oscillator.connect(gainNode);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(gainPeak, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };

    const now = audioCtx.currentTime;
    switch (soundType) {
      case 'join':
        // Two ascending tones — welcome chime.
        scheduleBeep(523, now,        0.12, 0.25);
        scheduleBeep(659, now + 0.13, 0.14, 0.25);
        break;
      case 'leave':
        // Two descending tones — departure chime.
        scheduleBeep(659, now,        0.12, 0.20);
        scheduleBeep(523, now + 0.13, 0.15, 0.20);
        break;
      case 'chat':
        // Single soft high ping.
        scheduleBeep(880, now, 0.09, 0.18);
        break;
      case 'hand':
        // Two quick ascending tones — attention ping.
        scheduleBeep(740, now,        0.08, 0.22);
        scheduleBeep(880, now + 0.09, 0.10, 0.22);
        break;
    }
  } catch (_) {}
}

document.getElementById('sound-toggle-btn')?.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  const soundToggleBtnEl = document.getElementById('sound-toggle-btn');
  if (soundToggleBtnEl) {
    soundToggleBtnEl.title = soundEnabled ? 'Sound notifications on' : 'Sound notifications off';
    // .active class dims the icon to show muted state; SVG stays intact.
    soundToggleBtnEl.classList.toggle('active', !soundEnabled);
  }
});


// ═══════════════════════════════════════════════════
//  CHAT HISTORY  (sessionStorage persistence)
// ═══════════════════════════════════════════════════

const CHAT_HISTORY_MAX_MESSAGES = 200;

function _chatHistoryStorageKey() {
  // Keyed per room so histories don't bleed across rooms in the same tab session.
  return 'coterie_chat_' + (currentRoomId || hostPeerId || 'room');
}

function _saveChatMessage(senderName, text) {
  try {
    const storageKey   = _chatHistoryStorageKey();
    const savedHistory = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    savedHistory.push({ senderName, text });
    if (savedHistory.length > CHAT_HISTORY_MAX_MESSAGES) {
      savedHistory.splice(0, savedHistory.length - CHAT_HISTORY_MAX_MESSAGES);
    }
    sessionStorage.setItem(storageKey, JSON.stringify(savedHistory));
  } catch (_) {}
}

function _restoreChatHistory() {
  try {
    const storageKey   = _chatHistoryStorageKey();
    const savedHistory = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    if (savedHistory.length === 0) return;
    appendChatMessage('System', '— Chat history restored —', true);
    for (const { senderName, text } of savedHistory) {
      // skipHistory=true so we don't re-save what we just loaded.
      appendChatMessage(senderName, text, false, true);
    }
  } catch (_) {}
}


// ═══════════════════════════════════════════════════
//  ROOM LOCK
// ═══════════════════════════════════════════════════

document.getElementById('room-lock-btn')?.addEventListener('click', () => {
  isRoomLocked = !isRoomLocked;
  const lockBtnEl         = document.getElementById('room-lock-btn');
  const lockedIndicatorEl = document.getElementById('room-locked-indicator');
  // Toggle the locked visual state on the SVG button via class, not textContent.
  if (lockBtnEl)         lockBtnEl.classList.toggle('active', isRoomLocked);
  if (lockedIndicatorEl) lockedIndicatorEl.classList.toggle('hidden', !isRoomLocked);
  _broadcastToGuests({ type: 'room_lock_state', locked: isRoomLocked });
  showToast(isRoomLocked ? 'Room locked — new joiners blocked.' : 'Room unlocked.', 'info', 3000);
});


// ═══════════════════════════════════════════════════
//  ROOM TIMER / STOPWATCH
// ═══════════════════════════════════════════════════

function _timerCurrentDisplayMs() {
  if (!_timerRunning) return _timerElapsedMs;
  if (_timerMode === 'countdown') {
    return Math.max(0, _timerTargetMs - (_timerElapsedMs + (Date.now() - _timerStartedAt)));
  }
  return _timerElapsedMs + (Date.now() - _timerStartedAt);
}

function _formatMs(totalMs) {
  const totalSeconds = Math.floor(Math.max(0, totalMs) / 1000);
  const minutes      = Math.floor(totalSeconds / 60);
  const seconds      = totalSeconds % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function _updateTimerDisplay() {
  const timerTextEl    = document.getElementById('room-timer-text');
  const timerDisplayEl = document.getElementById('room-timer-display');
  if (!timerTextEl) return;

  const displayMs = _timerCurrentDisplayMs();
  timerTextEl.textContent = _formatMs(displayMs);

  const shouldShowDisplay = _timerRunning || _timerElapsedMs > 0;
  if (timerDisplayEl) timerDisplayEl.classList.toggle('hidden', !shouldShowDisplay);

  // Auto-stop countdown when it reaches zero.
  if (_timerMode === 'countdown' && _timerRunning && displayMs <= 0) {
    _timerRunning    = false;
    _timerElapsedMs  = _timerTargetMs;
    clearInterval(_timerIntervalId);
    _timerIntervalId = null;
    if (isHost) _broadcastTimerSync();
  }
}

function _startTimerTick() {
  clearInterval(_timerIntervalId);
  _timerIntervalId = setInterval(_updateTimerDisplay, 500);
  _updateTimerDisplay();
}

function _stopTimerTick() {
  clearInterval(_timerIntervalId);
  _timerIntervalId = null;
  _updateTimerDisplay();
}

function _broadcastTimerSync() {
  _broadcastToGuests({
    type:      'timer_sync',
    mode:      _timerMode,
    running:   _timerRunning,
    elapsedMs: _timerElapsedMs,
    targetMs:  _timerTargetMs,
    syncAt:    Date.now(),
  });
}

// Called on guests when timer_sync arrives.
function _applyTimerSync(syncData) {
  _timerMode     = syncData.mode      ?? 'stopwatch';
  _timerRunning  = syncData.running   ?? false;
  _timerTargetMs = syncData.targetMs  ?? 5 * 60_000;

  // Compensate for rough network latency so displayed value stays accurate.
  const networkLatencyMs = Math.max(0, Date.now() - (syncData.syncAt ?? Date.now()));
  _timerElapsedMs = syncData.elapsedMs ?? 0;
  _timerStartedAt = _timerRunning ? Date.now() - networkLatencyMs : 0;

  if (_timerRunning) {
    _startTimerTick();
  } else {
    _stopTimerTick();
  }
}

// Host-side: show/hide timer panel.
document.getElementById('timer-btn')?.addEventListener('click', () => {
  document.getElementById('timer-panel')?.classList.toggle('hidden');
});

document.getElementById('timer-close-btn')?.addEventListener('click', () => {
  document.getElementById('timer-panel')?.classList.add('hidden');
});

// Toggle countdown duration row when mode radio changes.
document.querySelectorAll('input[name="timer-mode"]').forEach((radioInput) => {
  radioInput.addEventListener('change', () => {
    document.getElementById('timer-duration-row')
      ?.classList.toggle('hidden', radioInput.value !== 'countdown');
  });
});

document.getElementById('timer-start-btn')?.addEventListener('click', () => {
  const selectedModeEl = document.querySelector('input[name="timer-mode"]:checked');
  _timerMode = selectedModeEl?.value ?? 'stopwatch';

  if (_timerMode === 'countdown') {
    const minutesInputEl = document.getElementById('timer-minutes-input');
    const inputMinutes   = parseInt(minutesInputEl?.value ?? '5', 10);
    const clampedMinutes = isNaN(inputMinutes) || inputMinutes < 1 ? 5 : inputMinutes;
    _timerTargetMs = clampedMinutes * 60_000;
    // If the countdown already finished, restart from full duration.
    if (_timerElapsedMs >= _timerTargetMs) _timerElapsedMs = 0;
  }

  _timerRunning   = true;
  _timerStartedAt = Date.now();
  _startTimerTick();
  _broadcastTimerSync();
});

document.getElementById('timer-stop-btn')?.addEventListener('click', () => {
  if (!_timerRunning) return;
  _timerElapsedMs += Date.now() - _timerStartedAt;
  _timerRunning    = false;
  _timerStartedAt  = 0;
  _stopTimerTick();
  _broadcastTimerSync();
});

document.getElementById('timer-reset-btn')?.addEventListener('click', () => {
  _timerRunning    = false;
  _timerElapsedMs  = 0;
  _timerStartedAt  = 0;
  clearInterval(_timerIntervalId);
  _timerIntervalId = null;
  document.getElementById('room-timer-display')?.classList.add('hidden');
  _broadcastTimerSync();
});


// ═══════════════════════════════════════════════════
//  QUICK POLLS
// ═══════════════════════════════════════════════════

// Host: open/close creation modal.
document.getElementById('poll-btn')?.addEventListener('click', () => {
  document.getElementById('poll-create-modal')?.classList.toggle('hidden');
});

document.getElementById('poll-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('poll-create-modal')?.classList.add('hidden');
  const pollErrorEl = document.getElementById('poll-create-error');
  if (pollErrorEl) pollErrorEl.textContent = '';
});

// Host: validate inputs and broadcast poll_start.
document.getElementById('poll-launch-btn')?.addEventListener('click', () => {
  const pollQuestion      = document.getElementById('poll-question-input')?.value.trim();
  const pollOptionInputs  = [...document.querySelectorAll('.poll-option-input')];
  const pollOptions       = pollOptionInputs.map((inputEl) => inputEl.value.trim()).filter(Boolean);
  const pollErrorEl       = document.getElementById('poll-create-error');

  if (!pollQuestion) {
    if (pollErrorEl) pollErrorEl.textContent = 'Enter a question.';
    return;
  }
  if (pollOptions.length < 2) {
    if (pollErrorEl) pollErrorEl.textContent = 'Add at least 2 options.';
    return;
  }

  _activePoll = {
    question: pollQuestion,
    options:  pollOptions,
    votes:    new Array(pollOptions.length).fill(0),
  };

  const pollStartMessage = { type: 'poll_start', question: pollQuestion, options: pollOptions };
  _broadcastToGuests(pollStartMessage);
  _receivePoll(pollStartMessage);  // Show on host side too.

  // Reset creation form.
  document.getElementById('poll-create-modal')?.classList.add('hidden');
  if (pollErrorEl) pollErrorEl.textContent = '';
  const pollQuestionInputEl = document.getElementById('poll-question-input');
  if (pollQuestionInputEl) pollQuestionInputEl.value = '';
  pollOptionInputs.forEach((inputEl) => { inputEl.value = ''; });
});

// Host: end poll.
document.getElementById('poll-end-btn')?.addEventListener('click', () => {
  _broadcastToGuests({ type: 'poll_end' });
  _closePollOverlay();
  _activePoll = null;
});

// Called on all clients when poll_start arrives (or host launches one).
function _receivePoll(pollData) {
  _myPollVote = null;

  const pollQuestionTextEl = document.getElementById('poll-question-text');
  const pollOptionsListEl  = document.getElementById('poll-options-list');
  const pollResultsListEl  = document.getElementById('poll-results-list');
  const pollVoteCountEl    = document.getElementById('poll-vote-count');
  const pollEndBtnEl       = document.getElementById('poll-end-btn');
  const pollOverlayEl      = document.getElementById('poll-overlay');

  if (pollQuestionTextEl) pollQuestionTextEl.textContent = pollData.question;
  if (pollVoteCountEl)    pollVoteCountEl.textContent    = '';
  if (pollResultsListEl)  pollResultsListEl.classList.add('hidden');
  // Only the host sees the End Poll button.
  if (pollEndBtnEl) pollEndBtnEl.classList.toggle('hidden', !isHost);

  if (pollOptionsListEl) {
    pollOptionsListEl.innerHTML = '';
    pollData.options.forEach((optionText, optionIndex) => {
      const optionBtnEl       = document.createElement('button');
      optionBtnEl.className   = 'poll-option-btn btn btn-sm btn-secondary';
      optionBtnEl.textContent = optionText;

      optionBtnEl.addEventListener('click', () => {
        if (_myPollVote !== null) return;   // Already voted.
        _myPollVote = optionIndex;
        pollOptionsListEl.querySelectorAll('.poll-option-btn')
          .forEach((btn) => btn.classList.remove('selected'));
        optionBtnEl.classList.add('selected');

        if (!isHost) {
          hostConnection?.send({ type: 'poll_vote', optionIndex });
        } else {
          // Host voting for themselves.
          _handlePollVote(optionIndex);
        }
      });

      pollOptionsListEl.appendChild(optionBtnEl);
    });
  }

  pollOverlayEl?.classList.remove('hidden');
}

// Called on all clients when poll_update arrives.
function _updatePollResults(voteCountsArray) {
  const pollResultsListEl = document.getElementById('poll-results-list');
  const pollVoteCountEl   = document.getElementById('poll-vote-count');
  if (!pollResultsListEl || !_activePoll) return;

  const totalVotes = voteCountsArray.reduce((sum, count) => sum + count, 0);
  if (pollVoteCountEl) {
    pollVoteCountEl.textContent = totalVotes + ' vote' + (totalVotes !== 1 ? 's' : '');
  }

  pollResultsListEl.innerHTML = '';
  pollResultsListEl.classList.remove('hidden');

  _activePoll.options.forEach((optionText, optionIndex) => {
    const voteCount   = voteCountsArray[optionIndex] ?? 0;
    const votePercent = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

    const resultRowEl = document.createElement('div');
    resultRowEl.className = 'poll-result-row';

    const labelEl = document.createElement('span');
    labelEl.className   = 'poll-result-label';
    labelEl.textContent = optionText;

    const barWrapEl = document.createElement('div');
    barWrapEl.className = 'poll-result-bar-wrap';
    const barFillEl = document.createElement('div');
    barFillEl.className = 'poll-result-bar';
    barFillEl.style.width = votePercent + '%';
    barWrapEl.appendChild(barFillEl);

    const pctEl = document.createElement('span');
    pctEl.className   = 'poll-result-pct';
    pctEl.textContent = votePercent + '%';

    resultRowEl.appendChild(labelEl);
    resultRowEl.appendChild(barWrapEl);
    resultRowEl.appendChild(pctEl);
    pollResultsListEl.appendChild(resultRowEl);
  });
}

function _closePollOverlay() {
  document.getElementById('poll-overlay')?.classList.add('hidden');
}

// Host receives a vote from a guest (wired in handleGuestConnection via poll_vote case).
function _handlePollVote(optionIndex) {
  if (!_activePoll || optionIndex < 0 || optionIndex >= _activePoll.options.length) return;
  _activePoll.votes[optionIndex]++;
  _updatePollResults(_activePoll.votes);
  _broadcastToGuests({ type: 'poll_update', votes: _activePoll.votes });
}


// ═══════════════════════════════════════════════════
//  BREAKOUT ROOMS
// ═══════════════════════════════════════════════════

document.getElementById('breakout-btn')?.addEventListener('click', () => {
  if (!isHost) return;
  _renderBreakoutAssignments();
  document.getElementById('breakout-panel')?.classList.toggle('hidden');
});

document.getElementById('breakout-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('breakout-panel')?.classList.add('hidden');
});

// Re-render preview whenever the group count selector changes.
document.getElementById('breakout-groups-select')?.addEventListener('change', _renderBreakoutAssignments);

function _renderBreakoutAssignments() {
  const breakoutAssignmentsEl = document.getElementById('breakout-assignments');
  if (!breakoutAssignmentsEl) return;

  const numGroups           = parseInt(document.getElementById('breakout-groups-select')?.value ?? '2', 10);
  const nonHostParticipants = connectedUsers.filter((user) => user.peerId !== peer?.id);
  const groups              = Array.from({ length: numGroups }, () => []);

  nonHostParticipants.forEach((user, userIndex) => {
    groups[userIndex % numGroups].push(user);
  });

  breakoutAssignmentsEl.innerHTML = '';
  groups.forEach((groupMembers, groupIndex) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'breakout-group';

    const groupLabelEl       = document.createElement('div');
    groupLabelEl.className   = 'breakout-group-label';
    groupLabelEl.textContent = 'Room ' + (groupIndex + 1);
    groupEl.appendChild(groupLabelEl);

    if (groupMembers.length === 0) {
      const emptyEl       = document.createElement('div');
      emptyEl.className   = 'breakout-group-empty';
      emptyEl.textContent = '(empty)';
      groupEl.appendChild(emptyEl);
    } else {
      groupMembers.forEach((groupMember) => {
        const memberEl       = document.createElement('div');
        memberEl.className   = 'breakout-member';
        memberEl.textContent = groupMember.username;
        groupEl.appendChild(memberEl);
      });
    }

    breakoutAssignmentsEl.appendChild(groupEl);
  });
}

document.getElementById('breakout-start-btn')?.addEventListener('click', () => {
  if (!isHost) return;

  const numGroups       = parseInt(document.getElementById('breakout-groups-select')?.value ?? '2', 10);
  const durationMinutes = parseInt(document.getElementById('breakout-duration-input')?.value ?? '0', 10);
  const endsAt          = (!isNaN(durationMinutes) && durationMinutes > 0)
    ? Date.now() + durationMinutes * 60_000
    : 0;

  const nonHostParticipants = connectedUsers.filter((user) => user.peerId !== peer?.id);
  const groups              = Array.from({ length: numGroups }, () => []);
  nonHostParticipants.forEach((user, userIndex) => {
    groups[userIndex % numGroups].push(user);
  });

  groups.forEach((groupMembers, groupIndex) => {
    if (groupMembers.length === 0) return;

    const breakoutRoomId          = 'bo-' + currentRoomId + '-' + groupIndex;
    const [firstMember, ...rest]  = groupMembers;

    // The first member in each group becomes the sub-room host.
    guestConnectionMap.get(firstMember.peerId)?.conn.send({
      type:          'break_out_create',
      mainRoomId:    currentRoomId,
      breakoutRoomId,
      endsAt:        endsAt || undefined,
    });

    // Remaining members join as guests of that sub-room.
    rest.forEach((remainingMember) => {
      guestConnectionMap.get(remainingMember.peerId)?.conn.send({
        type:          'break_out_join',
        mainRoomId:    currentRoomId,
        breakoutRoomId,
        endsAt:        endsAt || undefined,
      });
    });
  });

  document.getElementById('breakout-panel')?.classList.add('hidden');
  showToast('Break-out rooms started!', 'info', 3000);
});

// Called by showAppScreen — shows return bar when rejoining from a breakout.
function _checkBreakoutReturnBar() {
  const mainRoomId  = sessionStorage.getItem('coterie_breakout_main_room');
  const returnBarEl = document.getElementById('breakout-return-bar');
  const returnBtnEl = document.getElementById('breakout-return-btn');

  if (!mainRoomId || !returnBarEl) return;
  returnBarEl.classList.remove('hidden');

  // If a timed breakout, show a live countdown.
  const endsAtStr = sessionStorage.getItem('coterie_breakout_ends_at');
  const endsAt    = endsAtStr ? parseInt(endsAtStr, 10) : 0;

  if (endsAt > 0) {
    const countdownDisplayEl = document.getElementById('breakout-countdown-display');

    const updateBreakoutCountdown = () => {
      const remainingMs = Math.max(0, endsAt - Date.now());
      if (countdownDisplayEl) countdownDisplayEl.textContent = _formatMs(remainingMs);
      if (remainingMs <= 0) returnBtnEl?.click();
    };

    updateBreakoutCountdown();
    setInterval(updateBreakoutCountdown, 1000);
  }

  returnBtnEl?.addEventListener('click', () => {
    sessionStorage.removeItem('coterie_breakout_main_room');
    sessionStorage.removeItem('coterie_breakout_ends_at');
    sessionStorage.setItem(STORAGE_KEY_PENDING_MOVE, mainRoomId);
    location.reload();
  });
}


// ═══════════════════════════════════════════════════
//  PLATFORM BLOCK LIST
//
//  The registry holder keeps a Set of permanently banned userNumbers.
//  When a guest sends user_info, the host checks this list and refuses
//  entry with a 'platform_ban' kick reason.
//
//  Synced from the registry via query_rooms responses.
// ═══════════════════════════════════════════════════

const platformBlockedUserNumbers = new Set();

// Expose setter so the registry holder can merge updates on behalf of itself.
function _syncPlatformBlockedNumbers(numbersArray) {
  for (const number of (numbersArray ?? [])) {
    platformBlockedUserNumbers.add(String(number));
  }
}

// Called by handleRegistryMessage (holder path) and fetchActiveServers (client path).
// Exported for dev.js to call when it bans a userNumber.
function platformBanUserNumber(userNumber) {
  platformBlockedUserNumbers.add(String(userNumber));
}

function platformClearAllBans() {
  platformBlockedUserNumbers.clear();
}

// Patch handleGuestConnection's user_info case to reject platform-banned numbers.
// (Done here via monkey-patching the existing user_info block in handleGuestConnection
// via the platform check in rooms.js so we don't re-paste the full function.)
//
// This is enforced inline by adding a check at the top of the user_info case;
// the actual implementation is in the patched handleGuestConnection below.
// We override the global so the reference used by peer.on('connection', ...) picks it up.
const _originalHandleGuestConnection = handleGuestConnection;
window._handleGuestConnectionWithPlatformCheck = function (conn) {
  // Intercept user_info to inject platform-ban check before the original logic.
  const wrappedConn = new Proxy(conn, {
    get(target, prop) {
      if (prop !== 'on') return target[prop];
      return function (event, handler) {
        if (event !== 'data') return target.on(event, handler);
        return target.on('data', (data) => {
          if (data?.type === 'user_info') {
            const incomingUserNumber = String(data.userNumber ?? '');
            if (incomingUserNumber && platformBlockedUserNumbers.has(incomingUserNumber)) {
              conn.send({ type: 'kicked', reason: 'You are banned from this platform.' });
              conn.close();
              return;
            }
          }
          handler(data);
        });
      };
    },
  });
  _originalHandleGuestConnection(wrappedConn);
};

// Patch handleRegistryMessage to handle platform ban/unban messages.
const _originalHandleRegistryMessage = handleRegistryMessage;
function handleRegistryMessage(conn, msg) {
  if (msg?.type === 'platform_ban') {
    if (msg.userNumber) platformBanUserNumber(msg.userNumber);
    return;
  }
  if (msg?.type === 'platform_unban_all') {
    platformClearAllBans();
    return;
  }
  // Augment query_rooms response to include blocked numbers.
  if (msg?.type === 'query_rooms' && conn) {
    // After the original processes query_rooms and sends rooms_list, we also
    // need to include blockedUserNumbers. We accomplish this by intercepting
    // the conn.send inside the original via a temporary override.
    const originalSend = conn.send.bind(conn);
    conn.send = (responseMsg) => {
      if (responseMsg?.type === 'rooms_list') {
        responseMsg.blockedUserNumbers = [...platformBlockedUserNumbers];
      }
      originalSend(responseMsg);
      conn.send = originalSend;  // restore immediately after one use
    };
  }
  _originalHandleRegistryMessage(conn, msg);
}

// Patch fetchActiveServers to extract and apply blocked numbers from response.
const _originalFetchActiveServers = fetchActiveServers;
async function fetchActiveServers() {
  // Holder fast-path already covered by query_rooms augmentation above.
  if (registryHolderPeer) return _originalFetchActiveServers();

  // For non-holders, we intercept the rooms_list response from the registry.
  // We can't easily patch the Promise-based flow, so we apply a different approach:
  // Re-implement the non-holder path here with blocked number extraction.
  const queryPeer = createPeer();

  const peerOpened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4_000);
    queryPeer.once('open',  () => { clearTimeout(timer); resolve(true);  });
    queryPeer.once('error', () => { clearTimeout(timer); resolve(false); });
  });

  if (!peerOpened) {
    try { queryPeer.destroy(); } catch (_) {}
    return [];
  }

  const conn = queryPeer.connect(REGISTRY_PEER_ID, { reliable: true });

  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), REGISTRY_QUERY_TIMEOUT);
    conn.once('open', () => conn.send({ type: 'query_rooms' }));
    conn.once('data', (msg) => { clearTimeout(timer); resolve(msg); });
    conn.once('error', () => { clearTimeout(timer); resolve(null); });
    conn.once('close', () => { clearTimeout(timer); resolve(null); });
  });

  try { queryPeer.destroy(); } catch (_) {}

  if (!response) return [];

  // Sync blocked user numbers received from the registry holder.
  if (Array.isArray(response.blockedUserNumbers)) {
    _syncPlatformBlockedNumbers(response.blockedUserNumbers);
  }

  return Array.isArray(response?.rooms) ? response.rooms : [];
}


// ═══════════════════════════════════════════════════
//  ROOM TRANSFER
//
//  Host explicitly hands ownership to a guest.
//  Flow:
//    1. Host calls transferRoomToGuest(peerId).
//    2. Host sends { type: 'become_host' } to the elected guest with room config.
//    3. Host destroys its peer after a short delay, freeing the room's PeerJS ID.
//    4. Guest receives become_host, stores config in sessionStorage, reloads.
//    5. On reload, main.js detects 'coterie_transfer_host' in sessionStorage,
//       sets currentRoomName/Password/MaxSize, and calls createRoom(roomId)
//       to claim the now-freed ID.
//    6. Remaining guests see the host disconnect; the existing failover
//       mechanism reconnects them to the new host automatically.
// ═══════════════════════════════════════════════════

const STORAGE_KEY_TRANSFER_HOST = 'coterie_transfer_host';

function transferRoomToGuest(targetPeerId) {
  const targetUsername = guestConnectionMap.get(targetPeerId)?.username ?? 'this participant';
  if (!confirm(`Make "${targetUsername}" the new host of this room?\n\nYou will leave the room. Other participants will reconnect to the new host automatically.`)) {
    return;
  }

  // Send all room config to the elected guest so they can recreate the room identically.
  guestConnectionMap.get(targetPeerId)?.conn.send({
    type:        'become_host',
    roomId:      currentRoomId,
    roomName:    currentRoomName,
    roomPassword: currentRoomPassword,
    roomMaxSize: currentRoomMaxSize,
  });

  appendChatMessage('System', `Transferring host to ${targetUsername}…`, true);

  // Destroy our peer after a brief delay so the guest can receive the message
  // before the connection drops, and the PeerJS ID becomes available again.
  setTimeout(() => {
    _unregisterRoomFromRegistry();
    peer?.destroy();
    peer = null;
    // Navigate back to the lobby without triggering the normal leaveRoom cleanup,
    // since we already destroyed the peer.
    isHost             = false;
    currentRoomId      = '';
    currentRoomName    = '';
    currentRoomPassword = '';
    currentRoomMaxSize = 0;
    hostPeerId         = '';
    connectedUsers     = [];
    if (videoGridEl) videoGridEl.innerHTML = '';
    clearRoomFromUrl();
    document.title = 'Coterie';
    appScreenEl?.classList.add('hidden');
    roomBrowserScreenEl?.classList.remove('hidden');
    if (rbCreateBtnEl) rbCreateBtnEl.disabled = false;
    setLobbyStatus('Host transferred. You have left the room.');
    refreshRoomBrowser?.();
  }, 600);
}

// Wire the "Make Host" action menu button.
hostActionMenuEl?.querySelector('.host-action-transfer-btn')?.addEventListener('click', () => {
  const targetPeerId = hostActionMenuTargetPeerId;
  closeHostActionMenu();
  if (targetPeerId) transferRoomToGuest(targetPeerId);
});

// ── Guest side: handle become_host ───────────────
// Injected into _handleHostMessage via the new case below.
// We patch _handleHostMessage by wrapping it.
const _originalHandleHostMessage = _handleHostMessage;
function _handleHostMessage(data) {
  if (data?.type === 'become_host') {
    // Store the transferred room config so main.js can pick it up on reload.
    const transferData = {
      roomId:      data.roomId      ?? '',
      roomName:    data.roomName    ?? '',
      roomPassword: data.roomPassword ?? '',
      roomMaxSize: data.roomMaxSize ?? 0,
    };
    sessionStorage.setItem(STORAGE_KEY_TRANSFER_HOST, JSON.stringify(transferData));
    showToast('You are now the host! Reloading…', 'info', 3000);
    setTimeout(() => location.reload(), 1_200);
    return;
  }
  _originalHandleHostMessage(data);
}

// On startup, check for a pending host transfer and create the room.
// This runs synchronously after all the module-level code has executed,
// so createRoom() and all DOM refs are available.
(function _resumeHostTransferIfPending() {
  const raw = sessionStorage.getItem(STORAGE_KEY_TRANSFER_HOST);
  if (!raw) return;

  let transferData;
  try { transferData = JSON.parse(raw); } catch (_) { return; }
  sessionStorage.removeItem(STORAGE_KEY_TRANSFER_HOST);

  const savedName = localStorage.getItem('coterie_username') ?? '';
  if (!savedName) return;  // need a screen name

  // Apply the transferred room config to the global state variables.
  currentRoomName     = transferData.roomName    ?? '';
  currentRoomPassword = transferData.roomPassword ?? '';
  currentRoomMaxSize  = transferData.roomMaxSize  ?? 0;
  currentUsername     = savedName;
  isHost              = true;

  // Hide all lobby screens and show a loading state.
  [usernameScreenEl, homeScreenEl, lobbyScreenEl, roomBrowserScreenEl]
    .forEach((el) => el?.classList.add('hidden'));
  setLobbyStatus('Claiming host role…');

  // Create the room using the transferred room ID so the URL stays the same.
  createRoom(transferData.roomId || undefined);
})();

// ── URL-based auto-join for returning users ───────────────────────────────────
//
// When a returning user (saved username) opens a ?room= link, main.js cannot
// call startJoinRoom() directly because main.js runs before rooms.js.  It
// stores the room ID in sessionStorage under 'coterie_url_room_direct'; we
// pick it up here, where startJoinRoom IS already defined.
(function _resumeUrlRoomIfPending() {
  const directRoomId = sessionStorage.getItem('coterie_url_room_direct');
  if (!directRoomId) return;
  sessionStorage.removeItem('coterie_url_room_direct');

  // screenName was set by main.js's IIFE; fall back to localStorage if needed.
  if (!screenName) {
    screenName = localStorage.getItem('coterie_username') ?? '';
  }
  if (!screenName) return;

  startJoinRoom(directRoomId);
})();


// ═══════════════════════════════════════════════════
//  WATCH TOGETHER (YouTube IFrame API)
//
//  Host: opens a URL modal → loads a YouTube video → controls play/pause/seek.
//  All participants (incl. host) see the same video panel, synced via data channel.
//
//  Message protocol:
//    { type: 'yt_load',  videoId, startTime }   — load new video
//    { type: 'yt_play',  currentTime }           — play at given time
//    { type: 'yt_pause', currentTime }           — pause at given time
//    { type: 'yt_seek',  currentTime }           — seek without play/pause toggle
//    { type: 'yt_stop' }                         — hide panel
// ═══════════════════════════════════════════════════

let ytPlayer          = null;   // YouTube IFrame Player instance
let ytSeekBarInterval = null;   // timer that updates the seek bar for the host
let ytIgnoreStateChange = false; // suppress echoed state-change events

// ── Extract video ID from any standard YouTube URL ──────────────────────────
function _parseYouTubeVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    // Standard watch: https://youtube.com/watch?v=ID
    if (url.searchParams.has('v')) return url.searchParams.get('v');
    // Short URL: https://youtu.be/ID
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
    // Embedded: https://youtube.com/embed/ID
    const embedMatch = url.pathname.match(/^\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
  } catch (_) {}
  return null;
}

// ── Format seconds → "m:ss" ─────────────────────────────────────────────────
function _ytFormatTime(totalSeconds) {
  const clampedSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes        = Math.floor(clampedSeconds / 60);
  const seconds        = clampedSeconds % 60;
  return minutes + ':' + String(seconds).padStart(2, '0');
}

// ── Lazily load the YouTube IFrame Player API ────────────────────────────────
function _loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = resolve;
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const scriptEl = document.createElement('script');
      scriptEl.src   = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(scriptEl);
    }
  });
}

// ── Open the watch-together panel with a specific video ──────────────────────
async function _openWatchTogetherPanel(videoId, startTimeSeconds = 0) {
  const panelEl       = document.getElementById('watch-together-panel');
  const containerEl   = document.getElementById('yt-iframe-container');
  const hostControlEl = document.getElementById('yt-host-controls');
  const guestNoteEl   = document.getElementById('yt-guest-note');
  const changeBtnEl   = document.getElementById('yt-change-btn');

  if (!panelEl || !containerEl) return;

  await _loadYouTubeAPI();

  // Destroy any existing player before creating a new one.
  if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
  if (ytSeekBarInterval) { clearInterval(ytSeekBarInterval); ytSeekBarInterval = null; }

  containerEl.innerHTML = '';
  const playerDivEl    = document.createElement('div');
  playerDivEl.id       = 'yt-player-div';
  containerEl.appendChild(playerDivEl);

  const playerVars = {
    autoplay:       1,
    start:          Math.floor(startTimeSeconds),
    controls:       isHost ? 1 : 0,   // guests see no native controls (host controls for them)
    rel:            0,
    modestbranding: 1,
  };

  ytPlayer = new window.YT.Player('yt-player-div', {
    width:    '100%',
    height:   '100%',
    videoId,
    playerVars,
    events: {
      onReady: (event) => {
        event.target.seekTo(startTimeSeconds, true);
        if (isHost) event.target.playVideo();
      },
      onStateChange: (event) => {
        if (ytIgnoreStateChange) return;
        if (!isHost) return;  // guests can't control playback
        const currentTime = ytPlayer?.getCurrentTime() ?? 0;
        if (event.data === window.YT.PlayerState.PLAYING) {
          _broadcastYtEvent({ type: 'yt_play', currentTime });
        } else if (event.data === window.YT.PlayerState.PAUSED) {
          _broadcastYtEvent({ type: 'yt_pause', currentTime });
        }
      },
    },
  });

  // Show/hide host vs guest controls.
  if (hostControlEl) hostControlEl.classList.toggle('hidden', !isHost);
  if (guestNoteEl)   guestNoteEl.classList.toggle('hidden', isHost);
  if (changeBtnEl)   changeBtnEl.classList.toggle('hidden', !isHost);

  panelEl.classList.remove('hidden');

  // Host: update the seek bar every second.
  if (isHost) {
    const seekBarEl   = document.getElementById('yt-seek-bar');
    const timeLabelEl = document.getElementById('yt-time-label');

    ytSeekBarInterval = setInterval(() => {
      if (!ytPlayer?.getDuration) return;
      const duration    = ytPlayer.getDuration() || 0;
      const currentTime = ytPlayer.getCurrentTime() || 0;
      if (seekBarEl && duration > 0) {
        seekBarEl.max   = duration;
        seekBarEl.value = currentTime;
      }
      if (timeLabelEl) {
        timeLabelEl.textContent = _ytFormatTime(currentTime) + ' / ' + _ytFormatTime(duration);
      }
    }, 1_000);
  }
}

function _closeWatchTogetherPanel() {
  if (ytPlayer) { try { ytPlayer.stopVideo(); ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
  if (ytSeekBarInterval) { clearInterval(ytSeekBarInterval); ytSeekBarInterval = null; }
  document.getElementById('watch-together-panel')?.classList.add('hidden');
  document.getElementById('yt-iframe-container').innerHTML = '';
}

// ── Host: broadcast a YT control message to all guests ──────────────────────
function _broadcastYtEvent(message) {
  if (isHost) {
    _broadcastToGuests(message);
  } else {
    hostConnection?.send(message);
  }
}

// ── Apply a received YT sync command (guests only, or re-apply on host) ──────
function _applyYtSync(data) {
  if (!ytPlayer) return;
  ytIgnoreStateChange = true;
  switch (data.type) {
    case 'yt_play':
      ytPlayer.seekTo(data.currentTime ?? 0, true);
      ytPlayer.playVideo();
      break;
    case 'yt_pause':
      ytPlayer.seekTo(data.currentTime ?? 0, true);
      ytPlayer.pauseVideo();
      break;
    case 'yt_seek':
      ytPlayer.seekTo(data.currentTime ?? 0, true);
      break;
    case 'yt_stop':
      _closeWatchTogetherPanel();
      break;
  }
  setTimeout(() => { ytIgnoreStateChange = false; }, 300);
}

// ── Host: wire the Watch Together button in chat controls ───────────────────
document.getElementById('watch-together-btn')?.addEventListener('click', () => {
  if (!isHost) return;
  document.getElementById('yt-modal')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('yt-url-input')?.focus(), 50);
});

// ── YT URL modal ─────────────────────────────────────────────────────────────
document.getElementById('yt-modal-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('yt-modal')?.classList.add('hidden');
});

document.getElementById('yt-modal-start-btn')?.addEventListener('click', async () => {
  const rawUrl    = document.getElementById('yt-url-input')?.value ?? '';
  const videoId   = _parseYouTubeVideoId(rawUrl);
  const errorEl   = document.getElementById('yt-url-error');

  if (!videoId) {
    if (errorEl) errorEl.textContent = 'Could not find a YouTube video ID in that URL.';
    return;
  }
  if (errorEl) errorEl.textContent = '';
  document.getElementById('yt-modal')?.classList.add('hidden');

  // Notify all guests to open the panel.
  _broadcastToGuests({ type: 'yt_load', videoId, startTime: 0 });

  // Open locally for the host.
  await _openWatchTogetherPanel(videoId, 0);
});

document.getElementById('yt-url-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  document.getElementById('yt-modal-start-btn')?.click();
  if (e.key === 'Escape') document.getElementById('yt-modal')?.classList.add('hidden');
});

document.getElementById('yt-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('yt-modal')) {
    document.getElementById('yt-modal')?.classList.add('hidden');
  }
});

// ── Watch Together panel controls ────────────────────────────────────────────
document.getElementById('watch-together-close-btn')?.addEventListener('click', () => {
  if (isHost) {
    // Tell everyone to close their panels.
    _broadcastToGuests({ type: 'yt_stop' });
  }
  _closeWatchTogetherPanel();
});

document.getElementById('yt-change-btn')?.addEventListener('click', () => {
  if (!isHost) return;
  document.getElementById('yt-url-input').value = '';
  document.getElementById('yt-url-error').textContent = '';
  document.getElementById('yt-modal')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('yt-url-input')?.focus(), 50);
});

document.getElementById('yt-play-btn')?.addEventListener('click', () => {
  if (!isHost || !ytPlayer) return;
  const currentTime = ytPlayer.getCurrentTime() ?? 0;
  ytPlayer.playVideo();
  _broadcastYtEvent({ type: 'yt_play', currentTime });
});

document.getElementById('yt-pause-btn')?.addEventListener('click', () => {
  if (!isHost || !ytPlayer) return;
  const currentTime = ytPlayer.getCurrentTime() ?? 0;
  ytPlayer.pauseVideo();
  _broadcastYtEvent({ type: 'yt_pause', currentTime });
});

document.getElementById('yt-seek-bar')?.addEventListener('input', () => {
  if (!isHost || !ytPlayer) return;
  const seekTime = parseFloat(document.getElementById('yt-seek-bar').value);
  ytPlayer.seekTo(seekTime, true);
  _broadcastYtEvent({ type: 'yt_seek', currentTime: seekTime });
});

// ── Add yt_load / yt_* handling to handleGuestConnection ─────────────────────
// Injected via the handleGuestConnection data handler.
// We extend the existing switch by patching the message handler.
// Since we can't re-open the existing switch, we rely on the 'yt_' prefix being
// unrecognised by the existing switch and falling through — then catching it here.
// We patch by extending the conn.on('data') via a wrapper registered AFTER the existing one.
const _patchGuestConnectionForYT = (conn) => {
  conn.on('data', (data) => {
    if (!data?.type?.startsWith('yt_')) return;
    switch (data.type) {
      case 'yt_load':
        _openWatchTogetherPanel(data.videoId, data.startTime ?? 0);
        break;
      case 'yt_play':
      case 'yt_pause':
      case 'yt_seek':
      case 'yt_stop':
        _applyYtSync(data);
        break;
    }
    // Forward to all other guests (host relays).
    if (isHost) _broadcastToGuests(data, conn.peer);
  });
};

// Override handleGuestConnection to also wire the YT data handler.
const _originalHandleGuestConnectionForYT = handleGuestConnection;
function handleGuestConnection(conn) {
  _originalHandleGuestConnectionForYT(conn);
  _patchGuestConnectionForYT(conn);
}

// ── Guest: handle yt_* messages from host ────────────────────────────────────
// Injected into _handleHostMessage by extending the switch with a check.
const _originalHandleHostMessageForYT = _handleHostMessage;
function _handleHostMessage(data) {
  if (data?.type?.startsWith('yt_')) {
    switch (data.type) {
      case 'yt_load':
        _openWatchTogetherPanel(data.videoId, data.startTime ?? 0);
        return;
      case 'yt_play':
      case 'yt_pause':
      case 'yt_seek':
      case 'yt_stop':
        _applyYtSync(data);
        return;
    }
  }
  _originalHandleHostMessageForYT(data);
}


// ═══════════════════════════════════════════════════
//  FOCUS MODE
//
//  Collapses the chat pane and participant panel so video tiles fill the
//  full workspace. Toggled by the ⛶ toolbar button or the F key.
// ═══════════════════════════════════════════════════

let isFocusMode = false;

function toggleFocusMode() {
  isFocusMode = !isFocusMode;
  appScreenEl?.classList.toggle('focus-mode', isFocusMode);

  const focusBtnEl = document.getElementById('focus-mode-btn');
  if (focusBtnEl) {
    focusBtnEl.classList.toggle('active', isFocusMode);
    focusBtnEl.title = isFocusMode ? 'Exit focus mode (F)' : 'Focus mode — hide chat (F)';
  }

  // Auto-close the participants panel when entering focus mode.
  if (isFocusMode) {
    participantsPanelEl?.classList.add('hidden');
  }
}

document.getElementById('focus-mode-btn')?.addEventListener('click', () => toggleFocusMode());


// ═══════════════════════════════════════════════════
//  RECONNECT OVERLAY
//
//  When a guest's connection to the host drops unexpectedly,
//  we show a full-screen overlay with a single ↺ Reconnect button
//  instead of forcing a page reload.
//
//  Reconnect flow:
//    1. Destroy the broken peer.
//    2. Close all media calls (video tiles clear automatically).
//    3. Re-acquire media if it was stopped.
//    4. Call joinRoom(hostPeerId) — same room ID, fresh peer.
//    5. On success, hide the overlay; on failure, show an error.
// ═══════════════════════════════════════════════════

const RICKROLL_VIDEO_ID = 'dQw4w9WgXcQ';

function _showReconnectOverlay() {
  const overlayEl = document.getElementById('reconnect-overlay');
  const statusEl  = document.getElementById('reconnect-status');
  if (!overlayEl) return;
  if (statusEl) statusEl.textContent = '';
  overlayEl.classList.remove('hidden');
}

function _hideReconnectOverlay() {
  document.getElementById('reconnect-overlay')?.classList.add('hidden');
}

async function _attemptReconnect() {
  const reconnectBtnEl = document.getElementById('reconnect-btn');
  const statusEl       = document.getElementById('reconnect-status');

  if (reconnectBtnEl) { reconnectBtnEl.disabled = true; reconnectBtnEl.textContent = 'Reconnecting…'; }
  if (statusEl) statusEl.textContent = '';

  // Tear down any broken state from the previous connection.
  try { hostConnection?.close(); } catch (_) {}
  hostConnection = null;
  try { peer?.destroy(); } catch (_) {}
  peer = null;

  // Close stale media calls and clear video tiles (except local).
  for (const call of mediaCallMap.values()) { try { call.close(); } catch (_) {} }
  mediaCallMap.clear();
  videoGridEl?.querySelectorAll('.video-tile:not([data-peer-id="local"])')
    .forEach((tile) => tile.remove());

  // Re-acquire local media if it was released.
  if (!localStream) {
    await acquireLocalMedia();
  }

  // Reconnect to the same room ID.
  const targetRoomId = hostPeerId;
  if (!targetRoomId) {
    if (statusEl) statusEl.textContent = 'No room ID — cannot reconnect.';
    if (reconnectBtnEl) { reconnectBtnEl.disabled = false; reconnectBtnEl.textContent = '↺ Reconnect'; }
    return;
  }

  setConnectionStatus('connecting');
  if (statusEl) statusEl.textContent = 'Connecting…';

  await joinRoom(targetRoomId);

  // joinRoom sets up hostConnection; success is indicated by a 'user_list'
  // message arriving and showAppScreen() being called. We wait briefly to see
  // if the peer opened. If it did, the overlay will be hidden via the user_list
  // handler below.
  const peerOpened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8_000);
    const checkInterval = setInterval(() => {
      if (peer && !peer.destroyed) {
        clearTimeout(timer);
        clearInterval(checkInterval);
        resolve(true);
      }
    }, 200);
  });

  if (!peerOpened) {
    setConnectionStatus('disconnected');
    if (statusEl) statusEl.textContent = 'Could not reach the room. The host may have left.';
    if (reconnectBtnEl) { reconnectBtnEl.disabled = false; reconnectBtnEl.textContent = '↺ Try Again'; }
    return;
  }

  // Peer opened — the user_list handler in _handleHostMessage will call
  // showAppScreen() and we'll hide the overlay then.
  _hideReconnectOverlay();
  if (reconnectBtnEl) { reconnectBtnEl.disabled = false; reconnectBtnEl.textContent = '↺ Reconnect'; }
}

document.getElementById('reconnect-btn')?.addEventListener('click', () => _attemptReconnect());

document.getElementById('reconnect-leave-btn')?.addEventListener('click', () => {
  _hideReconnectOverlay();
  leaveRoom();
});

// Also hide the overlay if we successfully rejoin (user_list arrives and
// showAppScreen is called). We patch showAppScreen here.
const _originalShowAppScreen = showAppScreen;
function showAppScreen() {
  _hideReconnectOverlay();
  _originalShowAppScreen();
}


// ═══════════════════════════════════════════════════
//  HOST PRANKS (targeted — host → specific guest)
//
//  Message type: { type: 'host_prank', action: '...', ...extra }
//
//  Prank actions:
//    rickroll   — opens the Watch Together panel with Rick Astley's video
//    rename     — temporarily renames the target's display name for 30s
//    shake      — applies a CSS shake animation to the whole UI for 1.5s
//    tilt       — applies a CSS tilt animation to the whole UI for 8s
//
//  Flow:
//    Host → sends { type: 'host_prank', action } directly to one guest's conn
//    Guest → receives in _handleHostMessage → dispatches to _applyHostPrank
//    Host → also intercepts in handleGuestConnection via second data listener
//           so that the host can apply pranks to themselves if needed,
//           and the prank isn't forwarded to other guests.
// ═══════════════════════════════════════════════════

// ── Host side: send a prank to a specific guest ──────────────────────────────
function sendHostPrankToGuest(targetPeerId, action, extra = {}) {
  guestConnectionMap.get(targetPeerId)?.conn.send({
    type:   'host_prank',
    action,
    ...extra,
  });
}

// ── Guest side: apply a received prank ───────────────────────────────────────
function _applyHostPrank(action, data) {
  switch (action) {

    case 'rickroll':
      // Open Watch Together with Rick Astley whether or not the guest is the host.
      _openWatchTogetherPanel(RICKROLL_VIDEO_ID, 0);
      break;

    case 'shake':
      _applyBodyClass('prank-shake', 1_600);
      break;

    case 'tilt':
      _applyBodyClass('prank-tilt', 8_000);
      break;

    case 'rename': {
      const newPrankName    = (data.prankName ?? 'PoopyMcPoopface').slice(0, 30);
      const originalName    = currentUsername;
      currentUsername       = newPrankName;
      appendChatMessage('System', `Your name was temporarily changed to "${newPrankName}" 😈`, true);
      updateUsersBar();
      // Revert after 30s.
      setTimeout(() => {
        currentUsername = originalName;
        appendChatMessage('System', 'Your name has been restored.', true);
        updateUsersBar();
      }, 30_000);
      break;
    }
  }
}

// Temporarily adds a CSS class to document.body for a timed prank effect.
function _applyBodyClass(className, durationMs) {
  document.body.classList.add(className);
  setTimeout(() => document.body.classList.remove(className), durationMs);
}

// ── Wire prank handler into _handleHostMessage ────────────────────────────────
// (Using the existing wrap-and-delegate pattern already in this file)
const _originalHandleHostMessageForPranks = _handleHostMessage;
function _handleHostMessage(data) {
  if (data?.type === 'host_prank') {
    _applyHostPrank(data.action, data);
    return;
  }
  _originalHandleHostMessageForPranks(data);
}

// ── Host prank: rename — also updates host-side connectedUsers so everyone sees it ──
function prankRenameGuest(targetPeerId) {
  const currentName = guestConnectionMap.get(targetPeerId)?.username ?? '';
  const prankName   = prompt(`Temporarily rename "${currentName}" to:`, 'PoopyMcPoopface');
  if (!prankName?.trim()) return;

  const trimmedPrankName = prankName.trim().slice(0, 30);

  // Tell the target to rename themselves locally.
  sendHostPrankToGuest(targetPeerId, 'rename', { prankName: trimmedPrankName });

  // Also update the host-side user list so everyone in the room sees the rename.
  const userEntry = connectedUsers.find((u) => u.peerId === targetPeerId);
  if (userEntry) {
    const originalName = userEntry.username;
    userEntry.username = trimmedPrankName;
    if (guestConnectionMap.has(targetPeerId)) {
      guestConnectionMap.get(targetPeerId).username = trimmedPrankName;
    }
    _broadcastUserList();
    updateUsersBar();
    renderParticipantsList();

    // Revert after 30s on the host side too.
    setTimeout(() => {
      const stillConnected = connectedUsers.find((u) => u.peerId === targetPeerId);
      if (stillConnected) {
        stillConnected.username = originalName;
        if (guestConnectionMap.has(targetPeerId)) {
          guestConnectionMap.get(targetPeerId).username = originalName;
        }
        _broadcastUserList();
        updateUsersBar();
        renderParticipantsList();
      }
    }, 30_000);
  }
}

// ── Wire host action menu prank buttons ───────────────────────────────────────

hostActionMenuEl?.querySelector('.host-action-rickroll-btn')?.addEventListener('click', () => {
  const targetPeerId = hostActionMenuTargetPeerId;
  closeHostActionMenu();
  if (!targetPeerId) return;
  sendHostPrankToGuest(targetPeerId, 'rickroll');
  // Host also gets rickrolled 😈
  _openWatchTogetherPanel(RICKROLL_VIDEO_ID, 0);
});

hostActionMenuEl?.querySelector('.host-action-rename-btn')?.addEventListener('click', () => {
  const targetPeerId = hostActionMenuTargetPeerId;
  closeHostActionMenu();
  if (targetPeerId) prankRenameGuest(targetPeerId);
});

hostActionMenuEl?.querySelector('.host-action-shake-btn')?.addEventListener('click', () => {
  const targetPeerId = hostActionMenuTargetPeerId;
  closeHostActionMenu();
  if (targetPeerId) sendHostPrankToGuest(targetPeerId, 'shake');
});

hostActionMenuEl?.querySelector('.host-action-tilt-btn')?.addEventListener('click', () => {
  const targetPeerId = hostActionMenuTargetPeerId;
  closeHostActionMenu();
  if (targetPeerId) sendHostPrankToGuest(targetPeerId, 'tilt');
});
