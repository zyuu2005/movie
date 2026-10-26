const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, dbPath, ROOM_CODE, ensureRoom, touchRoom, getState } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
ensureRoom();

// 数据库沿用 A/B 做身份约束；界面分别显示为“雨”和“奇”。
const isOwner = owner => owner === 'A' || owner === 'B';
const cleanText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);

function getOwnedMovie(req, res) {
  const owner = req.body.owner;
  if (!isOwner(owner)) {
    res.status(400).json({ error: '身份不正确，请重新选择雨或奇' });
    return null;
  }
  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND room_code = ? AND owner = ?')
    .get(Number(req.params.id), ROOM_CODE, owner);
  if (!movie) {
    res.status(404).json({ error: '影片不存在，或你不能修改对方的片单' });
    return null;
  }
  return { owner, movie };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 所有设备读写同一份固定片单。
app.get('/api/state', (_req, res) => res.json(getState()));

// TMDB 后端代理：Key 仅用于本次上游请求，不写日志、不入库。
app.post('/api/tmdb/search', async (req, res) => {
  const apiKey = cleanText(req.body.apiKey, 128);
  const query = cleanText(req.body.query, 200);
  if (!apiKey || !query) return res.status(400).json({ error: '请填写 TMDB API Key 和电影名称' });

  const params = new URLSearchParams({
    api_key: apiKey, query, language: 'zh-CN', include_adult: 'false',
  });
  const baseUrl = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org';
  try {
    const response = await fetch(`${baseUrl}/3/search/movie?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) {
      return res.status(response.status === 401 ? 401 : 502).json({
        error: cleanText(body.status_message, 300) || 'TMDB 搜索失败，请检查 API Key',
      });
    }
    const results = Array.isArray(body.results) ? body.results.map(movie => ({
      tmdbId: movie.id,
      title: movie.title || movie.original_title || '未命名影片',
      year: movie.release_date ? movie.release_date.slice(0, 4) : '',
      overview: movie.overview || '',
      posterPath: movie.poster_path || '',
    })) : [];
    res.json({ results, page: body.page || 1, totalResults: body.total_results || results.length });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'TMDB 响应超时，请稍后重试' : '服务器暂时无法连接 TMDB';
    res.status(502).json({ error: message });
  }
});

app.post('/api/movies', (req, res) => {
  const { owner } = req.body;
  const tmdbId = Number(req.body.tmdbId);
  const title = cleanText(req.body.title, 300);
  if (!isOwner(owner) || !Number.isInteger(tmdbId) || tmdbId <= 0 || !title) {
    return res.status(400).json({ error: '影片信息不完整，请重新选择' });
  }

  // 同一人重复加入同一 tmdb_id 时保持一条记录。
  db.prepare(`
    INSERT INTO movies (room_code, owner, tmdb_id, title, year, overview, poster_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_code, owner, tmdb_id) DO NOTHING
  `).run(
    ROOM_CODE, owner, tmdbId, title, cleanText(req.body.year, 10),
    cleanText(req.body.overview, 5000), cleanText(req.body.posterPath, 500),
  );
  touchRoom();
  res.status(201).json(getState());
});

app.patch('/api/movies/:id', (req, res) => {
  const owned = getOwnedMovie(req, res);
  if (!owned) return;
  if (typeof req.body.watched !== 'boolean') {
    return res.status(400).json({ error: '已看状态格式不正确' });
  }
  db.prepare('UPDATE movies SET watched = ? WHERE id = ?')
    .run(req.body.watched ? 1 : 0, owned.movie.id);
  touchRoom();
  res.json(getState());
});

app.delete('/api/movies/:id', (req, res) => {
  const owned = getOwnedMovie(req, res);
  if (!owned) return;
  db.prepare('DELETE FROM movies WHERE id = ?').run(owned.movie.id);
  touchRoom();
  res.json(getState());
});

app.post('/api/draw', (req, res) => {
  if (!isOwner(req.body.owner)) return res.status(400).json({ error: '身份不正确' });
  const movies = db.prepare('SELECT * FROM movies WHERE room_code = ?').all(ROOM_CODE);
  const grouped = new Map();
  for (const movie of movies) {
    if (!grouped.has(movie.tmdb_id)) grouped.set(movie.tmdb_id, {});
    grouped.get(movie.tmdb_id)[movie.owner] = movie;
  }

  // 按 tmdb_id 去重，避免同一影片因两人收藏而获得双倍权重。
  const common = [];
  const fallback = [];
  for (const pair of grouped.values()) {
    const candidate = pair.A || pair.B;
    if (pair.A && pair.B && !pair.A.watched && !pair.B.watched) common.push(candidate);
    if ((pair.A && !pair.A.watched) || (pair.B && !pair.B.watched)) fallback.push(candidate);
  }
  const pool = common.length ? common : fallback;
  if (!pool.length) {
    return res.status(409).json({ error: '还没有未看完的影片，先添加几部想看的电影吧' });
  }

  const picked = pool[crypto.randomInt(pool.length)];
  const lastDraw = {
    movieId: picked.id,
    tmdbId: picked.tmdb_id,
    title: picked.title,
    year: picked.year,
    overview: picked.overview,
    posterPath: picked.poster_path,
    scope: common.length ? 'common' : 'all',
    drawnBy: req.body.owner,
    drawnAt: new Date().toISOString(),
  };
  db.prepare('UPDATE rooms SET last_draw = ? WHERE code = ?').run(JSON.stringify(lastDraw), ROOM_CODE);
  touchRoom();
  res.json(getState());
});

app.post('/api/reset-watched', (req, res) => {
  if (req.body.confirmation !== true) return res.status(400).json({ error: '请完成二次确认' });
  db.prepare('UPDATE movies SET watched = 0 WHERE room_code = ?').run(ROOM_CODE);
  touchRoom();
  res.json(getState());
});

app.post('/api/clear-all', (req, res) => {
  if (req.body.confirmation !== '清空全部片单') {
    return res.status(400).json({ error: '请完成二次确认' });
  }
  db.prepare('DELETE FROM movies WHERE room_code = ?').run(ROOM_CODE);
  db.prepare('UPDATE rooms SET last_draw = NULL WHERE code = ?').run(ROOM_CODE);
  touchRoom();
  res.json(getState());
});

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: '服务器开了个小差，请稍后再试' });
});

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`🎬 电影夜已启动：http://localhost:${port}`);
  console.log(`📁 SQLite 数据库：${dbPath}`);
});
