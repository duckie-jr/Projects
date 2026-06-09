# DropIn

> Peer-to-peer video chat — no account needed.

DropIn lets you video call friends in a private room **or** get matched instantly with a random stranger. Everything runs directly in the browser using WebRTC (via PeerJS). No servers store your video or audio.

---

## Modes

### Rooms
Create a private video room and share the auto-generated Room ID with anyone you want to invite. Guests paste the ID to join.

| Feature | Details |
|---|---|
| **Video & Audio** | Toggle mic/camera at any time |
| **Screen Share** | Share your entire screen or a window |
| **Raise Hand** | Visual indicator visible to all participants |
| **Speaking Indicator** | Real-time audio-level detection highlights who is talking |
| **Live Chat** | Text chat sidebar within the room |
| **Participants Panel** | See everyone connected, with host/guest labels |
| **Host Controls** | Force-mute, force-cam-off, or ban any participant |
| **Copy Room ID** | One-click copy to clipboard |

### Random
Get matched with a stranger for a live 1-on-1 video call. Hit **Next** at any time to skip to someone new.

---

## Lobby — Recent Rooms & Import

The Rooms lobby persists your history locally (up to 20 rooms) so you can rejoin fast.

- **Recent Rooms panel** — click any room ID to pre-fill the join field; each entry shows a Host/Guest tag and a relative timestamp; delete individual rooms or clear all.
- **Export** — download your recent-rooms list as `dropin-recent-rooms.json`.
- **Import** — upload a `.json` file or paste a URL pointing to a JSON list of room IDs to bulk-add rooms to your history.

The file can be a plain array of ID strings, a full object array (the shape produced by **Export**), or a mix of both:

```json
[
  "abc-123-xyz",
  "def-456-uvw",
  { "id": "ghi-789-rst", "joinedAt": 1717200000000, "wasHost": true },
  { "id": "jkl-012-opq", "joinedAt": 1717100000000, "wasHost": false }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | The Room ID |
| `joinedAt` | number | ❌ | Unix timestamp (ms); defaults to import time |
| `wasHost` | boolean | ❌ | Shows Host/Guest tag; defaults to `false` |

A bare string (e.g. `"abc-123-xyz"`) is also valid — `joinedAt` and `wasHost` will be set to their defaults.

---

## Persistence

All state is stored in `localStorage` — nothing is sent to a server.

| Key | Contents |
|---|---|
| `dropin_username` | Your saved screen name |
| `dropin_recent_rooms` | Array of `{ id, joinedAt, wasHost }` objects |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Bundler | [Vite](https://vitejs.dev) |
| P2P / WebRTC | [PeerJS 1.5.4](https://peerjs.com) |
| Code editor (in-room) | [CodeMirror 5](https://codemirror.net) — Dracula theme |
| Language | Vanilla HTML · CSS · JavaScript |

---
