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

// Local volume mirror (Roku is the source of truth; ECP only exposes Up/Down/Mute
// keypresses, so we estimate the level for the meter display).
let volLevel = 7;     // 0–10
let muted = false;

// --- DOM ---
const nameModal     = document.getElementById('nameModal');
const nameInput     = document.getElementById('nameInput');
const nameSubmit    = document.getElementById('nameSubmit');
const appEl         = document.getElementById('app');

const vinyl         = document.getElementById('vinyl');
const albumBackdrop = document.getElementById('albumBackdrop');
const sleeve        = document.getElementById('sleeve');
const sleeveArt     = document.getElementById('sleeveArt');
const albumArt      = document.getElementById('albumArt');
const albumArtPH    = document.getElementById('albumArtPlaceholder');
const eqBars        = document.getElementById('eqBars');
const statusWord    = document.getElementById('statusWord');
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
const volBarsEl     = document.getElementById('volBars');

const rokuStatus    = document.getElementById('rokuStatus');
const rokuMissing   = document.getElementById('rokuMissing');

const searchInput   = document.getElementById('searchInput');
const searchBar     = searchInput.closest('.search-bar');
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
  renderVolBars();
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

// Paint the current cover across backdrop, propped sleeve, and record label.
function setArt(thumb) {
  if (thumb) {
    const url = `url("${thumb}")`;
    albumBackdrop.style.backgroundImage = url;
    albumBackdrop.classList.remove('hidden');
    sleeveArt.style.backgroundImage = url;
    sleeve.classList.remove('hidden');
    albumArt.style.backgroundImage = url;
    albumArt.classList.remove('hidden');
    albumArtPH.classList.add('hidden');
  } else {
    albumBackdrop.classList.add('hidden');
    albumBackdrop.style.backgroundImage = 'none';
    sleeve.classList.add('hidden');
    sleeveArt.style.backgroundImage = 'none';
    albumArt.style.backgroundImage = 'none';
    albumArt.classList.add('hidden');
    albumArtPH.classList.remove('hidden');
  }
}

function renderNowPlaying() {
  const song = state.currentSong;

  if (song) {
    nowTitle.textContent = song.title;
    nowAuthor.textContent = song.author || '';
    nowAddedBy.innerHTML = song.addedBy ? `Dropped by <b>${escHtml(song.addedBy)}</b>` : '';
    totalTime.textContent = formatTime(song.duration);

    setArt(song.thumbnail);
  } else {
    nowTitle.textContent = 'Nothing playing';
    nowAuthor.textContent = '';
    nowAddedBy.textContent = '';
    totalTime.textContent = '0:00';
    elapsedEl.textContent = '0:00';
    progressBar.style.width = '0%';
    setArt('');
  }

  // play / pause icon
  iconPlay.classList.toggle('hidden', state.isPlaying);
  iconPause.classList.toggle('hidden', !state.isPlaying);

  // turntable + EQ + status word
  const spinning = state.isPlaying && !!song;
  vinyl.classList.toggle('paused', !spinning);
  eqBars.classList.toggle('paused', !spinning);
  statusWord.textContent = !song ? 'Idle' : (state.isPlaying ? 'Now Spinning' : 'Paused');

  // skip available only to the song owner
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

// --- Volume meter ---
function renderVolBars() {
  let html = '';
  for (let i = 0; i < 10; i++) {
    const on = !muted && i < volLevel;
    const h = 40 + i * 6; // 40% → 94%
    html += `<div class="vbar${on ? ' on' : ''}" style="height:${h}%"></div>`;
  }
  volBarsEl.innerHTML = html;
  btnMute.classList.toggle('muted', muted);
}

function renderQueue() {
  const items = state.queue || [];
  const ordered = [...items]
    .map((s, i) => ({ ...s, _i: i, net: s.netVotes || 0 }))
    .sort((a, b) => b.net - a.net || a._i - b._i);

  queueCount.textContent = ordered.length;

  if (ordered.length === 0) {
    queueList.innerHTML = `
      <div class="queue-empty">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
        </svg>
        <p>Queue is empty — search for a track above</p>
      </div>`;
    return;
  }

  queueList.innerHTML = ordered.map((song, i) => {
    const nv = song.net;
    const myVote = song.votes ? (song.votes[voterId] || 0) : 0;
    const countClass = nv > 0 ? 'positive' : nv < 0 ? 'negative' : '';
    const isOwner = !song.addedByVoterId || song.addedByVoterId === voterId;
    return `
    <div class="queue-item" data-index="${song._i}">
      <div class="vote-col">
        <button class="vote-btn up ${myVote === 1 ? 'active' : ''}" data-video="${song.videoId}" data-addedat="${song.addedAt}" data-value="1" title="Upvote">▲</button>
        <span class="vote-count ${countClass}">${nv > 0 ? '+' : ''}${nv || 0}</span>
        <button class="vote-btn down ${myVote === -1 ? 'active' : ''}" data-video="${song.videoId}" data-addedat="${song.addedAt}" data-value="-1" title="Downvote">▼</button>
      </div>
      <span class="queue-num">${i + 1}</span>
      ${song.thumbnail ? `<img class="queue-thumb" src="${song.thumbnail}" alt="" loading="lazy" onerror="this.style.opacity=0">` : ''}
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(song.title)}</div>
        <div class="queue-item-meta">
          ${song.author ? escHtml(song.author) + ' · ' : ''}${song.durationStr || formatTime(song.duration)} · <span class="added-by">${escHtml(song.addedBy)}</span>
        </div>
      </div>
      ${isOwner ? `<button class="queue-remove" data-index="${song._i}" title="Remove from queue">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>` : '<span class="queue-remove-placeholder"></span>'}
    </div>`;
  }).join('');

  // double-click the top-ordered item to play it immediately
  const firstItem = queueList.querySelector('.queue-item');
  if (firstItem) {
    firstItem.style.cursor = 'pointer';
    firstItem.addEventListener('dblclick', () => {
      socket.emit('playNow', parseInt(firstItem.dataset.index));
    });
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
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('removeFromQueue', parseInt(btn.dataset.index));
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

btnVolUp.addEventListener('click', () => {
  muted = false;
  volLevel = Math.min(10, volLevel + 1);
  renderVolBars();
  socket.emit('volumeUp');
});
btnVolDown.addEventListener('click', () => {
  volLevel = Math.max(0, volLevel - 1);
  renderVolBars();
  socket.emit('volumeDown');
});
btnMute.addEventListener('click', () => {
  muted = !muted;
  renderVolBars();
  socket.emit('mute');
});

// --- Passcode gate ---
const passcodeModal   = document.getElementById('passcodeModal');
const passcodeTitle   = document.getElementById('passcodeTitle');
const passcodeInput   = document.getElementById('passcodeInput');
const passcodeError   = document.getElementById('passcodeError');
const passcodeCancel  = document.getElementById('passcodeCancel');
const passcodeConfirm = document.getElementById('passcodeConfirm');

let passcodeAction = null; // { label, fn }

function requirePasscode(label, fn) {
  passcodeAction = { label, fn };
  passcodeInput.value = '';
  passcodeError.classList.add('hidden');
  passcodeTitle.textContent = label;
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
  const items = [...(state.history || [])]
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
      ${song.thumbnail ? `<img class="queue-thumb" src="${song.thumbnail}" alt="" loading="lazy" onerror="this.style.opacity=0">` : ''}
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(song.title)}</div>
        <div class="queue-item-meta">${song.author ? escHtml(song.author) + ' · ' : ''}<span class="added-by">${escHtml(song.addedBy)}</span></div>
      </div>
      <span class="play-count-badge" title="Times played">${count}×</span>
      <button class="add-to-queue-btn" data-index="${i}" title="Add to queue">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
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
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      btn.classList.add('added');
      setTimeout(() => {
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
        btn.classList.remove('added');
      }, 1500);
    });
  });
}

// --- Search ---
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.classList.toggle('hidden', !q);
  searchBar.classList.toggle('active', !!q);
  clearTimeout(searchDebounce);
  if (!q) { hideSearch(); return; }
  showSearchSpinner();
  searchDebounce = setTimeout(() => doSearch(q), 450);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  searchBar.classList.remove('active');
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
        ${v.thumbnail ? `<img class="search-thumb" src="${v.thumbnail}" alt="" loading="lazy" onerror="this.style.opacity=0">` : ''}
        <div class="search-result-info">
          <div class="search-result-title">${escHtml(v.title)}</div>
          <div class="search-result-meta">${escHtml(v.author || '')} · ${v.durationStr || formatTime(v.duration)}</div>
        </div>
        <span class="search-result-plus">+</span>
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
  searchBar.classList.remove('active');
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

  deviceList.querySelectorAll('.device-select').forEach((btn) => {
    btn.textContent = 'Use this TV';
    btn.disabled = false;
  });
});

socket.on('discoveryError', (msg) => {
  const line = document.createElement('div');
  line.style.color = '#e0533f';
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
  line.style.color = '#6fcf6f';
  line.textContent = `Saved — Roku IP: ${pendingRokuConfig.ip}, YouTube: ${pendingRokuConfig.channelId}`;
  discoveryLog.appendChild(line);
  pendingRokuConfig = null;
  setTimeout(() => settingsModal.classList.add('hidden'), 1500);
});

// --- Helpers ---
function formatTime(seconds) {
  const s = Math.floor(Math.max(0, seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// initial paint
renderVolBars();
