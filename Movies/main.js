// ══ CONFIG ════════════════════════════════════════════════════════
const LISTING_BASE = 'https://vidapi.ru';
const PLAYER_BASE  = 'https://vaplayer.ru';
const PCOLOR       = '%2300e676';

// ══ HELPERS ═══════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const pad2 = (n) => String(n).padStart(2, '0');

function fmt(s) {
  if (!s) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ── PAGE CACHE ────────────────────────────────────────────────────
const pageCache = new Map();
async function getJSONCached(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  const data = await getJSON(url);
  pageCache.set(url, data);
  return data;
}

// ── TOAST ─────────────────────────────────────────────────────────
const toastRack = (() => {
  const rack = document.createElement('div');
  rack.className = 'toast-rack';
  document.body.appendChild(rack);
  return rack;
})();

function toast(msg, isGreen = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isGreen ? ' green' : '');
  el.textContent = msg;
  toastRack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 200); }, 2200);
}

// ── SVGs ──────────────────────────────────────────────────────────
const PLAY_SVG = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const FILM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 7h5M17 17h5"/></svg>`;
const TV_SVG   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>`;

// ── KEYBOARD SHORTCUT: / to focus search ─────────────────────────
document.addEventListener('keydown', (e) => {
  if (
    e.key === '/' && !e.ctrlKey && !e.metaKey &&
    !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) &&
    $('playerModal').classList.contains('hidden')
  ) {
    e.preventDefault();
    $('searchInput').focus();
    $('searchInput').select();
  }
});

function scrollToContent() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

// ══ AUTH ══════════════════════════════════════════════════════════
let currentUser = sessionStorage.getItem('vs_id') || null;
let pendingPlay = null;

function isLoggedIn() { return !!currentUser; }

function doLogin(id) {
  currentUser = id;
  sessionStorage.setItem('vs_id', id);
  seedDefaultPlaylistIfNew(id);
  if (pendingPlay) {
    const { url, title, item } = pendingPlay;
    pendingPlay = null;
    $('loginGate').classList.add('hidden');
    _play(url, title, item);
  }
}

function doLogout() {
  currentUser = null;
  sessionStorage.removeItem('vs_id');
  renderProfileSection();
  toast('Signed out');
}

// ── requireAuth: open gate if not logged in ───────────────────────
function requireAuth(url, title, item) {
  if (isLoggedIn()) { _play(url, title, item); return; }
  pendingPlay = { url, title, item };
  $('gateInput').value = '';
  $('gateErr').classList.add('hidden');
  $('gateTcCheck').checked = false;
  $('gateTcErr').classList.add('hidden');
  $('gateTcBox').classList.add('hidden');
  $('gateTcToggle').textContent = 'View Terms & Conditions ▾';
  $('loginGate').classList.remove('hidden');
  setTimeout(() => $('gateInput').focus(), 100);
}

// ── Login Gate events ─────────────────────────────────────────────
$('gateTcToggle').addEventListener('click', () => {
  const hidden = $('gateTcBox').classList.toggle('hidden');
  $('gateTcToggle').textContent = hidden ? 'View Terms & Conditions ▾' : 'Hide Terms & Conditions ▴';
});

$('gateInput').addEventListener('input', () => {
  $('gateInput').value = $('gateInput').value.replace(/\D/g, '').slice(0, 6);
  $('gateErr').classList.add('hidden');
});

$('gateInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if ($('gateInput').value.length !== 6) { $('gateErr').classList.remove('hidden'); return; }
  gateSubmit($('gateInput').value);
});

$('gateSubmit').addEventListener('click', () => {
  if ($('gateInput').value.length !== 6) { $('gateErr').classList.remove('hidden'); return; }
  gateSubmit($('gateInput').value);
});

$('gateCancel').addEventListener('click', () => {
  $('loginGate').classList.add('hidden');
  pendingPlay = null;
  $('gateInput').value = '';
  $('gateTcCheck').checked = false;
  $('gateTcErr').classList.add('hidden');
});

function gateSubmit(id) {
  if (!$('gateTcCheck').checked) { $('gateTcErr').classList.remove('hidden'); return; }
  doLogin(id);
}

// ── Profile section: sign-in form ────────────────────────────────
$('profileTcToggle').addEventListener('click', () => {
  const hidden = $('profileTcBox').classList.toggle('hidden');
  $('profileTcToggle').textContent = hidden ? 'View Terms & Conditions ▾' : 'Hide Terms & Conditions ▴';
});

$('profileInput').addEventListener('input', () => {
  $('profileInput').value = $('profileInput').value.replace(/\D/g, '').slice(0, 6);
  $('profileInputErr').classList.add('hidden');
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleProfileSignIn();
});

$('profileSignInBtn').addEventListener('click', handleProfileSignIn);

function handleProfileSignIn() {
  const id = $('profileInput').value;
  if (id.length !== 6) { $('profileInputErr').classList.remove('hidden'); return; }
  if (!$('profileTcCheck').checked) { $('profileTcErr').classList.remove('hidden'); return; }
  doLogin(id);
  renderProfileSection();
}

function renderProfileSection() {
  if (isLoggedIn()) {
    $('profileLoginView').classList.add('hidden');
    $('profileLoggedInView').classList.remove('hidden');
    $('profileUserId').textContent = `#${currentUser}`;
    renderHistory();
    renderPlaylists();
  } else {
    $('profileLoginView').classList.remove('hidden');
    $('profileLoggedInView').classList.add('hidden');
    $('profileInput').value = '';
    $('profileInputErr').classList.add('hidden');
    $('profileTcCheck').checked = false;
    $('profileTcErr').classList.add('hidden');
    $('profileTcBox').classList.add('hidden');
    $('profileTcToggle').textContent = 'View Terms & Conditions ▾';
    setTimeout(() => $('profileInput').focus(), 100);
  }
}

$('logoutBtn').addEventListener('click', doLogout);

// ══ HISTORY ═══════════════════════════════════════════════════════
function historyKey() { return `vs_history_${currentUser}`; }
function getHistory() {
  if (!currentUser) return [];
  try { return JSON.parse(localStorage.getItem(historyKey()) || '[]'); }
  catch { return []; }
}
function addHistory(item) {
  if (!currentUser) return;
  const history = getHistory().filter(h => h.id !== (item.imdb_id || item.tmdb_id || item.id));
  history.unshift({
    id:         item.imdb_id || item.tmdb_id || item.id || 'unknown',
    title:      item.title || 'Unknown',
    type:       item._type || 'movie',
    year:       item.year || '',
    poster_url: item.poster_url || '',
    watched_at: new Date().toISOString(),
  });
  localStorage.setItem(historyKey(), JSON.stringify(history.slice(0, 200)));
}

function renderHistory() {
  const history = getHistory();
  const list    = $('historyList');
  $('historyCount').textContent = `${history.length} item${history.length !== 1 ? 's' : ''}`;
  if (!history.length) { list.innerHTML = '<p class="empty-msg">No history yet</p>'; return; }
  list.innerHTML = '';
  history.forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-item';
    const poster = item.poster_url
      ? `<img class="h-poster" src="${esc(item.poster_url)}" alt="" loading="lazy">`
      : `<div class="h-poster-ph">${item.type === 'tv' ? TV_SVG : FILM_SVG}</div>`;
    const date = new Date(item.watched_at).toLocaleDateString();
    row.innerHTML = `${poster}
      <div class="h-info">
        <div class="h-title">${esc(item.title)}</div>
        <div class="h-meta">${item.type || 'movie'}${item.year ? ' · ' + item.year : ''} · ${date}</div>
      </div>`;
    row.addEventListener('click', () => {
      const url = item.type === 'tv' ? embedTv(item, 1, 1) : embedMovie(item);
      requireAuth(url, item.title, item);
    });
    list.appendChild(row);
  });
}

$('clearHistoryBtn').addEventListener('click', () => {
  if (!currentUser) return;
  localStorage.removeItem(historyKey());
  renderHistory();
  toast('History cleared');
});

// ══ PLAYLISTS ═════════════════════════════════════════════════════
function plKey() { return `vs_playlists_${currentUser}`; }
function getPlaylists() {
  if (!currentUser) return [];
  try { return JSON.parse(localStorage.getItem(plKey()) || '[]'); }
  catch { return []; }
}
function savePlaylists(pls) { if (currentUser) localStorage.setItem(plKey(), JSON.stringify(pls)); }
function createPlaylist(name) {
  const pls = getPlaylists();
  pls.push({ id: Date.now().toString(), name, items: [] });
  savePlaylists(pls);
}
function deletePlaylist(plId) { savePlaylists(getPlaylists().filter(p => p.id !== plId)); }
function addToPlaylist(plId, item) {
  const pls = getPlaylists();
  const pl  = pls.find(p => p.id === plId);
  if (!pl) return;
  if (pl.items.find(i => i.id === (item.imdb_id || item.tmdb_id || item.id))) return;
  pl.items.push({
    id:         item.imdb_id || item.tmdb_id || item.id,
    title:      item.title || 'Unknown',
    type:       item._type || 'movie',
    year:       item.year || '',
    poster_url: item.poster_url || '',
  });
  savePlaylists(pls);
}
function removeFromPlaylist(plId, itemId) {
  const pls = getPlaylists();
  const pl  = pls.find(p => p.id === plId);
  if (!pl) return;
  pl.items = pl.items.filter(i => i.id !== itemId);
  savePlaylists(pls);
}

function renderPlaylists() {
  const pls  = getPlaylists();
  const list = $('playlistList');
  if (!pls.length) { list.innerHTML = '<p class="empty-msg">No playlists yet</p>'; return; }
  list.innerHTML = '';
  pls.forEach(pl => {
    const wrapper  = document.createElement('div');
    wrapper.className = 'playlist-item';
    const header = document.createElement('div');
    header.className = 'pl-header';
    header.innerHTML = `<span class="pl-name">${esc(pl.name)}</span><span class="pl-count">${pl.items.length}</span><button class="pl-del" title="Delete">x</button>`;
    header.querySelector('.pl-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlaylist(pl.id);
      renderPlaylists();
    });
    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'pl-items';
    if (pl.items.length) {
      pl.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'pl-item-row';
        row.innerHTML = `<span class="pl-item-title">${esc(item.title)}</span><span style="font-size:.6rem;color:var(--dim);margin-right:.3rem">${item.year || ''}</span><button class="pl-item-del" title="Remove">x</button>`;
        row.querySelector('.pl-item-del').addEventListener('click', (e) => {
          e.stopPropagation();
          removeFromPlaylist(pl.id, item.id);
          renderPlaylists();
        });
        row.addEventListener('click', () => {
          const url = item.type === 'tv' ? embedTv(item, 1, 1) : embedMovie(item);
          requireAuth(url, item.title, item);
        });
        itemsDiv.appendChild(row);
      });
    } else {
      itemsDiv.innerHTML = '<p style="font-size:.65rem;color:var(--dim);padding:.4rem .85rem">Empty playlist</p>';
    }
    header.addEventListener('click', () => itemsDiv.classList.toggle('open'));
    wrapper.appendChild(header);
    wrapper.appendChild(itemsDiv);
    list.appendChild(wrapper);
  });
}

$('newPlaylistBtn').addEventListener('click', () => { $('newPlForm').classList.toggle('hidden'); $('newPlName').focus(); });
$('cancelPlBtn').addEventListener('click', () => $('newPlForm').classList.add('hidden'));
$('createPlBtn').addEventListener('click', () => {
  const name = $('newPlName').value.trim();
  if (!name) return;
  createPlaylist(name);
  $('newPlName').value = '';
  $('newPlForm').classList.add('hidden');
  renderPlaylists();
  toast('Playlist created', true);
});
$('newPlName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  $('createPlBtn').click();
  if (e.key === 'Escape') $('newPlForm').classList.add('hidden');
});

// Profile inner tabs (History / Playlists)
document.querySelectorAll('.ptab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ptab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    $(`ptab${btn.dataset.ptab.charAt(0).toUpperCase() + btn.dataset.ptab.slice(1)}`).classList.remove('hidden');
  });
});

// ══ EMBED HELPERS ═════════════════════════════════════════════════
function progressKey(key) { return `vs_prog_${currentUser}_${key}`; }

function resume(key) {
  if (!currentUser) return '';
  const v = localStorage.getItem(progressKey(key));
  return v ? `&resumeAt=${v}` : '';
}
function embedMovie(item) {
  const id = item.imdb_id || item.tmdb_id || item.id;
  return `${PLAYER_BASE}/embed/movie/${id}?primaryColor=${PCOLOR}${resume(id)}`;
}
function embedTv(item, s, e) {
  const id = item.imdb_id || item.tmdb_id || item.id;
  return `${PLAYER_BASE}/embed/tv/${id}/${s}/${e}?primaryColor=${PCOLOR}${resume(`${id}_${s}_${e}`)}`;
}

// ══ PLAYER ════════════════════════════════════════════════════════
let nowPlaying = null;

function _play(url, title, item) {
  $('playerIframe').src = url;
  $('playerTitle').textContent = title;
  $('progFill').style.width = '0%';
  $('progTime').textContent = '—';
  $('playerModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  nowPlaying = item || null;
  if (item && currentUser) addHistory(item);
}

function closePlayer() {
  $('playerIframe').src = '';
  $('playerModal').classList.add('hidden');
  document.body.style.overflow = '';
  nowPlaying = null;
}

$('playerClose').addEventListener('click', closePlayer);
$('playerModal').addEventListener('click', (e) => { if (e.target === $('playerModal')) closePlayer(); });
$('addToPlaylistBtn').addEventListener('click', () => { if (!nowPlaying || !currentUser) return; openPlPicker(nowPlaying); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('playerModal').classList.contains('hidden'))  { closePlayer(); return; }
  if (!$('loginGate').classList.contains('hidden'))    { $('loginGate').classList.add('hidden'); pendingPlay = null; return; }
  if (!$('plPicker').classList.contains('hidden'))     { $('plPicker').classList.add('hidden'); }
});

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'PLAYER_EVENT') return;
  const { player_info, player_status, player_progress, player_duration } = event.data.data;
  if (player_status === 'playing' || player_status === 'paused') {
    const key = player_info.season != null
      ? `${player_info.imdb || player_info.tmdb}_${player_info.season}_${player_info.episode}`
      : `${player_info.imdb || player_info.tmdb}`;
    if (currentUser) localStorage.setItem(progressKey(key), player_progress);
    $('progFill').style.width = player_duration > 0 ? `${(player_progress / player_duration) * 100}%` : '0%';
    $('progTime').textContent = player_duration ? `${fmt(player_progress)} / ${fmt(player_duration)}` : fmt(player_progress);
  }
  if (player_status === 'completed' && player_info.mediaType === 'tv') {
    const show = { imdb_id: player_info.imdb, tmdb_id: player_info.tmdb, title: player_info.title, _type: 'tv' };
    const nextEp = parseInt(player_info.episode) + 1;
    _play(embedTv(show, player_info.season, nextEp), `${player_info.title} — S${pad2(player_info.season)}E${pad2(nextEp)}`, show);
  }
});

// ══ PLAYLIST PICKER ═══════════════════════════════════════════════
function openPlPicker(item) {
  const pls  = getPlaylists();
  const list = $('plPickerList');
  list.innerHTML = '';
  if (!pls.length) {
    list.innerHTML = '<p style="font-size:.72rem;color:var(--dim)">No playlists — create one in your Profile</p>';
  } else {
    pls.forEach(pl => {
      const btn = document.createElement('button');
      btn.className = 'pl-pick-btn';
      btn.textContent = `${pl.name} (${pl.items.length})`;
      btn.addEventListener('click', () => {
        addToPlaylist(pl.id, item);
        $('plPicker').classList.add('hidden');
        toast('Added to ' + pl.name, true);
      });
      list.appendChild(btn);
    });
  }
  $('plPicker').classList.remove('hidden');
}
$('plPickerClose').addEventListener('click', () => $('plPicker').classList.add('hidden'));

// ══ CARDS ═════════════════════════════════════════════════════════
function makeCard(item, type) {
  item._type = type;
  const d   = document.createElement('div');
  d.className = 'card';
  const img = item.poster_url
    ? `<img class="card-img" src="${esc(item.poster_url)}" alt="${esc(item.title)}" loading="lazy">`
    : `<div class="card-no-img">${type === 'movie' ? FILM_SVG : TV_SVG}</div>`;
  const star = item.rating ? `<span class="card-star">★${item.rating}</span>` : '';
  d.innerHTML = `${img}
    <span class="card-badge ${type === 'movie' ? 'badge-movie' : 'badge-tv'}">${type}</span>
    <button class="card-add" title="Add to playlist">+pl</button>
    <div class="card-play"><div class="play-ring">${PLAY_SVG}</div></div>
    <div class="card-foot">
      <span class="card-name">${esc(item.title)}</span>
      <div class="card-meta"><span>${item.year || '—'}</span>${star}</div>
    </div>`;
  d.querySelector('.card-add').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentUser) { switchSection('profile'); return; }
    openPlPicker(item);
  });
  d.addEventListener('click', () => requireAuth(
    type === 'movie' ? embedMovie(item) : embedTv(item, 1, 1),
    item.title, item
  ));
  return d;
}

// ══ LOADERS ═══════════════════════════════════════════════════════
const BATCH = 5;
let moviesPage = 1, tvPage = 1, activeSection = 'movies';

async function loadGrid(grid, endpoint, type, startPage) {
  grid.innerHTML = '';
  const pageNums   = Array.from({ length: BATCH }, (_, i) => startPage + i);
  const slotGroups = pageNums.map(() =>
    Array.from({ length: 24 }).map(() => {
      const el = document.createElement('div');
      el.className = 'skel';
      grid.appendChild(el);
      return el;
    })
  );
  let knownTotal = pageNums[pageNums.length - 1];
  await Promise.all(pageNums.map(async (pageNum, groupIdx) => {
    const data  = await getJSON(`${LISTING_BASE}/${endpoint}/page-${pageNum}.json`).catch(() => null);
    const slots = slotGroups[groupIdx];
    if (!data) { slots.forEach(s => s.remove()); return; }
    if (data.total_pages > knownTotal) knownTotal = data.total_pages;
    data.items.forEach((item, i) => { if (slots[i]) slots[i].replaceWith(makeCard(item, type)); });
    slots.slice(data.items.length).forEach(s => s.remove());
  }));
  return knownTotal;
}

async function loadMovies(startPage = 1) {
  const totalPages = await loadGrid($('moviesGrid'), 'movies/latest', 'movie', startPage);
  const endPage = Math.min(startPage + BATCH - 1, totalPages);
  $('moviesPage').textContent = `${startPage}–${endPage} / ${totalPages}`;
  $('moviesPrev').disabled = startPage <= 1;
  $('moviesNext').disabled = endPage >= totalPages;
  moviesPage = startPage;
  scrollToContent();
}

async function loadTv(startPage = 1) {
  const totalPages = await loadGrid($('tvGrid'), 'tvshows/latest', 'tv', startPage);
  const endPage = Math.min(startPage + BATCH - 1, totalPages);
  $('tvPage').textContent = `${startPage}–${endPage} / ${totalPages}`;
  $('tvPrev').disabled = startPage <= 1;
  $('tvNext').disabled = endPage >= totalPages;
  tvPage = startPage;
  scrollToContent();
}

$('moviesPrev').addEventListener('click', () => loadMovies(Math.max(1, moviesPage - BATCH)));
$('moviesNext').addEventListener('click', () => loadMovies(moviesPage + BATCH));
$('tvPrev').addEventListener('click',     () => loadTv(Math.max(1, tvPage - BATCH)));
$('tvNext').addEventListener('click',     () => loadTv(tvPage + BATCH));

// ══ SECTIONS ══════════════════════════════════════════════════════
function switchSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $(`${name}Section`).classList.remove('hidden');
  document.querySelector(`[data-section="${name}"]`).classList.add('active');
  if (name === 'profile') {
    renderProfileSection();
  } else {
    activeSection = name;
    if (name === 'tv' && $('tvGrid').children.length === 0) loadTv(1);
  }
}

document.querySelectorAll('.tab').forEach(btn =>
  btn.addEventListener('click', () => switchSection(btn.dataset.section))
);

// ══ SEARCH ════════════════════════════════════════════════════════
const search = {
  query: '', allResults: [],
  movieMaxPages: 0, tvMaxPages: 0,
  nextMoviePage: 1, nextTvPage: 1,
  running: false, stopped: false, resultPage: 0,
};
const SEARCH_BATCH   = 1000;
const FETCH_CHUNK    = 100;
const RESULTS_PER_PG = 48;

$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (q) doSearch(q);
});

async function doSearch(q) {
  Object.assign(search, {
    query: q, allResults: [],
    movieMaxPages: 0, tvMaxPages: 0,
    nextMoviePage: 1, nextTvPage: 1,
    running: false, stopped: false, resultPage: 0,
  });
  $('searchQuery').textContent = q;
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('searchSection').classList.remove('hidden');
  $('searchPagerBar').classList.add('hidden');
  $('searchStopBtn').style.display = 'none';
  $('searchGrid').innerHTML = '';

  const isImdbId = /^tt\d+$/i.test(q);
  const isTmdbId = /^\d{5,}$/.test(q);
  if (isImdbId || isTmdbId) {
    setSearchStatus(`ID: ${q}`);
    $('searchGrid').innerHTML = '';
    $('searchGrid').appendChild(makeCard({ id: q, title: `${q} (movie)`, year: '', rating: '', poster_url: '', _type: 'movie' }, 'movie'));
    $('searchGrid').appendChild(makeCard({ id: q, title: `${q} (tv)`,    year: '', rating: '', poster_url: '', _type: 'tv'    }, 'tv'));
    return;
  }
  await runSearchBatch();
}

async function runSearchBatch() {
  if (search.running || search.stopped) return;
  search.running = true;
  const moviePages = pageRange(search.nextMoviePage, SEARCH_BATCH, search.movieMaxPages);
  const tvPages    = pageRange(search.nextTvPage,    SEARCH_BATCH, search.tvMaxPages);
  if (!moviePages.length && !tvPages.length) { search.running = false; finishSearch(); return; }
  const lower = search.query.toLowerCase();
  const scoreTitle = (title) => {
    const t = title.toLowerCase();
    if (t === lower) return 0;
    if (t.startsWith(lower)) return 1;
    if (t.includes(' ' + lower)) return 2;
    return 3;
  };
  async function streamEndpoint(endpoint, pages, type) {
    for (let i = 0; i < pages.length; i += FETCH_CHUNK) {
      if (search.stopped) break;
      const chunk     = pages.slice(i, i + FETCH_CHUNK);
      const chunkData = await Promise.all(chunk.map(p =>
        getJSON(`${LISTING_BASE}/${endpoint}/page-${p}.json`).catch(() => null)
      ));
      if (type === 'movie' && !search.movieMaxPages) search.movieMaxPages = chunkData.find(r => r)?.total_pages ?? 0;
      if (type === 'tv'    && !search.tvMaxPages)    search.tvMaxPages    = chunkData.find(r => r)?.total_pages ?? 0;
      const hits = chunkData.flatMap(r => r?.items ?? [])
        .filter(item => item.title.toLowerCase().includes(lower))
        .map(item => ({ ...item, _type: type }));
      if (hits.length > 0) {
        search.allResults.push(...hits);
        search.allResults.sort((a, b) => scoreTitle(a.title) - scoreTitle(b.title));
        renderSearchPage(search.resultPage);
      }
      const total = (search.movieMaxPages || 0) + (search.tvMaxPages || 0);
      setSearchStatus(`${search.allResults.length} found — scanning… ${total ? `(${total} pages total)` : ''}`, true);
    }
  }
  await Promise.all([
    streamEndpoint('movies/latest',  moviePages, 'movie'),
    streamEndpoint('tvshows/latest', tvPages,    'tv'),
  ]);
  search.nextMoviePage += moviePages.length;
  search.nextTvPage    += tvPages.length;
  search.running = false;
  const mDone = !moviePages.length || search.nextMoviePage > (search.movieMaxPages || Infinity);
  const tDone = !tvPages.length    || search.nextTvPage    > (search.tvMaxPages    || Infinity);
  if (mDone && tDone) finishSearch();
  else if (!search.stopped) setTimeout(runSearchBatch, 0);
}

function pageRange(start, batchSize, maxPages) {
  if (maxPages && start > maxPages) return [];
  const end = maxPages ? Math.min(start + batchSize - 1, maxPages) : start + batchSize - 1;
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function finishSearch() {
  search.stopped = true;
  const total = (search.movieMaxPages || 0) + (search.tvMaxPages || 0);
  if (!search.allResults.length) {
    setSearchStatus(`No results across ${total} pages — try an IMDB ID (tt…) or TMDB number`);
    $('searchGrid').innerHTML = '<p style="font-size:.72rem;color:var(--dim);padding:.5rem 0">Nothing found</p>';
  } else {
    setSearchStatus(`${search.allResults.length} result${search.allResults.length !== 1 ? 's' : ''} — ${total} pages scanned`);
  }
  $('searchStopBtn').style.display = 'none';
}

function setSearchStatus(msg, scanning = false) {
  $('searchStatus').textContent = msg;
  $('searchStopBtn').style.display = scanning ? '' : 'none';
}

function renderSearchPage(page) {
  search.resultPage = page;
  const total = search.allResults.length;
  if (!total) return;
  const totalPages = Math.ceil(total / RESULTS_PER_PG);
  const start      = page * RESULTS_PER_PG;
  const slice      = search.allResults.slice(start, start + RESULTS_PER_PG);
  $('searchPagerBar').classList.remove('hidden');
  $('searchResultCount').textContent = `${total} result${total !== 1 ? 's' : ''}`;
  $('searchPageNum').textContent     = `${page + 1} / ${totalPages}`;
  $('searchPrev').disabled           = page <= 0;
  $('searchNext').disabled           = page >= totalPages - 1;
  $('searchGrid').innerHTML = '';
  slice.forEach(i => $('searchGrid').appendChild(makeCard(i, i._type)));
  window.scrollTo({ top: $('searchSection').offsetTop - 60, behavior: 'smooth' });
}

$('searchStopBtn').addEventListener('click', () => { search.stopped = true; search.running = false; finishSearch(); });
$('searchPrev').addEventListener('click', () => renderSearchPage(search.resultPage - 1));
$('searchNext').addEventListener('click', () => renderSearchPage(search.resultPage + 1));
$('backBtn').addEventListener('click', () => { search.stopped = true; $('searchInput').value = ''; switchSection(activeSection); });

// ══ EXPORT / IMPORT ═══════════════════════════════════════════════
$('exportBtn').addEventListener('click', () => {
  if (!currentUser) return;
  const data = { userId: currentUser, exported: new Date().toISOString(), history: getHistory(), playlists: getPlaylists() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `jrs-movies-${currentUser}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported', true);
});

$('importInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  for (const file of files) {
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data.playlists)) {
        const existing = getPlaylists();
        data.playlists.forEach(pl => {
          const target = existing.find(p => p.name === pl.name);
          if (!target) { existing.push({ ...pl, id: Date.now().toString() + Math.random() }); }
          else { pl.items.forEach(item => { if (!target.items.find(i => i.id === item.id)) target.items.push(item); }); }
        });
        savePlaylists(existing);
      }
      if (Array.isArray(data.history) && currentUser) {
        const existing   = getHistory();
        const existingIds = new Set(existing.map(h => h.id));
        data.history.forEach(h => { if (!existingIds.has(h.id)) existing.push(h); });
        localStorage.setItem(historyKey(), JSON.stringify(existing.slice(0, 200)));
      }
    } catch (err) { console.warn('Import failed:', file.name, err); }
  }
  e.target.value = '';
  renderHistory();
  renderPlaylists();
  toast('Imported', true);
});

// ══ SCROLL SHADOW ═════════════════════════════════════════════════
window.addEventListener('scroll', () => {
  $('topbar').style.boxShadow = window.scrollY > 10 ? '0 2px 16px rgba(0,0,0,.6)' : '';
}, { passive: true });

// ══ INIT ══════════════════════════════════════════════════════════
loadMovies(1);

// ══ DEV PANEL (backtick / tilde while player is open) ════════════
const devPanel      = $('devPanel');
const playerOuter   = $('playerOuter');
const devIdInput    = $('devId');
const devTypeSelect = $('devType');
const devTvRow      = $('devTvRow');
const devSeasonInput  = $('devSeason');
const devEpisodeInput = $('devEpisode');
const devCustomUrl    = $('devCustomUrl');
const devInfo         = $('devInfo');
let devOpen = false;

function syncDevFromPlayer() {
  const src = $('playerIframe').src;
  if (!src) return;
  devCustomUrl.value = '';
  devInfo.textContent = src;
  const movieMatch = src.match(/\/embed\/movie\/([^?]+)/);
  const tvMatch    = src.match(/\/embed\/tv\/([^/]+)\/(\d+)\/(\d+)/);
  if (tvMatch) {
    devIdInput.value = tvMatch[1]; devTypeSelect.value = 'tv';
    devSeasonInput.value = tvMatch[2]; devEpisodeInput.value = tvMatch[3];
    devTvRow.classList.remove('hidden');
  } else if (movieMatch) {
    devIdInput.value = movieMatch[1]; devTypeSelect.value = 'movie';
    devTvRow.classList.add('hidden');
  }
}

function openDevPanel()  { devOpen = true;  devPanel.classList.remove('hidden'); playerOuter.classList.add('dev-open'); syncDevFromPlayer(); }
function closeDevPanel() { devOpen = false; devPanel.classList.add('hidden');    playerOuter.classList.remove('dev-open'); }
function toggleDevPanel() { devOpen ? closeDevPanel() : openDevPanel(); }

document.addEventListener('keydown', (e) => {
  if ((e.key === '`' || e.key === '~') && !$('playerModal').classList.contains('hidden')) {
    e.preventDefault(); toggleDevPanel();
  }
});

$('playerClose').addEventListener('click', () => closeDevPanel(), true);
$('devToggleBtn').addEventListener('click', toggleDevPanel);

devTypeSelect.addEventListener('change', () => devTvRow.classList.toggle('hidden', devTypeSelect.value !== 'tv'));

$('devApply').addEventListener('click', () => {
  const customUrl = devCustomUrl.value.trim();
  if (customUrl) { $('playerIframe').src = customUrl; devInfo.textContent = customUrl; return; }
  const mediaId = devIdInput.value.trim();
  if (!mediaId) return;
  const type = devTypeSelect.value, season = parseInt(devSeasonInput.value) || 1, episode = parseInt(devEpisodeInput.value) || 1;
  const url = type === 'tv'
    ? `${PLAYER_BASE}/embed/tv/${mediaId}/${season}/${episode}?primaryColor=${PCOLOR}`
    : `${PLAYER_BASE}/embed/movie/${mediaId}?primaryColor=${PCOLOR}`;
  $('playerIframe').src = url;
  $('playerTitle').textContent = type === 'tv' ? `${mediaId} — S${pad2(season)}E${pad2(episode)}` : mediaId;
  devInfo.textContent = url;
});

$('devNextEp').addEventListener('click',     () => { devEpisodeInput.value = (parseInt(devEpisodeInput.value) || 1) + 1; $('devApply').click(); });
$('devPrevEp').addEventListener('click',     () => { devEpisodeInput.value = Math.max(1, (parseInt(devEpisodeInput.value) || 1) - 1); $('devApply').click(); });
$('devNextSeason').addEventListener('click', () => { devSeasonInput.value = (parseInt(devSeasonInput.value) || 1) + 1; devEpisodeInput.value = 1; $('devApply').click(); });
$('devPrevSeason').addEventListener('click', () => { devSeasonInput.value = Math.max(1, (parseInt(devSeasonInput.value) || 1) - 1); devEpisodeInput.value = 1; $('devApply').click(); });

[devIdInput, devSeasonInput, devEpisodeInput, devCustomUrl].forEach(el =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('devApply').click(); })
);

// ══ DEFAULT STARTER PLAYLIST ══════════════════════════════════════
// Seeded once per user the first time they sign in.
const DEFAULT_PLAYLIST_ITEMS = [
  // ── Movies ───────────────────────────────────────────────────────
  { id: 'tt0468569', title: 'The Dark Knight',                        type: 'movie', year: '2008', poster_url: '' },
  { id: 'tt1375666', title: 'Inception',                              type: 'movie', year: '2010', poster_url: '' },
  { id: 'tt0816692', title: 'Interstellar',                           type: 'movie', year: '2014', poster_url: '' },
  { id: 'tt0111161', title: 'The Shawshank Redemption',               type: 'movie', year: '1994', poster_url: '' },
  { id: 'tt0110912', title: 'Pulp Fiction',                           type: 'movie', year: '1994', poster_url: '' },
  { id: 'tt0068646', title: 'The Godfather',                          type: 'movie', year: '1972', poster_url: '' },
  { id: 'tt0137523', title: 'Fight Club',                             type: 'movie', year: '1999', poster_url: '' },
  { id: 'tt0133093', title: 'The Matrix',                             type: 'movie', year: '1999', poster_url: '' },
  { id: 'tt0109830', title: 'Forrest Gump',                           type: 'movie', year: '1994', poster_url: '' },
  { id: 'tt0099685', title: 'Goodfellas',                             type: 'movie', year: '1990', poster_url: '' },
  { id: 'tt4154796', title: 'Avengers: Endgame',                      type: 'movie', year: '2019', poster_url: '' },
  { id: 'tt0499549', title: 'Avatar',                                 type: 'movie', year: '2009', poster_url: '' },
  { id: 'tt1160419', title: 'Dune',                                   type: 'movie', year: '2021', poster_url: '' },
  { id: 'tt1745960', title: 'Top Gun: Maverick',                      type: 'movie', year: '2022', poster_url: '' },
  { id: 'tt10872600',title: 'Spider-Man: No Way Home',                type: 'movie', year: '2021', poster_url: '' },
  { id: 'tt7286456', title: 'Joker',                                  type: 'movie', year: '2019', poster_url: '' },
  { id: 'tt2911666', title: 'John Wick',                              type: 'movie', year: '2014', poster_url: '' },
  { id: 'tt1392190', title: 'Mad Max: Fury Road',                     type: 'movie', year: '2015', poster_url: '' },
  { id: 'tt5052448', title: 'Get Out',                                type: 'movie', year: '2017', poster_url: '' },
  { id: 'tt6644200', title: 'A Quiet Place',                          type: 'movie', year: '2018', poster_url: '' },
  { id: 'tt8946378', title: 'Knives Out',                             type: 'movie', year: '2019', poster_url: '' },
  { id: 'tt3783958', title: 'La La Land',                             type: 'movie', year: '2016', poster_url: '' },
  { id: 'tt6751668', title: 'Parasite',                               type: 'movie', year: '2019', poster_url: '' },
  { id: 'tt6710474', title: 'Everything Everywhere All at Once',      type: 'movie', year: '2022', poster_url: '' },
  { id: 'tt15398776',title: 'Oppenheimer',                            type: 'movie', year: '2023', poster_url: '' },
  { id: 'tt1517268', title: 'Barbie',                                 type: 'movie', year: '2023', poster_url: '' },
  { id: 'tt0848228', title: 'The Avengers',                           type: 'movie', year: '2012', poster_url: '' },
  { id: 'tt3498820', title: 'Captain America: Civil War',             type: 'movie', year: '2016', poster_url: '' },
  { id: 'tt1825683', title: 'Black Panther',                          type: 'movie', year: '2018', poster_url: '' },
  { id: 'tt0371746', title: 'Iron Man',                               type: 'movie', year: '2008', poster_url: '' },
  { id: 'tt2015381', title: 'Guardians of the Galaxy',                type: 'movie', year: '2014', poster_url: '' },
  { id: 'tt3501632', title: 'Thor: Ragnarok',                         type: 'movie', year: '2017', poster_url: '' },
  { id: 'tt2278388', title: 'The Grand Budapest Hotel',               type: 'movie', year: '2014', poster_url: '' },
  { id: 'tt0107290', title: 'Jurassic Park',                          type: 'movie', year: '1993', poster_url: '' },
  { id: 'tt0120338', title: 'Titanic',                                type: 'movie', year: '1997', poster_url: '' },
  { id: 'tt0110357', title: 'The Lion King',                          type: 'movie', year: '1994', poster_url: '' },
  { id: 'tt4154756', title: 'Avengers: Infinity War',                 type: 'movie', year: '2018', poster_url: '' },
  { id: 'tt1211837', title: 'Doctor Strange',                         type: 'movie', year: '2016', poster_url: '' },
  { id: 'tt0478970', title: 'Ant-Man',                                type: 'movie', year: '2015', poster_url: '' },
  { id: 'tt9603212', title: 'Mission: Impossible – Dead Reckoning',   type: 'movie', year: '2023', poster_url: '' },
  // ── TV Shows ─────────────────────────────────────────────────────
  { id: 'tt0903747', title: 'Breaking Bad',                           type: 'tv',    year: '2008', poster_url: '' },
  { id: 'tt0944947', title: 'Game of Thrones',                        type: 'tv',    year: '2011', poster_url: '' },
  { id: 'tt0386676', title: 'The Office',                             type: 'tv',    year: '2005', poster_url: '' },
  { id: 'tt4574334', title: 'Stranger Things',                        type: 'tv',    year: '2016', poster_url: '' },
  { id: 'tt7366338', title: 'Chernobyl',                              type: 'tv',    year: '2019', poster_url: '' },
  { id: 'tt3581920', title: 'The Last of Us',                         type: 'tv',    year: '2023', poster_url: '' },
  { id: 'tt11198330',title: 'House of the Dragon',                    type: 'tv',    year: '2022', poster_url: '' },
  { id: 'tt13443470',title: 'Wednesday',                              type: 'tv',    year: '2022', poster_url: '' },
  { id: 'tt10919420',title: 'Squid Game',                             type: 'tv',    year: '2021', poster_url: '' },
  { id: 'tt4786824', title: 'The Crown',                              type: 'tv',    year: '2016', poster_url: '' },
];

// Seed the starter playlist the first time a user ever logs in.
// Uses a per-user flag in localStorage so it only runs once.
function seedDefaultPlaylistIfNew(userId) {
  const seededFlag = `vs_seeded_${userId}`;
  if (localStorage.getItem(seededFlag)) return;

  const starterPlaylist = {
    id:    'starter',
    name:  'Popular Picks',
    items: DEFAULT_PLAYLIST_ITEMS,
  };

  const existing = getPlaylists();
  if (!existing.find(p => p.id === 'starter')) {
    existing.unshift(starterPlaylist);
    savePlaylists(existing);
  }

  localStorage.setItem(seededFlag, '1');
}
