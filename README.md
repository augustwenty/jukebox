# Jukebox

A self-hosted office jukebox that lets everyone in the room queue songs from their phone or laptop. Music plays on your Roku TV via YouTube. No accounts, no subscriptions — just a shared URL and a queue.

---

## Features

- **YouTube search** — find any song without leaving the app
- **Shared real-time queue** — everyone sees the same queue, updated instantly
- **Voting** — upvote or downvote songs to influence playback order
- **Song ownership** — only the person who added a song can remove it
- **Play count tracking** — see how many times each song has been played
- **History tab** — browse past songs sorted by play count, re-add them to the queue
- **Loop mode** — finished songs cycle back to the bottom of the queue
- **Passcode-protected actions** — clear queue, settings, and history deletion require a PIN
- **Roku TV control** — play, pause, skip, and volume via Roku ECP
- **Auto-discovery** — scans your network to find the Roku and identify the YouTube channel ID
- **Persistent state** — queue, history, and play counts survive server restarts

---

## Requirements

- [Node.js](https://nodejs.org/) v16 or later
- A Roku TV with the YouTube app installed
- Everyone on the same local network

---

## Setup

**1. Install dependencies**

```bash
cd /Users/Shared/jukebox
npm install
```

**2. Configure your environment**

```bash
cp .env.example .env
```

Edit `.env` with your Roku's IP address:

```env
PORT=3000
ROKU_IP=192.168.1.xxx
ROKU_YOUTUBE_CHANNEL_ID=837
```

If you don't know your Roku IP or YouTube channel ID, leave them blank — the in-app settings panel can find them automatically (see [Roku Setup](#roku-setup) below).

**3. Start the server**

```bash
npm start
```

The server binds to `0.0.0.0:3000` so it's reachable from any device on your network.

**4. Open the app**

- On the host machine: `http://localhost:3000`
- From phones and other computers: `http://<your-machine-ip>:3000`

To find your machine's IP on macOS: `System Settings > Wi-Fi > Details`.

---

## Roku Setup

The app needs your Roku's IP address and the YouTube channel ID to control playback.

**Option A — Auto-discovery (recommended)**

1. Open the app and click the gear icon (requires passcode: `5665`)
2. Click **Scan network for Roku devices**
3. Select your TV from the list
4. The app scans installed channels and identifies YouTube automatically
5. Click **Save & Apply**

**Option B — Manual**

Find your Roku's IP at `Settings > Network > About` on the TV, then set `ROKU_IP` in `.env`. The YouTube channel ID is typically `837`.

> **Note:** Roku ECP must be enabled. Go to `Settings > System > Advanced system settings > External control > ECP` and set it to **Enabled** or **Limited**.

---

## How It Works

| Who | Can do |
|-----|--------|
| Anyone | Search, add songs, vote, view queue and history, control volume |
| Song owner | Remove their song from the queue, skip currently playing song |
| Admin (passcode) | Clear the entire queue, open settings, delete history entries |

**Queue order** is determined by net votes (upvotes minus downvotes), with oldest additions winning ties. The currently playing song is pinned at the top. When a song finishes, it loops back to the bottom of the queue.

**Double-clicking** the first song in the queue starts it immediately.

**Passcode** for all admin actions: `5665`

---

## Development

```bash
npm run dev   # starts with nodemon (auto-restarts on file changes)
```

**Key files:**

```
server.js          — Express + Socket.io server, queue logic, Roku ECP
discover.js        — Network scanner to find Roku devices and YouTube channel
public/
  index.html       — Main app UI
  app.js           — Client-side Socket.io, rendering, interactions
  style.css        — Dark theme styles
.env               — Roku IP, channel ID, port (not committed)
jukebox-state.json — Persisted queue, history, play counts (auto-generated)
```

**State persistence** is written to `jukebox-state.json` with a 2-second debounce on most changes, and immediately on queue clear. Delete this file to reset all history and play counts.

---

## Architecture

```
Browser clients  ──Socket.io──▶  Node.js server  ──HTTP──▶  Roku ECP (:8060)
      ▲                                │
      └────────── state broadcast ◀────┘
```

- **Socket.io** keeps all connected clients in sync in real time
- **yt-search** handles YouTube search without requiring an API key
- **Roku ECP** (External Control Protocol) launches YouTube with a specific video ID and controls volume/playback via HTTP POST to port 8060 on the Roku

---

## Troubleshooting

**Port 3000 already in use**
```bash
lsof -ti :3000 | xargs kill -9
```

**Roku not responding**
- Confirm ECP is enabled on the Roku (`Settings > System > Advanced system settings > External control`)
- Verify the IP hasn't changed (Roku IPs can shift — assign a static IP in your router for stability)
- Run auto-discovery from the settings panel to re-detect the correct IP and channel ID

**YouTube doesn't launch**
- Make sure the YouTube app is installed on the Roku
- Re-run auto-discovery to confirm the correct channel ID — the ID varies by region and TV model
