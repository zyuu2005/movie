const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, dbPath, ROOM_CODE, ensureRoom, touchRoom, getState, getBackup, restoreBackup } = require('./db');

const app = express();
app.disable('x-powered-by');
// 头像由前端压缩后上传，限制请求体避免大图拖垮双人小服务。
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
ensureRoom();

const isOwner = owner => owner === 'A' || owner === 'B';
const cleanText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);

function validOwner(req, res) {
  if (isOwner(req.body.owner)) return true;
  res.status(400).json({ error: '身份不正确，请重新选择雨或奇' });
  return false;
}

function movieExists(tmdbId) {
  return Boolean(db.prepare('SELECT 1 FROM movies WHERE room_code = ? AND tmdb_id = ? LIMIT 1')
    .get(ROOM_CODE, Number(tmdbId)));
}

function getOwnedMovie(req, res) {
  if (!validOwner(req, res)) return null;
  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND room_code = ? AND owner = ?')
    .get(Number(req.params.id), ROOM_CODE, req.body.owner);
  if (!movie) {
    res.status(404).json({ error: '影片不存在，或你不能修改对方的片单' });
    return null;
  }
  return movie;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/state', (_req, res) => res.json(getState()));

// 备份仅包含片单、资料、评分、评论和抽签结果，不包含任何人的 TMDB Key。
app.get('/api/backup', (_req, res) => res.json(getBackup()));
app.post('/api/restore', (req, res) => {
  try {
    restoreBackup(req.body);
    res.json(getState());
  } catch (error) {
    res.status(400).json({ error: error.message || '备份文件无法恢复' });
  }
});

// 个人资料：默认雨/奇，可分别修改名字和头像，所有设备同步。
app.post('/api/profile', (req, res) => {
  if (!validOwner(req, res)) return;
  const rawName = String(req.body.name ?? '').trim();
  if (!rawName || rawName.length > 12) return res.status(400).json({ error: '名字需为 1–12 个字符' });
  db.prepare('UPDATE profiles SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ?')
    .run(rawName, req.body.owner);
  touchRoom();
  res.json(getState());
});

app.post('/api/profile/avatar', (req, res) => {
  if (!validOwner(req, res)) return;
  const match = String(req.body.image || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: '请选择 JPG、PNG 或 WebP 图片' });
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 1500000) {
    return res.status(400).json({ error: '头像过大，请重新选择图片' });
  }
  db.prepare(`
    UPDATE profiles SET avatar = ?, avatar_mime = ?, avatar_version = avatar_version + 1,
    updated_at = CURRENT_TIMESTAMP WHERE owner = ?
  `).run(image, match[1], req.body.owner);
  touchRoom();
  res.json(getState());
});

app.get('/api/profile/:owner/avatar', (req, res) => {
  if (!isOwner(req.params.owner)) return res.status(400).end();
  const profile = db.prepare('SELECT avatar, avatar_mime FROM profiles WHERE owner = ?').get(req.params.owner);
  if (!profile || !profile.avatar) return res.status(404).end();
  res.set('Content-Type', profile.avatar_mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  // node:sqlite 可能返回 Uint8Array；显式转 Buffer，避免 Express 当成 JSON 对象输出。
  res.send(Buffer.from(profile.avatar));
});

// TMDB 后端代理：Key 仅用于本次上游请求，不写日志、不入库。
app.post('/api/tmdb/search', async (req, res) => {
  const apiKey = cleanText(req.body.apiKey, 128);
  const query = cleanText(req.body.query, 200);
  if (!apiKey || !query) return res.status(400).json({ error: '请填写 TMDB API Key 和电影名称' });

  const params = new URLSearchParams({ api_key: apiKey, query, language: 'zh-CN', include_adult: 'false' });
  const baseUrl = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org';
  try {
    const response = await fetch(`${baseUrl}/3/search/movie?${params}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
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
      overview: movie.overview || '', posterPath: movie.poster_path || '',
    })) : [];
    res.json({ results, page: body.page || 1, totalResults: body.total_results || results.length });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'TMDB 响应超时，请稍后重试' : '服务器暂时无法连接 TMDB';
    res.status(502).json({ error: message });
  }
});

app.post('/api/movies', (req, res) => {
  if (!validOwner(req, res)) return;
  const owner = req.body.owner;
  const tmdbId = Number(req.body.tmdbId);
  const title = cleanText(req.body.title, 300);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title) {
    return res.status(400).json({ error: '影片信息不完整，请重新选择' });
  }
  db.prepare(`
    INSERT INTO movies (room_code, owner, tmdb_id, title, year, overview, poster_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_code, owner, tmdb_id) DO NOTHING
  `).run(ROOM_CODE, owner, tmdbId, title, cleanText(req.body.year, 10),
    cleanText(req.body.overview, 5000), cleanText(req.body.posterPath, 500));
  touchRoom();
  res.status(201).json(getState());
});

app.patch('/api/movies/:id', (req, res) => {
  const movie = getOwnedMovie(req, res);
  if (!movie) return;
  if (typeof req.body.watched === 'boolean') {
    db.prepare('UPDATE movies SET watched = ? WHERE id = ?').run(req.body.watched ? 1 : 0, movie.id);
  } else if (typeof req.body.group === 'string') {
    db.prepare('UPDATE movies SET group_name = ? WHERE id = ?').run(cleanText(req.body.group, 30), movie.id);
  } else {
    return res.status(400).json({ error: '请提供要修改的已看状态或分组' });
  }
  touchRoom();
  res.json(getState());
});

app.delete('/api/movies/:id', (req, res) => {
  const movie = getOwnedMovie(req, res);
  if (!movie) return;
  db.prepare('DELETE FROM movies WHERE id = ?').run(movie.id);
  // 双方片单都不再有这部影片时，同时清理其评分和评论。
  if (!movieExists(movie.tmdb_id)) {
    db.prepare('DELETE FROM ratings WHERE room_code = ? AND tmdb_id = ?').run(ROOM_CODE, movie.tmdb_id);
    db.prepare('DELETE FROM comments WHERE room_code = ? AND tmdb_id = ?').run(ROOM_CODE, movie.tmdb_id);
  }
  touchRoom();
  res.json(getState());
});

// 每人对每部电影保留一个 1–5 星评分，重复评分会覆盖旧值。
app.post('/api/ratings', (req, res) => {
  if (!validOwner(req, res)) return;
  const tmdbId = Number(req.body.tmdbId);
  const score = Number(req.body.score);
  if (!movieExists(tmdbId)) return res.status(404).json({ error: '影片已不在片单中' });
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ error: '评分需为 1–5 星' });
  }
  db.prepare(`
    INSERT INTO ratings (room_code, tmdb_id, owner, score) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_code, tmdb_id, owner)
    DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP
  `).run(ROOM_CODE, tmdbId, req.body.owner, score);
  touchRoom();
  res.json(getState());
});

app.post('/api/comments', (req, res) => {
  if (!validOwner(req, res)) return;
  const tmdbId = Number(req.body.tmdbId);
  const body = String(req.body.body ?? '').trim();
  if (!movieExists(tmdbId)) return res.status(404).json({ error: '影片已不在片单中' });
  if (!body || body.length > 500) return res.status(400).json({ error: '评论需为 1–500 个字符' });
  db.prepare('INSERT INTO comments (room_code, tmdb_id, owner, body) VALUES (?, ?, ?, ?)')
    .run(ROOM_CODE, tmdbId, req.body.owner, body);
  touchRoom();
  res.status(201).json(getState());
});

app.delete('/api/comments/:id', (req, res) => {
  if (!validOwner(req, res)) return;
  const result = db.prepare('DELETE FROM comments WHERE id = ? AND room_code = ? AND owner = ?')
    .run(Number(req.params.id), ROOM_CODE, req.body.owner);
  if (!result.changes) return res.status(404).json({ error: '评论不存在，或不能删除对方的评论' });
  touchRoom();
  res.json(getState());
});

app.post('/api/draw', (req, res) => {
  if (!validOwner(req, res)) return;
  const group = cleanText(req.body.group, 30);
  const allMovies = db.prepare('SELECT * FROM movies WHERE room_code = ?').all(ROOM_CODE);
  const grouped = new Map();
  for (const movie of allMovies) {
    if (!grouped.has(movie.tmdb_id)) grouped.set(movie.tmdb_id, {});
    grouped.get(movie.tmdb_id)[movie.owner] = movie;
  }
  // 分组只决定「哪些电影进入候选」：同一部只要有一方的拷贝在这个分组即可；
  // 共同/ fallback 的优先级判断仍基于双方完整记录，规则与全量抽签一致。
  const inGroup = pair => !group || pair.A?.group_name === group || pair.B?.group_name === group;
  const common = [];
  const fallback = [];
  for (const pair of grouped.values()) {
    if (!inGroup(pair)) continue;
    const candidate = [pair.A, pair.B].find(movie => movie && (!group || movie.group_name === group))
      || pair.A || pair.B;
    if (pair.A && pair.B && !pair.A.watched && !pair.B.watched) common.push(candidate);
    if ((pair.A && !pair.A.watched) || (pair.B && !pair.B.watched)) fallback.push(candidate);
  }
  const pool = common.length ? common : fallback;
  if (!pool.length) {
    return res.status(409).json({ error: group ? `「${group}」分组里没有可抽取的未看完影片` : '还没有未看完的影片，先添加几部想看的电影吧' });
  }

  const picked = pool[crypto.randomInt(pool.length)];
  const lastDraw = {
    movieId: picked.id, tmdbId: picked.tmdb_id, title: picked.title, year: picked.year,
    overview: picked.overview, posterPath: picked.poster_path, group,
    scope: common.length ? 'common' : 'all', drawnBy: req.body.owner, drawnAt: new Date().toISOString(),
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
  if (req.body.confirmation !== '清空全部片单') return res.status(400).json({ error: '请完成二次确认' });
  db.prepare('DELETE FROM movies WHERE room_code = ?').run(ROOM_CODE);
  db.prepare('DELETE FROM ratings WHERE room_code = ?').run(ROOM_CODE);
  db.prepare('DELETE FROM comments WHERE room_code = ?').run(ROOM_CODE);
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
