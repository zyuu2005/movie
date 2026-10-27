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
           poster_path AS posterPath, watched, created_at AS createdAt
    FROM movies WHERE room_code = ? ORDER BY created_at DESC, id DESC
  `).all(ROOM_CODE).map(movie => ({ ...movie, watched: Boolean(movie.watched) }));

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
    movies, common, profiles, ratings, comments,
    lastDraw: room.last_draw ? JSON.parse(room.last_draw) : null,
  };
}

module.exports = { db, dbPath, ROOM_CODE, ensureRoom, touchRoom, getState };
