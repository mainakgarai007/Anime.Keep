import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dbPath = path.join(rootDir, 'data', 'db.json');
const JIKAN_BASE = 'https://api.jikan.moe/v4';
const cache = new Map();
const MINUTES_PER_EPISODE = 24;
const MIN_HIDDEN_GEM_SCORE = 8;
const MAX_HIDDEN_GEM_MEMBERS = 200000;
const SEASONS = new Set(['winter', 'spring', 'summer', 'fall']);
const requestWindowMs = 60 * 1000;
const defaultRateLimitMax = 120;
const strictRateLimitMax = 20;
const rateBuckets = new Map();

const defaultDb = {
  users: [],
  trackerEntries: [],
  watchlists: [],
  communityPosts: [],
  notifications: [],
  sessions: [],
  counters: { user: 1, tracker: 1, watchlist: 1, post: 1, comment: 1, notification: 1 }
};

const safe = async (promise, fallback) => {
  try {
    return await promise;
  } catch {
    return fallback;
  }
};

async function ensureDb() {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const exists = await safe(fs.access(dbPath), null);
  if (!exists) await fs.writeFile(dbPath, JSON.stringify(defaultDb, null, 2));
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, 'utf-8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

const normalizeAnime = (a) => ({
  id: a.mal_id,
  title: a.title,
  titleEnglish: a.title_english,
  poster: a.images?.webp?.image_url || a.images?.jpg?.image_url || '',
  banner: a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || '',
  score: a.score,
  episodes: a.episodes,
  status: a.status,
  synopsis: a.synopsis,
  year: a.year,
  season: a.season,
  genres: (a.genres || []).map((g) => g.name),
  studios: (a.studios || []).map((s) => s.name),
  popularity: a.popularity,
  members: a.members,
  trailer: a.trailer?.url || a.trailer?.embed_url || null,
  aired: a.aired?.string || null
});

async function cachedFetchJson(url, ttlMs = 1000 * 60 * 10) {
  const now = Date.now();
  const key = url;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Jikan error ${response.status}`);
  const value = await response.json();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

async function fetchJikan(pathname, query = {}, fallback = { data: [] }) {
  if (!/^\/[a-z0-9/_-]+$/i.test(pathname)) return fallback;
  const url = new URL(`${JIKAN_BASE}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return safe(cachedFetchJson(url.toString()), fallback);
}

function getUser(db, userId) {
  return db.users.find((u) => String(u.id) === String(userId));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const calculated = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
}

function issueToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  db.sessions.push({ token, userId, expiresAt });
  return token;
}

function authUser(req, db) {
  const rawAuth = req.headers.authorization || '';
  const token = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7) : req.headers['x-auth-token'];
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token && s.expiresAt > Date.now());
  return session ? getUser(db, session.userId) : null;
}

function buildRateLimiter(maxRequests = defaultRateLimitMax) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}:${req.method}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + requestWindowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + requestWindowMs;
    }

    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Please retry later.' });
    next();
  };
}

async function requireAuth(req, res, next) {
  const db = await readDb();
  const user = authUser(req, db);
  if (!user) return res.status(401).json({ error: 'Login required' });
  req.auth = { user, db };
  next();
}

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));
  app.use('/api', buildRateLimiter());

  app.get('/api/health', async (_req, res) => {
    const db = await readDb();
    res.json({ ok: true, users: db.users.length, uptime: process.uptime() });
  });

  app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, avatar } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, password are required.' });
    const db = await readDb();
    if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists.' });
    const id = db.counters.user++;
    const user = {
      id,
      username,
      email,
      password: hashPassword(password),
      avatar: avatar || '',
      bio: '',
      role: email.endsWith('@admin.keep') ? 'admin' : 'user',
      favoriteAnime: [],
      achievements: [],
      settings: { theme: 'amoled', language: 'en', notifications: true, privacy: 'public' },
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    const token = issueToken(db, user.id);
    await writeDb(db);
    res.json({ user: { ...user, password: undefined }, token });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const db = await readDb();
    const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
    if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = issueToken(db, user.id);
    await writeDb(db);
    res.json({ user: { ...user, password: undefined }, token });
  });

  app.post('/api/auth/guest', async (_req, res) => {
    const db = await readDb();
    const id = db.counters.user++;
    const user = {
      id,
      username: `Guest-${id}`,
      email: `guest-${id}@anime.keep`,
      password: hashPassword(crypto.randomBytes(8).toString('hex')),
      avatar: '',
      bio: 'Guest mode user',
      role: 'user',
      favoriteAnime: [],
      achievements: ['Guest Explorer'],
      settings: { theme: 'amoled', language: 'en', notifications: true, privacy: 'private' },
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    const token = issueToken(db, user.id);
    await writeDb(db);
    res.json({ user: { ...user, password: undefined }, token });
  });

  app.get('/api/users/:id/profile', async (req, res) => {
    const db = await readDb();
    const user = getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const entries = db.trackerEntries.filter((t) => String(t.userId) === String(user.id));
    const completed = entries.filter((e) => e.status === 'completed').length;
    const watching = entries.filter((e) => e.status === 'watching').length;
    const watchTime = entries.reduce((sum, e) => sum + Number(e.progress || 0) * MINUTES_PER_EPISODE, 0);
    res.json({
      user: { ...user, password: undefined },
      stats: {
        animeCount: entries.length,
        watchingCount: watching,
        completedCount: completed,
        completionRate: entries.length ? Math.round((completed / entries.length) * 100) : 0,
        watchTime
      }
    });
  });

  app.patch('/api/users/:id/settings', async (req, res) => {
    const db = await readDb();
    const user = getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.settings = { ...user.settings, ...(req.body || {}) };
    await writeDb(db);
    res.json({ settings: user.settings });
  });

  app.get('/api/home', async (_req, res) => {
    const [trending, seasonal, upcoming, top] = await Promise.all([
      fetchJikan('/top/anime', { filter: 'airing', limit: 10 }),
      fetchJikan('/seasons/now', { limit: 10 }),
      fetchJikan('/seasons/upcoming', { limit: 10 }),
      fetchJikan('/top/anime', { limit: 10 })
    ]);

    res.json({
      continueWatching: [],
      trendingThisWeek: (trending.data || []).map(normalizeAnime),
      seasonalHighlights: (seasonal.data || []).map(normalizeAnime),
      upcomingAnime: (upcoming.data || []).map(normalizeAnime),
      mostPopular: (top.data || []).map(normalizeAnime),
      hiddenGems: (top.data || [])
        .filter((a) => a.score >= MIN_HIDDEN_GEM_SCORE && (a.members || 0) < MAX_HIDDEN_GEM_MEMBERS)
        .slice(0, 10)
        .map(normalizeAnime)
    });
  });

  app.get('/api/anime/search', async (req, res) => {
    const {
      q = '', genre = '', status = '', rating = '', year = '', season = '', page = '1', limit = '12'
    } = req.query;

    const params = new URLSearchParams({ q: String(q), page: String(page), limit: String(limit), sfw: 'true' });
    if (genre) params.set('genres', String(genre));
    if (status) params.set('status', String(status));
    if (rating) params.set('rating', String(rating));
    if (year) params.set('start_date', `${year}-01-01`);
    const parsedYear = Number(year);
    const safeSeason = String(season || '').toLowerCase();
    if (safeSeason && parsedYear && SEASONS.has(safeSeason)) {
      const data = await fetchJikan(`/seasons/${parsedYear}/${safeSeason}`, {}, { data: [] });
      return res.json({ results: (data.data || []).map(normalizeAnime) });
    }

    const data = await fetchJikan('/anime', Object.fromEntries(params.entries()), { data: [] });
    res.json({ results: (data.data || []).map(normalizeAnime) });
  });

  app.get('/api/anime/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid anime id' });
    const [anime, chars, recs] = await Promise.all([
      fetchJikan(`/anime/${Number(id)}/full`, {}, { data: null }),
      fetchJikan(`/anime/${Number(id)}/characters`, {}, { data: [] }),
      fetchJikan(`/anime/${Number(id)}/recommendations`, {}, { data: [] })
    ]);
    if (!anime.data) return res.status(404).json({ error: 'Anime not found' });
    res.json({
      anime: normalizeAnime(anime.data),
      characters: (chars.data || []).slice(0, 12).map((c) => ({
        name: c.character?.name,
        role: c.role,
        image: c.character?.images?.jpg?.image_url,
        voiceActors: (c.voice_actors || []).slice(0, 2).map((v) => ({ name: v.person?.name, language: v.language }))
      })),
      recommendations: (recs.data || []).slice(0, 12).map((r) => ({
        id: r.entry?.mal_id,
        title: r.entry?.title,
        poster: r.entry?.images?.jpg?.image_url,
        votes: r.votes
      }))
    });
  });

  app.get('/api/schedule', async (req, res) => {
    const { filter = 'today', language = 'all' } = req.query;
    if (filter === 'month' || filter === 'season') {
      const now = new Date();
      const year = now.getUTCFullYear();
      const season = ['winter', 'spring', 'summer', 'fall'][Math.floor(now.getUTCMonth() / 3)];
      const seasonal = await fetchJikan(`/seasons/${year}/${season}`, {}, { data: [] });
      return res.json({ filter, language, results: (seasonal.data || []).map(normalizeAnime) });
    }
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const now = new Date();
    const dayIndex = filter === 'tomorrow' ? (now.getUTCDay() + 1) % 7 : now.getUTCDay();
    const day = days[(dayIndex + 6) % 7];
    const data = await fetchJikan('/schedules', { filter: day, kids: false, sfw: true }, { data: [] });
    res.json({ filter, language, results: (data.data || []).map(normalizeAnime) });
  });

  app.get('/api/users/:id/tracker', async (req, res) => {
    const db = await readDb();
    res.json({ entries: db.trackerEntries.filter((t) => String(t.userId) === String(req.params.id)) });
  });

  app.post('/api/users/:id/tracker', async (req, res) => {
    const db = await readDb();
    const user = getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { animeId, title, poster = '', status = 'plan_to_watch', progress = 0, rating = 0, notes = '' } = req.body || {};
    if (!animeId || !title) return res.status(400).json({ error: 'animeId and title are required' });
    const existing = db.trackerEntries.find((e) => String(e.userId) === String(user.id) && String(e.animeId) === String(animeId));
    if (existing) return res.status(409).json({ error: 'Anime already in tracker' });
    const entry = { id: db.counters.tracker++, userId: user.id, animeId, title, poster, status, progress, rating, notes, updatedAt: new Date().toISOString() };
    db.trackerEntries.push(entry);
    await writeDb(db);
    res.status(201).json({ entry });
  });

  app.patch('/api/users/:id/tracker/:entryId', async (req, res) => {
    const db = await readDb();
    const entry = db.trackerEntries.find((e) => String(e.id) === String(req.params.entryId) && String(e.userId) === String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    Object.assign(entry, req.body || {}, { updatedAt: new Date().toISOString() });
    await writeDb(db);
    res.json({ entry });
  });

  app.delete('/api/users/:id/tracker/:entryId', async (req, res) => {
    const db = await readDb();
    const before = db.trackerEntries.length;
    db.trackerEntries = db.trackerEntries.filter((e) => !(String(e.id) === String(req.params.entryId) && String(e.userId) === String(req.params.id)));
    if (before === db.trackerEntries.length) return res.status(404).json({ error: 'Entry not found' });
    await writeDb(db);
    res.json({ success: true });
  });

  app.get('/api/users/:id/watchlists', async (req, res) => {
    const db = await readDb();
    res.json({ watchlists: db.watchlists.filter((w) => String(w.userId) === String(req.params.id)) });
  });

  app.post('/api/users/:id/watchlists', async (req, res) => {
    const db = await readDb();
    const user = getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const watchlist = { id: db.counters.watchlist++, userId: user.id, name, items: [], createdAt: new Date().toISOString() };
    db.watchlists.push(watchlist);
    await writeDb(db);
    res.status(201).json({ watchlist });
  });

  app.patch('/api/users/:id/watchlists/:watchlistId', async (req, res) => {
    const db = await readDb();
    const watchlist = db.watchlists.find((w) => String(w.id) === String(req.params.watchlistId) && String(w.userId) === String(req.params.id));
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });
    if (req.body?.name) watchlist.name = req.body.name;
    if (Array.isArray(req.body?.items)) watchlist.items = req.body.items;
    await writeDb(db);
    res.json({ watchlist });
  });

  app.delete('/api/users/:id/watchlists/:watchlistId', async (req, res) => {
    const db = await readDb();
    const before = db.watchlists.length;
    db.watchlists = db.watchlists.filter((w) => !(String(w.id) === String(req.params.watchlistId) && String(w.userId) === String(req.params.id)));
    if (before === db.watchlists.length) return res.status(404).json({ error: 'Watchlist not found' });
    await writeDb(db);
    res.json({ success: true });
  });

  app.get('/api/users/:id/notifications', async (req, res) => {
    const db = await readDb();
    res.json({ notifications: db.notifications.filter((n) => String(n.userId) === String(req.params.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  app.post('/api/users/:id/notifications', async (req, res) => {
    const db = await readDb();
    const user = getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { type = 'system', message = '' } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const notification = { id: db.counters.notification++, userId: user.id, type, message, read: false, createdAt: new Date().toISOString() };
    db.notifications.push(notification);
    await writeDb(db);
    res.status(201).json({ notification });
  });

  app.patch('/api/users/:id/notifications/:notificationId/read', async (req, res) => {
    const db = await readDb();
    const target = db.notifications.find((n) => String(n.id) === String(req.params.notificationId) && String(n.userId) === String(req.params.id));
    if (!target) return res.status(404).json({ error: 'Notification not found' });
    target.read = true;
    await writeDb(db);
    res.json({ notification: target });
  });

  app.get('/api/community/posts', async (_req, res) => {
    const db = await readDb();
    res.json({ posts: db.communityPosts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  app.post('/api/community/posts', buildRateLimiter(strictRateLimitMax), requireAuth, async (req, res) => {
    const { user, db } = req.auth;
    const { content, spoiler = false } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const post = { id: db.counters.post++, userId: user.id, username: user.username, content, spoiler, likes: [], comments: [], createdAt: new Date().toISOString() };
    db.communityPosts.push(post);
    await writeDb(db);
    res.status(201).json({ post });
  });

  app.post('/api/community/posts/:postId/like', buildRateLimiter(strictRateLimitMax), requireAuth, async (req, res) => {
    const { user, db } = req.auth;
    const post = db.communityPosts.find((p) => String(p.id) === String(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post not found' });
    post.likes = post.likes.includes(user.id) ? post.likes.filter((id) => id !== user.id) : [...post.likes, user.id];
    await writeDb(db);
    res.json({ likes: post.likes.length });
  });

  app.post('/api/community/posts/:postId/comments', buildRateLimiter(strictRateLimitMax), requireAuth, async (req, res) => {
    const { user, db } = req.auth;
    const { content, parentId = null } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const post = db.communityPosts.find((p) => String(p.id) === String(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const comment = { id: db.counters.comment++, userId: user.id, username: user.username, content, parentId, createdAt: new Date().toISOString() };
    post.comments.push(comment);
    await writeDb(db);
    res.status(201).json({ comment });
  });

  app.get('/api/admin/dashboard', buildRateLimiter(strictRateLimitMax), requireAuth, async (req, res) => {
    const { user, db } = req.auth;
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    res.json({
      users: db.users.length,
      trackerEntries: db.trackerEntries.length,
      watchlists: db.watchlists.length,
      posts: db.communityPosts.length,
      notifications: db.notifications.length
    });
  });

  app.use(express.static(path.join(rootDir, 'public')));
  app.use((_req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));

  return app;
}
