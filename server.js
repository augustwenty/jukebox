require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const yts = require('yt-search');
const path = require('path');
const fs = require('fs');
const { getLocalSubnets, scanForRoku, findInstalledChannels, identifyYouTube, updateEnv } = require('./discover');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ENV_PATH = path.join(__dirname, '.env');
const STATE_PATH = path.join(__dirname, 'jukebox-state.json');
const MAX_SAVED = 100;

// Mutable so discovery can update them at runtime without restart
let ROKU_IP = process.env.ROKU_IP || '';
let ROKU_YOUTUBE_ID = process.env.ROKU_YOUTUBE_CHANNEL_ID || '837';
let ROKU_BASE = ROKU_IP ? `http://${ROKU_IP}:8060` : null;

// --- Persistence ---
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const saved = JSON.parse(raw);
    return {
      queue: Array.isArray(saved.queue) ? saved.queue.slice(0, MAX_SAVED) : [],
      history: Array.isArray(saved.history) ? saved.history.slice(-MAX_SAVED) : [],
      playCounts: (saved.playCounts && typeof saved.playCounts === 'object') ? saved.playCounts : {},
    };
  } catch (_) {
    return { queue: [], history: [], playCounts: {} };
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {
      queue: queue.slice(0, MAX_SAVED),
      history: history.slice(-MAX_SAVED),
      playCounts,
    };
    fs.writeFile(STATE_PATH, JSON.stringify(data, null, 2), () => {});
  }, 2000);
}

// --- State ---
const saved = loadState();
let queue = saved.queue;
let history = saved.history;
let playCounts = saved.playCounts;
let currentSong = null;
let isPlaying = false;
let playStartTime = null;
let elapsedAtPause = 0;
let fallbackTimer = null;
let playerSocketId = null;

function getElapsed() {
  if (!currentSong) return 0;
  if (!isPlaying) return elapsedAtPause;
  return elapsedAtPause + (Date.now() - playStartTime) / 1000;
}

function netVotes(song) {
  return Object.values(song.votes || {}).reduce((s, v) => s + v, 0);
}

// Take the top-N items then shuffle them, so seeds stay relevant to taste
// but vary between clicks.
function shuffleTop(arr, n) {
  const top = arr.slice(0, n);
  for (let i = top.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [top[i], top[j]] = [top[j], top[i]];
  }
  return top;
}

function sortQueue() {
  queue.sort((a, b) => {
    const diff = netVotes(b) - netVotes(a);
    return diff !== 0 ? diff : a.addedAt - b.addedAt;
  });
}

function getState() {
  return {
    currentSong,
    queue: queue.map((s) => ({ ...s, netVotes: netVotes(s) })),
    history: history.slice(-20),
    isPlaying,
    playStartTime,
    elapsedAtPause,
    rokuConfigured: !!ROKU_BASE,
    rokuIp: ROKU_IP,
    rokuChannelId: ROKU_YOUTUBE_ID,
    playerConnected: !!playerSocketId,
    playCounts,
  };
}

function broadcastState() {
  scheduleSave();
  io.emit('state', getState());
}

// --- Roku ECP ---
async function rokuPost(path) {
  if (!ROKU_BASE) return;
  try {
    await axios.post(`${ROKU_BASE}${path}`, null, { timeout: 3000 });
  } catch (err) {
    console.warn(`Roku ECP [${path}]:`, err.message);
  }
}

async function rokuPlayVideo(videoId) {
  await rokuPost(`/launch/${ROKU_YOUTUBE_ID}?contentId=${videoId}`);
}

// --- Player page ---
function tellPlayer(event, data) {
  if (playerSocketId) io.to(playerSocketId).emit(event, data);
}

function armFallback(remainingSeconds) {
  clearTimeout(fallbackTimer);
  if (remainingSeconds > 0) {
    fallbackTimer = setTimeout(() => playNext('fallback'), (remainingSeconds + 4) * 1000);
  }
}

function clearFallback() { clearTimeout(fallbackTimer); }

// --- Queue logic ---
function playNext(reason) {
  clearFallback();

  if (currentSong) {
    history.push(currentSong);
    if (history.length > 50) history.shift();
    playCounts[currentSong.videoId] = (playCounts[currentSong.videoId] || 0) + 1;
    queue.push({ ...currentSong, votes: {}, addedAt: Date.now() });
  }

  if (queue.length === 0) {
    currentSong = null;
    isPlaying = false;
    playStartTime = null;
    elapsedAtPause = 0;
    tellPlayer('stop');
    broadcastState();
    return;
  }

  currentSong = queue.shift();
  isPlaying = true;
  playStartTime = Date.now();
  elapsedAtPause = 0;

  rokuPlayVideo(currentSong.videoId);
  tellPlayer('play', currentSong.videoId);
  armFallback(currentSong.duration);
  broadcastState();

  console.log(`[${reason || 'queue'}] Now playing: ${currentSong.title} — ${currentSong.addedBy}`);
}

// --- Socket.io ---
io.on('connection', (socket) => {

  // Player page
  socket.on('playerReady', () => {
    playerSocketId = socket.id;
    if (currentSong && isPlaying) socket.emit('play', currentSong.videoId);
    broadcastState();
  });

  socket.on('songEnded', () => {
    if (socket.id !== playerSocketId) return;
    clearFallback();
    playNext('ended');
  });

  socket.on('songError', () => {
    if (socket.id !== playerSocketId) return;
    clearFallback();
    playNext('error');
  });

  socket.on('playerElapsed', (seconds) => {
    if (socket.id !== playerSocketId) return;
    if (isPlaying && playStartTime) {
      elapsedAtPause = seconds;
      playStartTime = Date.now();
    }
  });

  // Regular clients
  socket.on('setName', (name) => {
    socket.data.name = String(name).trim().slice(0, 30) || 'Anonymous';
  });

  socket.on('search', async (query, callback) => {
    if (typeof query !== 'string' || !query.trim()) return callback('Empty query');
    try {
      const result = await yts(query.trim());
      const videos = result.videos.slice(0, 12).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.duration.seconds,
        durationStr: v.timestamp,
        author: v.author?.name || '',
      }));
      callback(null, videos);
    } catch (err) {
      console.error('Search error:', err.message);
      callback('Search failed — try again');
    }
  });

  socket.on('addToQueue', (song) => {
    if (!song || !song.videoId || !song.title) return;
    const alreadyQueued = queue.some((s) => s.videoId === song.videoId);
    const nowPlaying = currentSong?.videoId === song.videoId;
    if (alreadyQueued || nowPlaying) return socket.emit('queueError', 'That song is already in the queue.');
    const entry = {
      videoId: song.videoId,
      title: String(song.title).slice(0, 120),
      thumbnail: song.thumbnail || '',
      duration: Number(song.duration) || 0,
      durationStr: song.durationStr || '',
      author: String(song.author || '').slice(0, 80),
      addedBy: socket.data.name || 'Anonymous',
      addedByVoterId: String(song.voterId || ''),
      addedAt: Date.now(),
      votes: {},
    };

    if (!currentSong) {
      queue.push(entry);
      playNext('add');
    } else {
      queue.push(entry);
      broadcastState();
    }
  });

  // Auto DJ: fill the queue with songs similar to what's in the history.
  // "Similar" = a mix of new tracks by the artists in history (weighted by
  // play count) plus some well-loved high-play-count favorites. Only YouTube
  // search is available, so artists are the discovery seed.
  socket.on('fillSimilar', async (opts, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const count = Math.max(1, Math.min(20, Number(opts?.count) || 5));
    const voterId = String(opts?.voterId || '');

    if (!history.length) return cb('No history yet — play some songs first.');

    // videoIds we must not (re)add
    const inQueue = new Set(queue.map((s) => s.videoId));
    if (currentSong) inQueue.add(currentSong.videoId);

    // --- favorites: unique history songs by play count, not already queued ---
    const seenFav = new Set();
    const favorites = history
      .filter((s) => (seenFav.has(s.videoId) ? false : seenFav.add(s.videoId)))
      .filter((s) => !inQueue.has(s.videoId))
      .sort((a, b) => (playCounts[b.videoId] || 0) - (playCounts[a.videoId] || 0));

    // --- artist seeds: weighted by appearances + play count ---
    const weight = {};
    for (const s of history) {
      const a = (s.author || '').trim();
      if (!a) continue;
      weight[a] = (weight[a] || 0) + 1 + (playCounts[s.videoId] || 0);
    }
    const artists = shuffleTop(
      Object.keys(weight).sort((x, y) => weight[y] - weight[x]),
      8
    );

    // exclude already-known tracks from "new" discovery (we want fresh songs)
    const excludeNew = new Set(inQueue);
    for (const s of history) excludeNew.add(s.videoId);

    const newPicks = [];
    for (const artist of artists) {
      if (newPicks.length >= count) break;
      let videos = [];
      try {
        const r = await yts(artist);
        videos = r.videos || [];
      } catch (err) {
        console.warn('fillSimilar search failed:', artist, err.message);
      }
      for (const v of videos) {
        if (newPicks.length >= count) break;
        if (!v.videoId || excludeNew.has(v.videoId)) continue;
        const secs = v.duration?.seconds || 0;
        if (secs > 900) continue; // skip full albums / long live sets
        excludeNew.add(v.videoId);
        newPicks.push({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          duration: secs,
          durationStr: v.timestamp,
          author: v.author?.name || '',
        });
      }
    }

    // --- compose the batch: ~40% favorites, rest new, then backfill ---
    const favTarget = Math.min(Math.round(count * 0.4), favorites.length);
    const picks = [];
    const used = new Set();
    const take = (song) => {
      if (!song || used.has(song.videoId)) return;
      used.add(song.videoId);
      picks.push(song);
    };
    favorites.slice(0, favTarget).forEach(take);
    for (const v of newPicks) { if (picks.length >= count) break; take(v); }
    for (const f of favorites) { if (picks.length >= count) break; take(f); }

    // --- enqueue ---
    let added = 0;
    for (const p of picks) {
      if (added >= count) break;
      if (inQueue.has(p.videoId)) continue;
      inQueue.add(p.videoId);
      queue.push({
        videoId: p.videoId,
        title: String(p.title).slice(0, 120),
        thumbnail: p.thumbnail || '',
        duration: Number(p.duration) || 0,
        durationStr: p.durationStr || '',
        author: String(p.author || '').slice(0, 80),
        addedBy: 'Auto DJ',
        addedByVoterId: voterId,
        addedAt: Date.now() + added,
        votes: {},
      });
      added++;
    }

    if (added === 0) return cb('Couldn’t find new songs to add — try again.');

    if (!currentSong) {
      playNext('autofill');
    } else {
      broadcastState();
    }
    console.log(`[fillSimilar] added ${added} song(s)`);
    cb(null, { added });
  });

  // Voting: value 1 = upvote, -1 = downvote, 0 = remove vote
  socket.on('vote', ({ videoId, voterId, value }) => {
    if (!videoId || !voterId) return;
    const song = queue.find((s) => s.videoId === videoId && s.addedAt);
    if (!song) return;

    const current = song.votes[voterId];
    if (value === 0 || current === value) {
      delete song.votes[voterId];   // toggle off
    } else {
      song.votes[voterId] = value;  // set or flip
    }

    sortQueue();
    broadcastState();
  });

  socket.on('playNow', (index) => {
    if (index < 0 || index >= queue.length) return;
    const song = queue.splice(index, 1)[0];
    if (currentSong) queue.unshift(currentSong);
    clearFallback();
    currentSong = song;
    isPlaying = true;
    playStartTime = Date.now();
    elapsedAtPause = 0;
    rokuPlayVideo(song.videoId);
    tellPlayer('play', song.videoId);
    armFallback(song.duration);
    broadcastState();
    console.log(`[playNow] ${song.title}`);
  });

  socket.on('skip', () => {
    if (!currentSong) return;
    tellPlayer('skip');
    playNext('skip');
  });

  socket.on('togglePause', () => {
    if (!currentSong) return;
    if (isPlaying) {
      elapsedAtPause = getElapsed();
      clearFallback();
      isPlaying = false;
      playStartTime = null;
      tellPlayer('pause');
    } else {
      isPlaying = true;
      playStartTime = Date.now();
      armFallback(currentSong.duration - elapsedAtPause);
      tellPlayer('resume');
    }
    rokuPost('/keypress/Play');
    broadcastState();
  });

  socket.on('volumeUp', () => rokuPost('/keypress/VolumeUp'));
  socket.on('volumeDown', () => rokuPost('/keypress/VolumeDown'));
  socket.on('mute', () => rokuPost('/keypress/VolumeMute'));

  socket.on('removeCurrentSong', () => {
    if (!currentSong) return;
    clearFallback();
    currentSong = null;
    isPlaying = false;
    playStartTime = null;
    elapsedAtPause = 0;

    if (queue.length === 0) {
      tellPlayer('stop');
      broadcastState();
      return;
    }

    currentSong = queue.shift();
    isPlaying = true;
    playStartTime = Date.now();
    elapsedAtPause = 0;
    rokuPlayVideo(currentSong.videoId);
    tellPlayer('play', currentSong.videoId);
    armFallback(currentSong.duration);
    broadcastState();
    console.log(`[removeCurrent] Now playing: ${currentSong.title}`);
  });

  socket.on('removeFromQueue', (index) => {
    if (index >= 0 && index < queue.length) {
      queue.splice(index, 1);
      broadcastState();
    }
  });

  socket.on('clearQueue', () => {
    console.log('[clearQueue] fired — wiping queue and current song');
    queue = [];
    clearFallback();
    currentSong = null;
    isPlaying = false;
    playStartTime = null;
    elapsedAtPause = 0;
    tellPlayer('stop');
    // Save immediately so a restart doesn't restore old songs
    fs.writeFileSync(STATE_PATH, JSON.stringify({ queue: [], history: history.slice(-MAX_SAVED), playCounts }, null, 2));
    broadcastState();
  });

  socket.on('removeFromHistory', (videoId) => {
    history = history.filter((s) => s.videoId !== videoId);
    delete playCounts[videoId];
    broadcastState();
  });

  // --- Roku Discovery ---
  socket.on('startDiscovery', async () => {
    const emit = (data) => socket.emit('discoveryProgress', data);

    emit({ type: 'status', message: 'Scanning network for Roku devices…' });

    const subnets = getLocalSubnets();
    const allDevices = [];

    for (const subnet of subnets) {
      emit({ type: 'status', message: `Scanning ${subnet}.0/24…` });
      const devices = await scanForRoku(subnet, (e) => {
        emit({ type: 'device', device: e.device });
      });
      allDevices.push(...devices);
    }

    if (allDevices.length === 0) {
      return socket.emit('discoveryError', 'No Roku devices found on your network.');
    }

    socket.emit('discoveryDevices', allDevices);
  });

  socket.on('findYouTube', async (rokuIp) => {
    const emit = (data) => socket.emit('discoveryProgress', data);

    emit({ type: 'status', message: `Finding installed channels on ${rokuIp}…` });

    const channelIds = await findInstalledChannels(rokuIp, ({ start, end }) => {
      emit({ type: 'status', message: `Scanning channel IDs ${start}–${end}…` });
    });

    emit({ type: 'status', message: `Found ${channelIds.length} channels. Identifying YouTube…` });

    const result = await identifyYouTube(rokuIp, channelIds, ({ id, appName }) => {
      if (appName) emit({ type: 'status', message: `Channel ${id} = ${appName}` });
    });

    if (!result) {
      return socket.emit('discoveryError', 'YouTube not found. Is the YouTube app installed on this Roku?');
    }

    socket.emit('discoveryFound', { ip: rokuIp, channelId: result.id, appName: result.appName });
  });

  socket.on('saveRokuConfig', ({ ip, channelId }) => {
    ROKU_IP = ip;
    ROKU_YOUTUBE_ID = String(channelId);
    ROKU_BASE = `http://${ip}:8060`;

    updateEnv(ENV_PATH, {
      ROKU_IP: ip,
      ROKU_YOUTUBE_CHANNEL_ID: channelId,
    });

    console.log(`Roku config updated → IP: ${ip}, YouTube channel: ${channelId}`);
    broadcastState();
    socket.emit('discoveryProgress', { type: 'status', message: 'Saved! Roku config updated.' });
  });

  socket.on('disconnect', () => {
    if (socket.id === playerSocketId) {
      playerSocketId = null;
      broadcastState();
    }
  });

  socket.emit('state', getState());
});

app.use(express.static('public'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nJukebox running → http://localhost:${PORT}`);
  if (ROKU_BASE) console.log(`Roku ECP → ${ROKU_BASE} (YouTube: ${ROKU_YOUTUBE_ID})`);
  else console.log('Roku not configured — use the Settings panel to discover.');
});
