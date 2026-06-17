const socket = io();

// --- State ---
let state = {
  currentSong: null,
  queue: [],
  history: [],
  isPlaying: false,
  playStartTime: null,
  elapsedAtPause: 0,
  rokuConfigured: false,
  rokuIp: '',
  rokuChannelId: '',
};

let userName = '';
let voterId = getVoterId();
let searchDebounce = null;
let progressInterval = null;

// --- DOM ---
const nameModal     = document.getElementById('nameModal');
const nameInput     = document.getElementById('nameInput');
const nameSubmit    = document.getElementById('nameSubmit');
const appEl         = document.getElementById('app');
const userBadge     = document.getElementById('userBadge');

const albumArt      = document.getElementById('albumArt');
const albumArtPH    = document.getElementById('albumArtPlaceholder');
const nowTitle      = document.getElementById('nowTitle');
const nowAuthor     = document.getElementById('nowAuthor');
const nowAddedBy    = document.getElementById('nowAddedBy');
const elapsedEl     = document.getElementById('elapsed');
const totalTime     = document.getElementById('totalTime');
const progressBar   = document.getElementById('progressBar');

const btnPlayPause  = document.getElementById('btnPlayPause');
const iconPlay      = document.getElementById('iconPlay');
const iconPause     = document.getElementById('iconPause');
const btnNext       = document.getElementById('btnNext');
const btnVolUp      = document.getElementById('btnVolUp');
const btnVolDown    = document.getElementById('btnVolDown');
const btnMute       = document.getElementById('btnMute');
const btnPrev       = null; // removed

const rokuStatus    = document.getElementById('rokuStatus');
const rokuMissing   = document.getElementById('rokuMissing');

const searchInput   = document.getElementById('searchInput');
const searchClear   = document.getElementById('searchClear');
const searchResults = document.getElementById('searchResults');
const searchList    = document.getElementById('searchList');
const searchSpinner = document.getElementById('searchSpinner');
const searchEmpty   = document.getElementById('searchEmpty');

const queueList     = document.getElementById('queueList');
const queueCount    = document.getElementById('queueCount');
const btnClearQueue = document.getElementById('btnClearQueue');
const tabQueue      = document.getElementById('tabQueue');
const tabHistory    = document.getElementById('tabHistory');
const queueView     = document.getElementById('queueView');
const historyView   = document.getElementById('historyView');
const historyList   = document.getElementById('historyList');

const btnSettings     = document.getElementById('btnSettings');
const settingsModal   = document.getElementById('settingsModal');
const settingsClose   = document.getElementById('settingsClose');
const settingsCurIp   = document.getElementById('settingsCurIp');
const settingsCurId   = document.getElementById('settingsCurId');
const btnScan         = document.getElementById('btnScan');
const stepDevices     = document.getElementById('stepDevices');
const deviceList      = document.getElementById('deviceList');
const discoveryLog    = document.getElementById('discoveryLog');
const discoveryResult = document.getElementById('discoveryResult');
const resultText      = document.getElementById('resultText');
const btnSaveRoku     = document.getElementById('btnSaveRoku');

let pendingRokuConfig = null;

// --- Voter ID (stable per browser/device) ---
function getVoterId() {
  let id = localStorage.getItem('jukebox_voter_id');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('jukebox_voter_id', id);
  }
  return id;
}

// --- Name setup ---
function initName() {
  const saved = localStorage.getItem('jukebox_name');
  if (saved) {
    userName = saved;
    socket.emit('setName', userName);
    showApp();
  } else {
    nameModal.classList.remove('hidden');
    nameInput.focus();
  }
}

function showApp() {
  nameModal.style.display = 'none';
  appEl.classList.remove('hidden');
  userBadge.textContent = userName;
}

nameSubmit.addEventListener('click', submitName);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });

function submitName() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  userName = name;
  localStorage.setItem('jukebox_name', userName);
  socket.emit('setName', userName);
  showApp();
}

// --- Socket events ---
socket.on('connect', () => initName());
socket.on('state', (s) => { state = s; renderAll(); });
socket.on('queueError', (msg) => showQueueError(msg));

// --- Render ---
function renderAll() {
  renderNowPlaying();
  renderQueue();
  renderRokuStatus();
  if (tabHistory.classList.contains('active')) renderHistory();
}

function renderNowPlaying() {
  const song = state.currentSong;

  if (song) {
    nowTitle.textContent = song.title;
    nowAuthor.textContent = song.author || '';
    nowAddedBy.textContent = song.addedBy ? `Added by ${song.addedBy}` : '';
    totalTime.textContent = formatTime(song.duration);

    if (song.thumbnail) {
      albumArt.src = song.thumbnail;
      albumArt.classList.add('visible');
      albumArtPH.classList.add('hidden');
    } else {
      albumArt.classList.remove('visible');
      albumArtPH.classList.remove('hidden');
    }
  } else {
    nowTitle.textContent = 'Nothing playing';
    nowAuthor.textContent = '';
    nowAddedBy.textContent = '';
    totalTime.textContent = '0:00';
    elapsedEl.textContent = '0:00';
    progressBar.style.width = '0%';
    albumArt.classList.remove('visible');
    albumArtPH.classList.remove('hidden');
  }

  iconPlay.classList.toggle('hidden', state.isPlaying);
  iconPause.classList.toggle('hidden', !state.isPlaying);

  const ownerVid = state.currentSong?.addedByVoterId;
  const isOwner = ownerVid === voterId || !ownerVid;
  btnNext.classList.toggle('hidden', !isOwner || !state.currentSong);

  startProgressTick();
}

function startProgressTick() {
  clearInterval(progressInterval);
  if (!state.currentSong) return;
  updateProgress();
  progressInterval = setInterval(updateProgress, 1000);
}

function updateProgress() {
  const song = state.currentSong;
  if (!song) return;

  let sec;
  if (state.isPlaying && state.playStartTime) {
    sec = state.elapsedAtPause + (Date.now() - state.playStartTime) / 1000;
  } else {
    sec = state.elapsedAtPause;
  }
  sec = Math.min(sec, song.duration);
  elapsedEl.textContent = formatTime(sec);
  progressBar.style.width = song.duration > 0 ? `${(sec / song.duration) * 100}%` : '0%';
}

function renderQueue() {
  const items = state.queue;
  const current = state.currentSong;
  const total = items.length + (current ? 1 : 0);
  queueCount.textContent = total ? `${total} song${total > 1 ? 's' : ''}` : '';

  if (!current && items.length === 0) {
    queueList.innerHTML = `
      <div class="queue-empty">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
        </svg>
        <p>Queue is empty — search for a song above</p>
      </div>`;
    return;
  }

  const isCurrentOwner = current && (!current.addedByVoterId || current.addedByVoterId === voterId);
  const nowPlayingRow = current ? `
    <div class="queue-item now-playing-row${state.isPlaying ? '' : ' paused'}">
      <div class="now-playing-indicator" title="${state.isPlaying ? 'Now playing' : 'Paused'}">
        <span class="bar"></span><span class="bar"></span><span class="bar"></span>
      </div>
      <img class="queue-thumb" src="${current.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(current.title)}</div>
        <div class="queue-item-meta">
          ${current.author ? escHtml(current.author) + ' · ' : ''}
          <span class="added-by">${escHtml(current.addedBy)}</span>
        </div>
      </div>
      <span class="now-playing-badge">${state.isPlaying ? 'Playing' : 'Paused'}</span>
      ${isCurrentOwner ? `<button class="queue-remove current-song-remove" title="Remove from queue">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>` : '<span class="queue-remove-placeholder"></span>'}
    </div>` : '';

  if (items.length === 0) {
    queueList.innerHTML = nowPlayingRow;
    queueList.querySelectorAll('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', () => socket.emit('removeCurrentSong'));
    });
    return;
  }

  const counts = state.playCounts || {};

  queueList.innerHTML = items.map((song, i) => {
    const nv = song.netVotes || 0;
    const myVote = song.votes ? (song.votes[voterId] || 0) : 0;
    const countClass = nv > 0 ? 'positive' : nv < 0 ? 'negative' : '';
    const plays = counts[song.videoId] || 0;

    const isOwner = !song.addedByVoterId || song.addedByVoterId === voterId;
    return `
    <div class="queue-item" data-video="${song.videoId}" data-addedat="${song.addedAt}">
      <div class="vote-col">
        <button class="vote-btn up ${myVote === 1 ? 'active' : ''}" data-video="${song.videoId}" data-addedat="${song.addedAt}" data-value="1" title="Upvote">▲</button>
        <span class="vote-count ${countClass}">${nv > 0 ? '+' : ''}${nv || 0}</span>
        <button class="vote-btn down ${myVote === -1 ? 'active' : ''}" data-video="${song.videoId}" data-addedat="${song.addedAt}" data-value="-1" title="Downvote">▼</button>
      </div>
      <span class="queue-num">${i + 1}</span>
      <img class="queue-thumb" src="${song.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(song.title)}</div>
        <div class="queue-item-meta">
          ${song.author ? escHtml(song.author) + ' · ' : ''}${song.durationStr || formatTime(song.duration)} · <span class="added-by">${escHtml(song.addedBy)}</span>
        </div>
      </div>
      ${plays > 0 ? `<span class="play-count-badge" title="Times played">${plays}×</span>` : ''}
      ${isOwner ? `<button class="queue-remove" data-index="${i}" title="Remove from queue">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>` : '<span class="queue-remove-placeholder"></span>'}
    </div>`;
  }).join('');

  queueList.innerHTML = nowPlayingRow + queueList.innerHTML;

  // dblclick only on the first queued item (index 0)
  const firstQueued = queueList.querySelector('.queue-item:not(.now-playing-row)');
  if (firstQueued) {
    firstQueued.style.cursor = 'pointer';
    firstQueued.addEventListener('dblclick', () => socket.emit('playNow', 0));
  }

  queueList.querySelectorAll('.vote-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('vote', {
        videoId: btn.dataset.video,
        addedAt: Number(btn.dataset.addedat),
        voterId,
        value: Number(btn.dataset.value),
      });
    });
  });

  queueList.querySelectorAll('.queue-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('current-song-remove')) {
        socket.emit('removeCurrentSong');
      } else {
        socket.emit('removeFromQueue', parseInt(btn.dataset.index));
      }
    });
  });
}

function renderRokuStatus() {
  rokuStatus.classList.toggle('hidden', !state.rokuConfigured);
  rokuMissing.classList.toggle('hidden', state.rokuConfigured);
  settingsCurIp.textContent = state.rokuIp || '—';
  settingsCurId.textContent = state.rokuChannelId || '—';
}

// --- Controls ---
btnPlayPause.addEventListener('click', () => socket.emit('togglePause'));
btnNext.addEventListener('click', () => socket.emit('skip'));

btnVolUp.addEventListener('click', () => socket.emit('volumeUp'));
btnVolDown.addEventListener('click', () => socket.emit('volumeDown'));
btnMute.addEventListener('click', () => socket.emit('mute'));

const passcodeModal   = document.getElementById('passcodeModal');
const passcodeInput   = document.getElementById('passcodeInput');
const passcodeError   = document.getElementById('passcodeError');
const passcodeCancel  = document.getElementById('passcodeCancel');
const passcodeConfirm = document.getElementById('passcodeConfirm');

let passcodeAction = null; // { label, fn }

function requirePasscode(label, fn) {
  passcodeAction = { label, fn };
  passcodeInput.value = '';
  passcodeError.classList.add('hidden');
  passcodeConfirm.textContent = label;
  passcodeModal.classList.remove('hidden');
  setTimeout(() => passcodeInput.focus(), 50);
}

btnClearQueue.addEventListener('click', () => requirePasscode('Clear queue', () => socket.emit('clearQueue')));

passcodeCancel.addEventListener('click', closePasscode);
passcodeModal.addEventListener('click', (e) => { if (e.target === passcodeModal) closePasscode(); });
passcodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmPasscode();
  if (e.key === 'Escape') closePasscode();
});
passcodeConfirm.addEventListener('click', confirmPasscode);

function confirmPasscode() {
  if (passcodeInput.value === '5665') {
    passcodeAction?.fn();
    closePasscode();
  } else {
    passcodeError.classList.remove('hidden');
    passcodeInput.value = '';
    passcodeInput.focus();
  }
}

function closePasscode() {
  passcodeModal.classList.add('hidden');
  passcodeAction = null;
}

// --- Tabs ---
tabQueue.addEventListener('click', () => switchTab('queue'));
tabHistory.addEventListener('click', () => switchTab('history'));

function switchTab(tab) {
  const isQueue = tab === 'queue';
  tabQueue.classList.toggle('active', isQueue);
  tabHistory.classList.toggle('active', !isQueue);
  queueView.classList.toggle('hidden', !isQueue);
  historyView.classList.toggle('hidden', isQueue);
  if (!isQueue) renderHistory();
}

function renderHistory() {
  const seen = new Set();
  const counts = state.playCounts || {};
  const items = [...state.history]
    .reverse()
    .filter(s => seen.has(s.videoId) ? false : seen.add(s.videoId))
    .sort((a, b) => (counts[b.videoId] || 0) - (counts[a.videoId] || 0));
  if (!items.length) {
    historyList.innerHTML = '<div class="queue-empty"><p>No history yet</p></div>';
    return;
  }
  historyList.innerHTML = items.map((song, i) => {
    const count = counts[song.videoId] || 0;
    return `
    <div class="queue-item">
      <img class="queue-thumb" src="${song.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(song.title)}</div>
        <div class="queue-item-meta">${song.author ? escHtml(song.author) + ' · ' : ''}<span class="added-by">${escHtml(song.addedBy)}</span></div>
      </div>
      <span class="play-count-badge" title="Times played">${count}×</span>
      <button class="add-to-queue-btn" data-index="${i}" title="Add to queue">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
      <button class="history-delete-btn" data-videoid="${song.videoId}" title="Remove from history">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>`;
  }).join('');

  historyList.querySelectorAll('.history-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const videoId = btn.dataset.videoid;
      requirePasscode('Remove song', () => socket.emit('removeFromHistory', videoId));
    });
  });

  historyList.querySelectorAll('.add-to-queue-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const song = items[parseInt(btn.dataset.index)];
      socket.emit('addToQueue', { ...song, voterId });
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      btn.classList.add('added');
      setTimeout(() => {
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
        btn.classList.remove('added');
      }, 1500);
    });
  });
}

// --- Search ---
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.classList.toggle('hidden', !q);
  clearTimeout(searchDebounce);
  if (!q) { hideSearch(); return; }
  showSearchSpinner();
  searchDebounce = setTimeout(() => doSearch(q), 450);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  hideSearch();
  searchInput.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-area')) hideSearch();
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim() && searchList.children.length) searchResults.classList.remove('hidden');
});

function showSearchSpinner() {
  searchResults.classList.remove('hidden');
  searchSpinner.classList.remove('hidden');
  searchEmpty.classList.add('hidden');
  searchList.innerHTML = '';
}

function hideSearch() { searchResults.classList.add('hidden'); }

let queueErrorTimer = null;
function showQueueError(msg) {
  searchResults.classList.remove('hidden');
  searchSpinner.classList.add('hidden');
  searchList.innerHTML = '';
  searchEmpty.classList.remove('hidden');
  searchEmpty.textContent = msg;
  clearTimeout(queueErrorTimer);
  queueErrorTimer = setTimeout(() => {
    searchEmpty.textContent = 'No results found';
    hideSearch();
  }, 2500);
}

function doSearch(query) {
  socket.emit('search', query, (err, results) => {
    searchSpinner.classList.add('hidden');
    if (err || !results || !results.length) { searchEmpty.classList.remove('hidden'); return; }
    searchEmpty.classList.add('hidden');

    searchList.innerHTML = results.map((v, i) => `
      <div class="search-result-item" data-index="${i}">
        <img class="search-thumb" src="${v.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="search-result-info">
          <div class="search-result-title">${escHtml(v.title)}</div>
          <div class="search-result-meta">${escHtml(v.author || '')} · ${v.durationStr || formatTime(v.duration)}</div>
        </div>
        <span class="search-result-duration">${v.durationStr || formatTime(v.duration)}</span>
      </div>`).join('');

    searchList._results = results;
    searchList.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        const video = searchList._results[parseInt(el.dataset.index)];
        if (video) addToQueue(video);
      });
    });
  });
}

function addToQueue(song) {
  socket.emit('addToQueue', { ...song, voterId });
  searchInput.value = '';
  searchClear.classList.add('hidden');
  hideSearch();
  searchInput.focus();
}

// --- Settings / Discovery ---
btnSettings.addEventListener('click', () => requirePasscode('Open settings', () => settingsModal.classList.remove('hidden')));
settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

btnScan.addEventListener('click', () => {
  btnScan.disabled = true;
  btnScan.textContent = 'Scanning…';
  stepDevices.classList.add('hidden');
  discoveryLog.classList.remove('hidden');
  discoveryLog.innerHTML = '';
  discoveryResult.classList.add('hidden');
  pendingRokuConfig = null;
  socket.emit('startDiscovery');
});

socket.on('discoveryProgress', ({ type, message, device }) => {
  if (type === 'status') {
    const line = document.createElement('div');
    line.textContent = message;
    discoveryLog.appendChild(line);
    discoveryLog.scrollTop = discoveryLog.scrollHeight;
  }
  if (type === 'device') {
    const line = document.createElement('div');
    line.textContent = `Found: ${device.name} (${device.ip})`;
    discoveryLog.appendChild(line);
    discoveryLog.scrollTop = discoveryLog.scrollHeight;
  }
});

socket.on('discoveryDevices', (devices) => {
  btnScan.disabled = false;
  btnScan.textContent = 'Scan again';

  deviceList.innerHTML = devices.map((d) => `
    <div class="device-item">
      <div>
        <div class="device-name">${escHtml(d.name)}</div>
        <div class="device-ip">${d.ip} · ${d.model}</div>
      </div>
      <button class="device-select" data-ip="${d.ip}">Use this TV</button>
    </div>`).join('');

  deviceList.querySelectorAll('.device-select').forEach((btn) => {
    btn.addEventListener('click', () => {
      discoveryLog.innerHTML = '';
      discoveryResult.classList.add('hidden');
      socket.emit('findYouTube', btn.dataset.ip);
      btn.textContent = 'Finding…';
      btn.disabled = true;
    });
  });

  stepDevices.classList.remove('hidden');
});

socket.on('discoveryFound', ({ ip, channelId, appName }) => {
  pendingRokuConfig = { ip, channelId };
  resultText.textContent = `✓ Found ${appName} on ${ip} (channel ID: ${channelId})`;
  discoveryResult.classList.remove('hidden');

  // Re-enable device buttons
  deviceList.querySelectorAll('.device-select').forEach((btn) => {
    btn.textContent = 'Use this TV';
    btn.disabled = false;
  });
});

socket.on('discoveryError', (msg) => {
  const line = document.createElement('div');
  line.style.color = '#e84545';
  line.textContent = `Error: ${msg}`;
  discoveryLog.appendChild(line);
  btnScan.disabled = false;
  btnScan.textContent = 'Scan again';
  deviceList.querySelectorAll('.device-select').forEach((btn) => {
    btn.textContent = 'Use this TV';
    btn.disabled = false;
  });
});

btnSaveRoku.addEventListener('click', () => {
  if (!pendingRokuConfig) return;
  socket.emit('saveRokuConfig', pendingRokuConfig);
  discoveryResult.classList.add('hidden');
  discoveryLog.innerHTML = '';
  const line = document.createElement('div');
  line.style.color = '#81c784';
  line.textContent = `Saved — Roku IP: ${pendingRokuConfig.ip}, YouTube: ${pendingRokuConfig.channelId}`;
  discoveryLog.appendChild(line);
  pendingRokuConfig = null;
  setTimeout(() => settingsModal.classList.add('hidden'), 1500);
});

// --- Helpers ---
function formatTime(seconds) {
  const s = Math.floor(Math.max(0, seconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
