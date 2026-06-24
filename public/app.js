const $ = (s) => document.querySelector(s);
const api = {
  get: (u, options = {}) => fetch(u, options).then((r) => r.json()),
  post: (u, b, headers = {}) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) }).then((r) => r.json()),
  patch: (u, b, headers = {}) => fetch(u, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) }).then((r) => r.json()),
  del: (u) => fetch(u, { method: 'DELETE' }).then((r) => r.json())
};

const state = {
  user: JSON.parse(localStorage.getItem('ak_user') || 'null'),
  tracker: JSON.parse(localStorage.getItem('ak_tracker') || '[]'),
  watchlists: JSON.parse(localStorage.getItem('ak_watchlists') || '[]'),
  notifications: [],
  searchResults: [],
  home: null,
  activeTab: 'Home',
  animeDetails: null,
  schedule: []
};

const tabs = ['Home', 'Auth', 'Search', 'Details', 'Schedule', 'Tracker', 'Watchlists', 'Community', 'Profile', 'Settings', 'Admin'];
const tabsEl = $('#tabs');
const viewEl = $('#view');

function saveOffline() {
  localStorage.setItem('ak_user', JSON.stringify(state.user));
  localStorage.setItem('ak_tracker', JSON.stringify(state.tracker));
  localStorage.setItem('ak_watchlists', JSON.stringify(state.watchlists));
}

function toast(msg) { alert(msg); }
function authHeader() { return state.user ? { 'x-user-id': state.user.id } : {}; }

function animeCard(a) {
  return `<div class="anime"><img src="${a.poster || ''}" alt="${a.title}"><div><h3>${a.title}</h3><div class="meta">⭐ ${a.score ?? 'N/A'} • ${a.episodes ?? '?'} eps • ${a.status || 'Unknown'}</div><div class="meta">${(a.genres || []).slice(0,3).join(', ')}</div><div class="actions"><button class="btn" data-add-tracker='${JSON.stringify({ animeId: a.id, title: a.title, poster: a.poster }).replaceAll("'", '&apos;')}'>+ Tracker</button><button class="btn" data-add-watch='${JSON.stringify({ animeId: a.id, title: a.title, poster: a.poster }).replaceAll("'", '&apos;')}'>+ Watchlist</button><button class="btn" data-open='${a.id}'>Details</button></div></div></div>`;
}

function bindAnimeActions() {
  document.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openDetails(b.dataset.open));
  document.querySelectorAll('[data-add-tracker]').forEach((b) => b.onclick = () => addTracker(JSON.parse(b.dataset.addTracker)));
  document.querySelectorAll('[data-add-watch]').forEach((b) => b.onclick = () => addToFirstWatchlist(JSON.parse(b.dataset.addWatch)));
}

async function ensureUser() {
  if (!state.user) throw new Error('Please login/guest first.');
}

async function loadHome() {
  state.home = await api.get('/api/home');
}

async function loadTracker() {
  if (!state.user) return;
  const data = await api.get(`/api/users/${state.user.id}/tracker`);
  state.tracker = data.entries || [];
  saveOffline();
}

async function loadWatchlists() {
  if (!state.user) return;
  const data = await api.get(`/api/users/${state.user.id}/watchlists`);
  state.watchlists = data.watchlists || [];
  saveOffline();
}

async function loadNotifications() {
  if (!state.user) return;
  const data = await api.get(`/api/users/${state.user.id}/notifications`);
  state.notifications = data.notifications || [];
}

async function addTracker(item) {
  try {
    await ensureUser();
    const out = await api.post(`/api/users/${state.user.id}/tracker`, { ...item, status: 'watching', progress: 1, rating: 0, notes: '' });
    if (out.error) return toast(out.error);
    await loadTracker();
    render();
  } catch (e) { toast(e.message); }
}

async function addToFirstWatchlist(item) {
  try {
    await ensureUser();
    if (!state.watchlists.length) {
      const created = await api.post(`/api/users/${state.user.id}/watchlists`, { name: 'My First Watchlist' });
      if (created.error) return toast(created.error);
      state.watchlists.push(created.watchlist);
    }
    const first = state.watchlists[0];
    const items = [...first.items.filter((i) => i.animeId !== item.animeId), item];
    await api.patch(`/api/users/${state.user.id}/watchlists/${first.id}`, { items });
    await loadWatchlists();
    render();
  } catch (e) { toast(e.message); }
}

async function openDetails(id) {
  const data = await api.get(`/api/anime/${id}`);
  if (data.error) return toast(data.error);
  state.animeDetails = data;
  state.activeTab = 'Details';
  render();
}

async function performSearch(query = '') {
  const genre = $('#genreFilter')?.value || '';
  const status = $('#statusFilter')?.value || '';
  const rating = $('#ratingFilter')?.value || '';
  const year = $('#yearFilter')?.value || '';
  const season = $('#seasonFilter')?.value || '';
  const params = new URLSearchParams({ q: query || $('#searchInput')?.value || '' , genre, status, rating, year, season });
  const data = await api.get(`/api/anime/search?${params.toString()}`);
  state.searchResults = data.results || [];
  render();
}

async function loadSchedule(filter = 'today', language = 'all') {
  const params = new URLSearchParams({ filter, language });
  const data = await api.get(`/api/schedule?${params.toString()}`);
  state.schedule = data.results || [];
}

async function authAction(type) {
  if (type === 'guest') {
    const out = await api.post('/api/auth/guest', {});
    if (out.error) return toast(out.error);
    state.user = out.user;
  } else if (type === 'register') {
    const payload = {
      username: $('#username').value,
      email: $('#email').value,
      password: $('#password').value,
      avatar: $('#avatar').value
    };
    const out = await api.post('/api/auth/register', payload);
    if (out.error) return toast(out.error);
    state.user = out.user;
  } else {
    const out = await api.post('/api/auth/login', { email: $('#email').value, password: $('#password').value });
    if (out.error) return toast(out.error);
    state.user = out.user;
  }
  saveOffline();
  await Promise.all([loadTracker(), loadWatchlists(), loadNotifications()]);
  state.activeTab = 'Home';
  render();
}

function section(title, arr = []) {
  return `<div class="card"><h2>${title}</h2><div class="list">${arr.map(animeCard).join('') || '<div class="meta">No items found.</div>'}</div></div>`;
}

function renderHome() {
  const h = state.home || { trendingThisWeek: [], seasonalHighlights: [], upcomingAnime: [], mostPopular: [], hiddenGems: [] };
  return `<div class="grid">${[
    section('Continue Watching', state.tracker.map((t) => ({ id: t.animeId, title: t.title, poster: t.poster, score: t.rating, episodes: t.progress, status: t.status, genres: [] }))),
    section('Trending This Week', h.trendingThisWeek),
    section('Seasonal Highlights', h.seasonalHighlights),
    section('Upcoming Anime', h.upcomingAnime),
    section('Most Popular', h.mostPopular),
    section('Hidden Gems', h.hiddenGems)
  ].join('')}</div>`;
}

function renderAuth() {
  return `<div class="card"><h2>Authentication</h2><div class="grid"><input id="username" placeholder="Username"><input id="email" placeholder="Email"><input id="password" type="password" placeholder="Password"><input id="avatar" placeholder="Avatar URL"></div><div class="actions" style="margin-top:10px"><button class="btn" id="registerBtn">Register</button><button class="btn" id="loginBtn">Login</button><button class="btn" id="guestBtn">Guest Mode</button><button class="btn" id="logoutBtn">Logout</button></div><div class="meta">Remember login and offline mode are enabled with LocalStorage sync.</div></div>`;
}

function renderSearch() {
  return `<div class="card"><h2>Anime Search (Jikan API)</h2><div class="grid"><input id="searchInput" placeholder="Live search anime"><input id="yearFilter" placeholder="Year"><select id="seasonFilter"><option value="">Any season</option><option>winter</option><option>spring</option><option>summer</option><option>fall</option></select><input id="genreFilter" placeholder="Genre ID"><select id="statusFilter"><option value="">Any status</option><option>airing</option><option>complete</option><option>upcoming</option></select><select id="ratingFilter"><option value="">Any rating</option><option>g</option><option>pg</option><option>pg13</option><option>r17</option></select></div><div class="actions" style="margin:10px 0"><button class="btn" id="searchBtn">Search</button></div><div class="list">${state.searchResults.map(animeCard).join('')}</div></div>`;
}

function renderDetails() {
  const d = state.animeDetails;
  if (!d) return '<div class="card">Open anime details from Home/Search.</div>';
  return `<div class="grid"><div class="card"><h2>${d.anime.title}</h2><img src="${d.anime.banner || d.anime.poster}" style="width:100%;max-height:320px;object-fit:cover;border-radius:12px"><p>${d.anime.synopsis || ''}</p><div class="meta">Genres: ${(d.anime.genres || []).join(', ')} | Studios: ${(d.anime.studios || []).join(', ')}</div><div class="meta">Score ${d.anime.score ?? 'N/A'} | Popularity ${d.anime.popularity ?? 'N/A'} | Aired ${d.anime.aired || 'N/A'}</div><div class="actions" style="margin-top:8px"><button class="btn" data-add-tracker='${JSON.stringify({ animeId: d.anime.id, title: d.anime.title, poster: d.anime.poster }).replaceAll("'", '&apos;')}'>+ Tracker</button><button class="btn" data-add-watch='${JSON.stringify({ animeId: d.anime.id, title: d.anime.title, poster: d.anime.poster }).replaceAll("'", '&apos;')}'>+ Watchlist</button>${d.anime.trailer ? `<a class="btn" href="${d.anime.trailer}" target="_blank">Trailer</a>` : ''}</div></div><div class="card"><h3>Characters & Voice Actors</h3><div class="list">${d.characters.map((c) => `<div class="anime"><img src="${c.image || ''}"><div><b>${c.name}</b><div class="meta">${c.role}</div><div class="meta">${(c.voiceActors || []).map((v) => `${v.name} (${v.language})`).join(', ')}</div></div></div>`).join('')}</div><h3>Recommendations</h3><div class="list">${d.recommendations.map((r) => `<div class="anime"><img src="${r.poster || ''}"><div><b>${r.title}</b><div class="meta">Votes: ${r.votes}</div><button class="btn" data-open="${r.id}">Open</button></div></div>`).join('')}</div></div></div>`;
}

function renderSchedule() {
  return `<div class="card"><h2>Anime Schedule</h2><div class="actions"><select id="scheduleFilter"><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="season">Upcoming Season</option></select><select id="languageFilter"><option value="all">All Languages</option><option value="japanese">Japanese</option><option value="english">English</option><option value="hindi">Hindi</option><option value="bengali">Bengali</option></select><button class="btn" id="loadScheduleBtn">Load</button></div><div class="list">${state.schedule.map(animeCard).join('')}</div></div>`;
}

function renderTracker() {
  return `<div class="card"><h2>Anime Tracker</h2><div class="list">${state.tracker.map((t) => `<div class="anime"><img src="${t.poster || ''}"><div><b>${t.title}</b><div class="meta">Status: ${t.status} | Progress: ${t.progress} | Rating: ${t.rating}</div><input data-progress="${t.id}" type="number" min="0" value="${t.progress}"><select data-status="${t.id}"><option ${t.status==='watching'?'selected':''} value="watching">Watching</option><option ${t.status==='completed'?'selected':''} value="completed">Completed</option><option ${t.status==='dropped'?'selected':''} value="dropped">Dropped</option><option ${t.status==='on_hold'?'selected':''} value="on_hold">On Hold</option><option ${t.status==='plan_to_watch'?'selected':''} value="plan_to_watch">Plan To Watch</option><option ${t.status==='favorites'?'selected':''} value="favorites">Favorites</option></select><div class="actions"><button class="btn" data-save-entry="${t.id}">Save</button><button class="btn" data-del-entry="${t.id}">Remove</button></div></div></div>`).join('') || '<div class="meta">No tracker entries.</div>'}</div></div>`;
}

function renderWatchlists() {
  return `<div class="card"><h2>Watchlists</h2><div class="actions"><input id="watchlistName" placeholder="Create watchlist (Romance, Action, Top 10...)"/><button class="btn" id="createWatchlistBtn">Create</button></div><div class="list">${state.watchlists.map((w) => `<div class="card"><h3>${w.name}</h3><div class="meta">${w.items.length} anime</div><div class="actions"><button class="btn" data-rename-watch="${w.id}">Rename</button><button class="btn" data-share-watch="${w.id}">Share</button><button class="btn" data-del-watch="${w.id}">Delete</button></div><div>${w.items.map((i) => `<span class="badge">${i.title}</span>`).join(' ')}</div></div>`).join('')}</div></div>`;
}

function renderCommunity() {
  return `<div class="card"><h2>Community</h2><textarea id="postContent" placeholder="Share your thoughts..."></textarea><label><input id="spoilerToggle" type="checkbox"> Spoiler tag</label><div class="actions"><button class="btn" id="postBtn">Post</button></div><div id="posts" class="list"></div></div>`;
}

function renderProfile() {
  if (!state.user) return '<div class="card">Please login first.</div>';
  return `<div class="card" id="profileCard"><h2>Profile</h2><div class="meta">Loading...</div></div>`;
}

function renderSettings() {
  return `<div class="card"><h2>Settings</h2><div class="grid"><select id="themeSetting"><option value="amoled">AMOLED</option><option value="dark">Dark</option></select><select id="languageSetting"><option value="en">English</option><option value="jp">Japanese</option><option value="hi">Hindi</option><option value="bn">Bengali</option></select><select id="privacySetting"><option value="public">Public</option><option value="private">Private</option></select><label><input id="notifySetting" type="checkbox" checked> Enable Notifications</label></div><div class="actions"><button class="btn" id="saveSettingsBtn">Save Settings</button><button class="btn" id="exportBtn">Export Data</button><button class="btn" id="importBtn">Import Data</button></div><input id="importInput" type="file" class="hidden"></div>`;
}

function renderAdmin() {
  return `<div class="card"><h2>Admin Panel</h2><button class="btn" id="loadAdminBtn">Load Dashboard</button><div id="adminResult" class="meta"></div></div>`;
}

async function renderCommunityPosts() {
  const data = await api.get('/api/community/posts');
  const posts = data.posts || [];
  const postsEl = $('#posts');
  if (!postsEl) return;
  postsEl.innerHTML = posts.map((p) => `<div class="card"><b>${p.username}</b> ${p.spoiler ? '<span class="badge">Spoiler</span>' : ''}<p>${p.content}</p><div class="actions"><button class="btn" data-like="${p.id}">Like (${p.likes.length})</button><input placeholder="Reply..." data-comment-input="${p.id}"><button class="btn" data-comment="${p.id}">Reply</button></div><div class="meta">${p.comments.map((c) => `${c.username}: ${c.content}`).join('<br>')}</div></div>`).join('');
  document.querySelectorAll('[data-like]').forEach((b) => b.onclick = async () => { if (!state.user) return toast('Login required'); await api.post(`/api/community/posts/${b.dataset.like}/like`, {}, authHeader()); await renderCommunityPosts(); });
  document.querySelectorAll('[data-comment]').forEach((b) => b.onclick = async () => { if (!state.user) return toast('Login required'); const input = document.querySelector(`[data-comment-input="${b.dataset.comment}"]`); await api.post(`/api/community/posts/${b.dataset.comment}/comments`, { content: input.value }, authHeader()); input.value = ''; await renderCommunityPosts(); });
}

function bindStaticEvents() {
  $('#globalSearch').oninput = (e) => { if (e.target.value.length >= 2) { state.activeTab = 'Search'; performSearch(e.target.value); } };
  $('#notifyBtn').onclick = () => { state.activeTab = 'Profile'; render(); toast(`${state.notifications.filter((n) => !n.read).length} unread notifications`); };
  $('#profileBtn').onclick = () => { state.activeTab = 'Profile'; render(); };
}

async function render() {
  tabsEl.innerHTML = tabs.map((t) => `<button class="chip ${state.activeTab === t ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('');
  tabsEl.querySelectorAll('[data-tab]').forEach((b) => b.onclick = async () => { state.activeTab = b.dataset.tab; if (state.activeTab === 'Schedule') await loadSchedule(); render(); });

  const views = {
    Home: renderHome,
    Auth: renderAuth,
    Search: renderSearch,
    Details: renderDetails,
    Schedule: renderSchedule,
    Tracker: renderTracker,
    Watchlists: renderWatchlists,
    Community: renderCommunity,
    Profile: renderProfile,
    Settings: renderSettings,
    Admin: renderAdmin
  };
  viewEl.innerHTML = views[state.activeTab]();

  bindAnimeActions();

  if ($('#registerBtn')) $('#registerBtn').onclick = () => authAction('register');
  if ($('#loginBtn')) $('#loginBtn').onclick = () => authAction('login');
  if ($('#guestBtn')) $('#guestBtn').onclick = () => authAction('guest');
  if ($('#logoutBtn')) $('#logoutBtn').onclick = () => { state.user = null; saveOffline(); render(); };
  if ($('#searchBtn')) $('#searchBtn').onclick = () => performSearch();
  if ($('#searchInput')) $('#searchInput').oninput = (e) => e.target.value.length > 1 && performSearch(e.target.value);
  if ($('#loadScheduleBtn')) $('#loadScheduleBtn').onclick = async () => { await loadSchedule($('#scheduleFilter').value, $('#languageFilter').value); render(); };

  document.querySelectorAll('[data-save-entry]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.saveEntry;
    const progress = document.querySelector(`[data-progress="${id}"]`).value;
    const status = document.querySelector(`[data-status="${id}"]`).value;
    await api.patch(`/api/users/${state.user.id}/tracker/${id}`, { progress: Number(progress), status });
    await loadTracker();
    render();
  });

  document.querySelectorAll('[data-del-entry]').forEach((b) => b.onclick = async () => {
    await api.del(`/api/users/${state.user.id}/tracker/${b.dataset.delEntry}`);
    await loadTracker();
    render();
  });

  if ($('#createWatchlistBtn')) $('#createWatchlistBtn').onclick = async () => {
    if (!state.user) return toast('Login first');
    const name = $('#watchlistName').value.trim();
    if (!name) return toast('Enter watchlist name');
    const out = await api.post(`/api/users/${state.user.id}/watchlists`, { name });
    if (out.error) return toast(out.error);
    await loadWatchlists();
    render();
  };

  document.querySelectorAll('[data-rename-watch]').forEach((b) => b.onclick = async () => {
    const name = prompt('New watchlist name:');
    if (!name) return;
    await api.patch(`/api/users/${state.user.id}/watchlists/${b.dataset.renameWatch}`, { name });
    await loadWatchlists();
    render();
  });

  document.querySelectorAll('[data-share-watch]').forEach((b) => b.onclick = async () => {
    const target = state.watchlists.find((w) => String(w.id) === String(b.dataset.shareWatch));
    const payload = `${location.origin}/?watchlist=${encodeURIComponent(target.name)}`;
    await navigator.clipboard.writeText(payload);
    toast('Watchlist link copied');
  });

  document.querySelectorAll('[data-del-watch]').forEach((b) => b.onclick = async () => {
    await api.del(`/api/users/${state.user.id}/watchlists/${b.dataset.delWatch}`);
    await loadWatchlists();
    render();
  });

  if ($('#postBtn')) $('#postBtn').onclick = async () => {
    if (!state.user) return toast('Login first');
    const content = $('#postContent').value.trim();
    if (!content) return toast('Write something');
    await api.post('/api/community/posts', { content, spoiler: $('#spoilerToggle').checked }, authHeader());
    $('#postContent').value = '';
    await renderCommunityPosts();
  };

  if ($('#profileCard') && state.user) {
    const data = await api.get(`/api/users/${state.user.id}/profile`);
    $('#profileCard').innerHTML = `<h2>${data.user.username}</h2><div class="meta">${data.user.email}</div><p>${data.user.bio || 'No bio yet.'}</p><div class="grid"><div class="card">Anime Count: ${data.stats.animeCount}</div><div class="card">Watching: ${data.stats.watchingCount}</div><div class="card">Completed: ${data.stats.completedCount}</div><div class="card">Completion Rate: ${data.stats.completionRate}%</div><div class="card">Watch Time: ${data.stats.watchTime} mins</div><div class="card">Badges: ${(data.user.achievements || []).join(', ') || 'None'}</div></div>`;
  }

  if ($('#saveSettingsBtn')) $('#saveSettingsBtn').onclick = async () => {
    if (!state.user) return toast('Login first');
    const payload = {
      theme: $('#themeSetting').value,
      language: $('#languageSetting').value,
      privacy: $('#privacySetting').value,
      notifications: $('#notifySetting').checked
    };
    const out = await api.patch(`/api/users/${state.user.id}/settings`, payload);
    if (out.error) return toast(out.error);
    toast('Settings saved');
  };

  if ($('#exportBtn')) $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ user: state.user, tracker: state.tracker, watchlists: state.watchlists }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'anime-keep-export.json';
    a.click();
  };

  if ($('#importBtn')) $('#importBtn').onclick = () => $('#importInput').click();
  if ($('#importInput')) $('#importInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (data.user) state.user = data.user;
    if (data.tracker) state.tracker = data.tracker;
    if (data.watchlists) state.watchlists = data.watchlists;
    saveOffline();
    render();
  };

  if ($('#loadAdminBtn')) $('#loadAdminBtn').onclick = async () => {
    if (!state.user) return toast('Login first');
    const data = await api.get('/api/admin/dashboard', { headers: authHeader() });
    $('#adminResult').textContent = data.error ? data.error : JSON.stringify(data);
  };

  if (state.activeTab === 'Community') await renderCommunityPosts();
}

async function init() {
  bindStaticEvents();
  await loadHome();
  if (state.user) await Promise.all([loadTracker(), loadWatchlists(), loadNotifications()]);
  render();
}

init().catch((e) => { viewEl.innerHTML = `<div class="card">Failed to initialize app: ${e.message}</div>`; });
