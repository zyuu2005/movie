const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const port = 43000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const dbPath = path.join(root, 'data', `test-${process.pid}.db`);
let server;
let tmdbMock;
let tmdbRequestUrl = '';

async function request(route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  return { response, body };
}

function movie(owner, tmdbId, title) {
  return {
    method: 'POST',
    body: JSON.stringify({ owner, tmdbId, title, year: '2024', overview: `${title}简介`, posterPath: '/poster.jpg' }),
  };
}

test.before(async () => {
  // 本地模拟 TMDB，验证后端代理而不依赖外网或真实 Key。
  tmdbMock = http.createServer((req, res) => {
    tmdbRequestUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      page: 1,
      total_results: 2,
      results: [
        { id: 101, title: '重名电影', release_date: '1995-01-27', overview: '旧版', poster_path: '/old.jpg' },
        { id: 102, title: '重名电影', release_date: '2020-02-01', overview: '新版', poster_path: null },
      ],
    }));
  });
  await new Promise(resolve => tmdbMock.listen(0, '127.0.0.1', resolve));
  const tmdbPort = tmdbMock.address().port;

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath,
      TMDB_BASE_URL: `http://127.0.0.1:${tmdbPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`服务启动超时 ${errors}`)), 8000);
    server.stdout.on('data', chunk => {
      if (chunk.toString().includes('已启动')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once('error', reject);
    server.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`服务提前退出：${code} ${errors}`));
    });
  });
});

test.after(async () => {
  if (server && !server.killed) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  if (tmdbMock) await new Promise(resolve => tmdbMock.close(resolve));
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true });
});

test('TMDB 后端代理转发并整理候选影片', async () => {
  const missing = await request('/api/tmdb/search', { method: 'POST', body: '{}' });
  assert.equal(missing.response.status, 400);

  const result = await request('/api/tmdb/search', {
    method: 'POST', body: JSON.stringify({ apiKey: 'private-test-key', query: '重名电影' }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results.length, 2, '重名候选应全部返回');
  assert.deepEqual(result.body.results[0], {
    tmdbId: 101, title: '重名电影', year: '1995', overview: '旧版', posterPath: '/old.jpg',
  });
  const upstream = new URL(tmdbRequestUrl, 'http://mock.local');
  assert.equal(upstream.pathname, '/3/search/movie');
  assert.equal(upstream.searchParams.get('api_key'), 'private-test-key');
  assert.equal(upstream.searchParams.get('query'), '重名电影');
  assert.equal(upstream.searchParams.get('language'), 'zh-CN');
});

test('头像名字、双人评分和评论完整同步', async () => {
  const initial = await request('/api/state');
  assert.equal(initial.body.profiles.A.name, '雨');
  assert.equal(initial.body.profiles.B.name, '奇');

  await request('/api/movies', movie('A', 303, '讨论电影'));
  const renamed = await request('/api/profile', {
    method: 'POST', body: JSON.stringify({ owner: 'A', name: '小雨' }),
  });
  assert.equal(renamed.body.profiles.A.name, '小雨');

  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const avatar = await request('/api/profile/avatar', {
    method: 'POST', body: JSON.stringify({ owner: 'A', image: pixel }),
  });
  assert.match(avatar.body.profiles.A.avatarUrl, /^\/api\/profile\/A\/avatar\?v=1$/);
  const image = await fetch(base + avatar.body.profiles.A.avatarUrl);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /^image\/png/);

  await request('/api/ratings', {
    method: 'POST', body: JSON.stringify({ owner: 'A', tmdbId: 303, score: 5 }),
  });
  const rated = await request('/api/ratings', {
    method: 'POST', body: JSON.stringify({ owner: 'B', tmdbId: 303, score: 4 }),
  });
  assert.equal(rated.body.ratings.length, 2);
  assert.deepEqual(rated.body.ratings.map(item => item.score).sort(), [4, 5]);

  await request('/api/comments', {
    method: 'POST', body: JSON.stringify({ owner: 'A', tmdbId: 303, body: '雨的评论' }),
  });
  const commented = await request('/api/comments', {
    method: 'POST', body: JSON.stringify({ owner: 'B', tmdbId: 303, body: '奇的评论' }),
  });
  assert.equal(commented.body.comments.length, 2);
  const comment = commented.body.comments.find(item => item.owner === 'A');
  const forbidden = await request(`/api/comments/${comment.id}`, {
    method: 'DELETE', body: JSON.stringify({ owner: 'B' }),
  });
  assert.equal(forbidden.response.status, 404);

  const movieRow = commented.body.movies.find(item => item.tmdbId === 303);
  const removed = await request(`/api/movies/${movieRow.id}`, {
    method: 'DELETE', body: JSON.stringify({ owner: 'A' }),
  });
  assert.deepEqual(removed.body.ratings, []);
  assert.deepEqual(removed.body.comments, []);
  assert.equal(removed.body.profiles.A.name, '小雨', '删除影片不能删除个人资料');
});

test('固定雨奇双人片单与抽签完整流程', async () => {
  const empty = await request('/api/state');
  assert.deepEqual(empty.body.movies, []);
  assert.deepEqual(empty.body.common, []);
  assert.equal('roomCode' in empty.body, false, '接口不应暴露房间机制');

  await request('/api/movies', movie('A', 101, '共同电影'));
  const both = await request('/api/movies', movie('B', 101, '共同电影'));
  await request('/api/movies', movie('A', 202, '雨的独自期待'));
  assert.equal(both.body.common.length, 1, '后端自动生成共同片单');
  assert.equal(both.body.common[0].A.owner, 'A');
  assert.equal(both.body.common[0].B.owner, 'B');

  const duplicate = await request('/api/movies', movie('A', 101, '共同电影'));
  assert.equal(duplicate.body.movies.length, 3);

  const draw = await request('/api/draw', { method: 'POST', body: JSON.stringify({ owner: 'B' }) });
  assert.equal(draw.body.lastDraw.tmdbId, 101, '共同想看必须优先');
  assert.equal(draw.body.lastDraw.scope, 'common');
  assert.equal(draw.body.lastDraw.drawnBy, 'B');
  assert.ok(draw.body.movies.every(item => !item.watched), '抽签不能自动已看');

  const aMovie = draw.body.movies.find(item => item.owner === 'A' && item.tmdbId === 101);
  const forbidden = await request(`/api/movies/${aMovie.id}`, {
    method: 'PATCH', body: JSON.stringify({ owner: 'B', watched: true }),
  });
  assert.equal(forbidden.response.status, 404);

  const watched = await request(`/api/movies/${aMovie.id}`, {
    method: 'PATCH', body: JSON.stringify({ owner: 'A', watched: true }),
  });
  assert.equal(watched.body.movies.find(item => item.id === aMovie.id).watched, true);

  const fallback = await request('/api/draw', { method: 'POST', body: JSON.stringify({ owner: 'A' }) });
  assert.equal(fallback.body.lastDraw.scope, 'all');

  const deleted = await request(`/api/movies/${aMovie.id}`, {
    method: 'DELETE', body: JSON.stringify({ owner: 'A' }),
  });
  assert.ok(!deleted.body.movies.some(item => item.id === aMovie.id));

  const badReset = await request('/api/reset-watched', { method: 'POST', body: '{}' });
  assert.equal(badReset.response.status, 400);
  const reset = await request('/api/reset-watched', {
    method: 'POST', body: JSON.stringify({ confirmation: true }),
  });
  assert.ok(reset.body.movies.every(item => !item.watched));

  const badClear = await request('/api/clear-all', {
    method: 'POST', body: JSON.stringify({ confirmation: '确认' }),
  });
  assert.equal(badClear.response.status, 400);
  const cleared = await request('/api/clear-all', {
    method: 'POST', body: JSON.stringify({ confirmation: '清空全部片单' }),
  });
  assert.deepEqual(cleared.body.movies, []);
  assert.deepEqual(cleared.body.common, []);
  assert.equal(cleared.body.lastDraw, null);

  const noDraw = await request('/api/draw', { method: 'POST', body: JSON.stringify({ owner: 'A' }) });
  assert.equal(noDraw.response.status, 409);

  const page = await fetch(base + '/');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /雨和奇/);
  assert.match(html, /This product uses the TMDB API but is not endorsed or certified by TMDB\./);
  assert.doesNotMatch(html, /roomInput|copyRoomBtn|joinForm/);
});
