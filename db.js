const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// 单项目、固定双人：内部仅保留一个数据空间，不向用户提供房间概念。
const ROOM_CODE = 'YU_QI_FIXED';
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'movie-night.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// 首次启动自动建表；已有数据库会原样保留。
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

  CREATE INDEX IF NOT EXISTS idx_movies_room ON movies(room_code);
`);

function ensureRoom() {
  db.prepare('INSERT OR IGNORE INTO rooms (code) VALUES (?)').run(ROOM_CODE);
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

  // 在服务端按 tmdbId 自动比对，前端直接消费共同想看结果。
  const byMovie = new Map();
  for (const movie of movies) {
    if (!byMovie.has(movie.tmdbId)) byMovie.set(movie.tmdbId, {});
    byMovie.get(movie.tmdbId)[movie.owner] = movie;
  }
  const common = [...byMovie.entries()]
    .filter(([, pair]) => pair.A && pair.B)
    .map(([tmdbId, pair]) => ({ tmdbId, A: pair.A, B: pair.B }));

  return {
    revision: room.revision,
    updatedAt: room.updated_at,
    movies,
    common,
    lastDraw: room.last_draw ? JSON.parse(room.last_draw) : null,
  };
}

module.exports = { db, dbPath, ROOM_CODE, ensureRoom, touchRoom, getState };
