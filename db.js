const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 固定双人、单一数据空间；所有资料与影片数据都保存在同一个 SQLite 文件。
const ROOM_CODE = 'YU_QI_FIXED';

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const projectDbPath = path.join(__dirname, 'data', 'movie-night.db');
  try {
    fs.mkdirSync(path.dirname(projectDbPath), { recursive: true });
    return projectDbPath;
  } catch (error) {
    // SnapDeploy 等容器以非 root 用户运行，/app/data 可能不可写；改用 /tmp。
    if (error.code !== 'EACCES') throw error;
    const tempDbPath = path.join(os.tmpdir(), 'movie-night.db');
    fs.mkdirSync(path.dirname(tempDbPath), { recursive: true });
    return tempDbPath;
  }
}

const dbPath = resolveDbPath();

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// 首次启动自动建表；新增表不会影响已有片单。
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    last_draw TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    owner TEXT NOT NULL CHECK (owner IN ('A', 'B')),
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '',
    overview TEXT NOT NULL DEFAULT '',
    poster_path TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    watched INTEGER NOT NULL DEFAULT 0 CHECK (watched IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
    UNIQUE (room_code, owner, tmdb_id)
  );

  CREATE TABLE IF NOT EXISTS profiles (
    owner TEXT PRIMARY KEY CHECK (owner IN ('A', 'B')),
    display_name TEXT NOT NULL,
    avatar BLOB,
    avatar_mime TEXT,
    avatar_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ratings (
    room_code TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    owner TEXT NOT NULL CHECK (owner IN ('A', 'B')),
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_code, tmdb_id, owner),
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    owner TEXT NOT NULL CHECK (owner IN ('A', 'B')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_movies_room ON movies(room_code);
  CREATE INDEX IF NOT EXISTS idx_comments_movie ON comments(room_code, tmdb_id);
`);

// 兼容已存在的旧 SQLite 数据库：首次启动自动补上分组字段。
const movieColumns = db.prepare('PRAGMA table_info(movies)').all().map(column => column.name);
if (!movieColumns.includes('group_name')) {
  db.exec("ALTER TABLE movies ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
}

function ensureRoom() {
  db.prepare('INSERT OR IGNORE INTO rooms (code) VALUES (?)').run(ROOM_CODE);
  db.prepare('INSERT OR IGNORE INTO profiles (owner, display_name) VALUES (?, ?)').run('A', '雨');
  db.prepare('INSERT OR IGNORE INTO profiles (owner, display_name) VALUES (?, ?)').run('B', '奇');
}

function touchRoom() {
  db.prepare(`
    UPDATE rooms SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(ROOM_CODE);
}

function getState() {
  ensureRoom();
  const room = db.prepare('SELECT revision, last_draw, updated_at FROM rooms WHERE code = ?').get(ROOM_CODE);
  const movies = db.prepare(`
    SELECT id, owner, tmdb_id AS tmdbId, title, year, overview,
           poster_path AS posterPath, group_name AS groupName, watched, created_at AS createdAt
    FROM movies WHERE room_code = ? ORDER BY created_at DESC, id DESC
  `).all(ROOM_CODE).map(movie => ({ ...movie, watched: Boolean(movie.watched) }));
  const groups = [...new Set(movies.map(movie => movie.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  // 后端自动比对共同想看。
  const byMovie = new Map();
  for (const movie of movies) {
    if (!byMovie.has(movie.tmdbId)) byMovie.set(movie.tmdbId, {});
    byMovie.get(movie.tmdbId)[movie.owner] = movie;
  }
  const common = [...byMovie.entries()]
    .filter(([, pair]) => pair.A && pair.B)
    .map(([tmdbId, pair]) => ({ tmdbId, A: pair.A, B: pair.B }));

  const profileRows = db.prepare(`
    SELECT owner, display_name AS name, avatar_version AS avatarVersion,
           avatar IS NOT NULL AS hasAvatar
    FROM profiles
  `).all();
  const profiles = {};
  for (const profile of profileRows) {
    profiles[profile.owner] = {
      name: profile.name,
      avatarUrl: profile.hasAvatar ? `/api/profile/${profile.owner}/avatar?v=${profile.avatarVersion}` : '',
    };
  }

  const ratings = db.prepare(`
    SELECT tmdb_id AS tmdbId, owner, score, updated_at AS updatedAt
    FROM ratings WHERE room_code = ?
  `).all(ROOM_CODE);
  const comments = db.prepare(`
    SELECT id, tmdb_id AS tmdbId, owner, body, created_at AS createdAt
    FROM comments WHERE room_code = ? ORDER BY created_at DESC, id DESC
  `).all(ROOM_CODE);

  return {
    revision: room.revision,
    updatedAt: room.updated_at,
    movies, common, groups, profiles, ratings, comments,
    lastDraw: room.last_draw ? JSON.parse(room.last_draw) : null,
  };
}

function getBackup() {
  ensureRoom();
  const profiles = db.prepare(`
    SELECT owner, display_name, avatar, avatar_mime, avatar_version, updated_at
    FROM profiles ORDER BY owner
  `).all().map(profile => ({
    owner: profile.owner,
    name: profile.display_name,
    avatar: profile.avatar ? Buffer.from(profile.avatar).toString('base64') : null,
    avatarMime: profile.avatar_mime,
    avatarVersion: profile.avatar_version,
    updatedAt: profile.updated_at,
  }));
  const movies = db.prepare(`
    SELECT owner, tmdb_id, title, year, overview, poster_path, group_name, watched, created_at
    FROM movies WHERE room_code = ? ORDER BY created_at, id
  `).all(ROOM_CODE).map(movie => ({
    owner: movie.owner,
    tmdbId: movie.tmdb_id,
    title: movie.title,
    year: movie.year,
    overview: movie.overview,
    posterPath: movie.poster_path,
    groupName: movie.group_name,
    watched: Boolean(movie.watched),
    createdAt: movie.created_at,
  }));
  const ratings = db.prepare('SELECT tmdb_id, owner, score, updated_at FROM ratings WHERE room_code = ?')
    .all(ROOM_CODE).map(rating => ({
      tmdbId: rating.tmdb_id, owner: rating.owner, score: rating.score, updatedAt: rating.updated_at,
    }));
  const comments = db.prepare('SELECT tmdb_id, owner, body, created_at FROM comments WHERE room_code = ? ORDER BY created_at, id')
    .all(ROOM_CODE).map(comment => ({
      tmdbId: comment.tmdb_id, owner: comment.owner, body: comment.body, createdAt: comment.created_at,
    }));
  const room = db.prepare('SELECT last_draw FROM rooms WHERE code = ?').get(ROOM_CODE);
  return {
    format: 'movie-night-backup',
    version: 1,
    room: ROOM_CODE,
    exportedAt: new Date().toISOString(),
    profiles, movies, ratings, comments,
    lastDraw: room.last_draw ? JSON.parse(room.last_draw) : null,
  };
}

function backupText(value, maxLength, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : fallback;
}

function backupOwner(value) {
  if (value !== 'A' && value !== 'B') throw new Error('备份中的身份数据不正确');
  return value;
}

function restoreBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('备份文件格式不正确');
  if (backup.format !== 'movie-night-backup') throw new Error('这不是电影夜备份文件');
  if (backup.version !== 1) throw new Error('暂不支持这个备份版本');
  const names = ['profiles', 'movies', 'ratings', 'comments'];
  for (const name of names) {
    if (!Array.isArray(backup[name]) || backup[name].length > 5000) throw new Error(`备份中的 ${name} 数据不正确`);
  }
  if (backup.lastDraw !== null && (typeof backup.lastDraw !== 'object' || Array.isArray(backup.lastDraw))) {
    throw new Error('备份中的抽签数据不正确');
  }

  ensureRoom();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM movies WHERE room_code = ?').run(ROOM_CODE);
    db.prepare('DELETE FROM ratings WHERE room_code = ?').run(ROOM_CODE);
    db.prepare('DELETE FROM comments WHERE room_code = ?').run(ROOM_CODE);

    for (const profile of backup.profiles) {
      const owner = backupOwner(profile?.owner);
      const name = backupText(profile.name, 12) || (owner === 'A' ? '雨' : '奇');
      const avatarBase64 = profile.avatar === null || profile.avatar === undefined ? '' : String(profile.avatar);
      const avatarMime = backupText(profile.avatarMime, 50);
      let avatar = null;
      if (avatarBase64) {
        if (!/^[A-Za-z0-9+/=]+$/.test(avatarBase64) || !['image/jpeg', 'image/png', 'image/webp'].includes(avatarMime)) {
          throw new Error('备份中的头像数据不正确');
        }
        avatar = Buffer.from(avatarBase64, 'base64');
        if (!avatar.length || avatar.length > 1500000) throw new Error('备份中的头像过大');
      }
      db.prepare(`
        INSERT INTO profiles (owner, display_name, avatar, avatar_mime, avatar_version, updated_at)
        VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET display_name = excluded.display_name, avatar = excluded.avatar,
        avatar_mime = excluded.avatar_mime, avatar_version = avatar_version + 1, updated_at = CURRENT_TIMESTAMP
      `).run(owner, name, avatar, avatarMime || null);
    }

    const movieIds = new Map();
    for (const movie of backup.movies) {
      const owner = backupOwner(movie?.owner);
      const tmdbId = Number(movie?.tmdbId);
      const title = backupText(movie?.title, 300);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title) throw new Error('备份中的影片数据不正确');
      const result = db.prepare(`
        INSERT INTO movies (room_code, owner, tmdb_id, title, year, overview, poster_path, group_name, watched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_code, owner, tmdb_id) DO NOTHING
      `).run(ROOM_CODE, owner, tmdbId, title,
        backupText(movie?.year, 10), backupText(movie?.overview, 5000), backupText(movie?.posterPath, 500),
        backupText(movie?.groupName, 30), movie?.watched === true ? 1 : 0);
      if (result.changes) movieIds.set(`${owner}:${tmdbId}`, Number(result.lastInsertRowid));
    }

    for (const rating of backup.ratings) {
      const owner = backupOwner(rating?.owner);
      const tmdbId = Number(rating?.tmdbId);
      const score = Number(rating?.score);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(score) || score < 1 || score > 5) {
        throw new Error('备份中的评分数据不正确');
      }
      db.prepare(`
        INSERT INTO ratings (room_code, tmdb_id, owner, score) VALUES (?, ?, ?, ?)
        ON CONFLICT(room_code, tmdb_id, owner) DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP
      `).run(ROOM_CODE, tmdbId, owner, score);
    }

    for (const comment of backup.comments) {
      const owner = backupOwner(comment?.owner);
      const tmdbId = Number(comment?.tmdbId);
      const body = backupText(comment?.body, 500);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !body) throw new Error('备份中的评论数据不正确');
      db.prepare('INSERT INTO comments (room_code, tmdb_id, owner, body) VALUES (?, ?, ?, ?)')
        .run(ROOM_CODE, tmdbId, owner, body);
    }

    let lastDraw = backup.lastDraw;
    if (lastDraw && movieIds.has(`${lastDraw.drawnBy}:${Number(lastDraw.tmdbId)}`)) {
      lastDraw = { ...lastDraw, movieId: movieIds.get(`${lastDraw.drawnBy}:${Number(lastDraw.tmdbId)}`) };
    } else if (lastDraw) {
      lastDraw = { ...lastDraw, movieId: null };
    }
    db.prepare('UPDATE rooms SET last_draw = ? WHERE code = ?').run(lastDraw ? JSON.stringify(lastDraw) : null, ROOM_CODE);
    touchRoom();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { db, dbPath, ROOM_CODE, ensureRoom, touchRoom, getState, getBackup, restoreBackup };
