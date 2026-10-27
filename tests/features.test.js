const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const port = 45500 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const dbPath = path.join(root, 'data', `features-${process.pid}.db`);
let server;

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
    body: JSON.stringify({ owner, tmdbId, title, year: '2023', overview: `${title}简介`, posterPath: '/p.jpg' }),
  };
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
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
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true });
});

test('头像接口返回真正的 PNG 二进制，而不是 JSON', async () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const saved = await request('/api/profile/avatar', {
    method: 'POST', body: JSON.stringify({ owner: 'B', image: pixel }),
  });
  assert.equal(saved.response.status, 200);

  const image = await fetch(base + saved.body.profiles.B.avatarUrl);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /^image\/png/);
  const buffer = Buffer.from(await image.arrayBuffer());
  assert.equal(buffer.length > 0, true);
  // PNG 文件头：89 50 4E 47。若服务端把 BLOB 当 JSON 输出，这里会是 "123,..." 或 "{" 开头。
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '头像必须是原始二进制 PNG');
});

test('分组字段可修改，并参与抽签范围筛选', async () => {
  await request('/api/movies', movie('A', 710, '分组电影甲'));
  await request('/api/movies', movie('A', 720, '分组电影乙'));
  const addedB = await request('/api/movies', movie('B', 710, '分组电影甲'));
  const rowA = addedB.body.movies.find(item => item.owner === 'A' && item.tmdbId === 710);
  const rowB = addedB.body.movies.find(item => item.owner === 'A' && item.tmdbId === 720);

  const grouped = await request(`/api/movies/${rowA.id}`, {
    method: 'PATCH', body: JSON.stringify({ owner: 'A', group: '周末看' }),
  });
  const updated = grouped.body.movies.find(item => item.id === rowA.id);
  assert.equal(updated.groupName, '周末看');
  assert.deepEqual(grouped.body.groups, ['周末看'], '服务端汇总分组列表');
  await request(`/api/movies/${rowB.id}`, {
    method: 'PATCH', body: JSON.stringify({ owner: 'A', group: '  周末看  ' }),
  });

  // 筛选分组后：共同未看优先（710 双方都加了），且在分组内。
  const draw = await request('/api/draw', {
    method: 'POST', body: JSON.stringify({ owner: 'A', group: '周末看' }),
  });
  assert.equal(draw.response.status, 200);
  assert.equal(draw.body.lastDraw.tmdbId, 710);
  assert.equal(draw.body.lastDraw.scope, 'common');
  assert.equal(draw.body.lastDraw.group, '周末看');

  // 换一个不存在的分组：409。
  const none = await request('/api/draw', {
    method: 'POST', body: JSON.stringify({ owner: 'A', group: '不存在的分组' }),
  });
  assert.equal(none.response.status, 409);

  // 全部看完后再筛该分组：同样 409。
  const state = await request('/api/state');
  for (const row of state.body.movies) {
    await request(`/api/movies/${row.id}`, {
      method: 'PATCH', body: JSON.stringify({ owner: row.owner, watched: true }),
    });
  }
  const emptyDraw = await request('/api/draw', {
    method: 'POST', body: JSON.stringify({ owner: 'A', group: '周末看' }),
  });
  assert.equal(emptyDraw.response.status, 409);
});

test('备份导出与导入恢复往返一致', async () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await request('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ owner: 'A', image: pixel }) });
  await request('/api/profile', { method: 'POST', body: JSON.stringify({ owner: 'A', name: '雨宝宝' }) });
  await request('/api/ratings', { method: 'POST', body: JSON.stringify({ owner: 'B', tmdbId: 710, score: 5 }) });
  await request('/api/comments', { method: 'POST', body: JSON.stringify({ owner: 'A', tmdbId: 710, body: '备份前的评论' }) });
  // 上一个用例把影片全部标记已看，这里先恢复未看，保证能抽到新结果。
  await request('/api/reset-watched', { method: 'POST', body: JSON.stringify({ confirmation: true }) });
  const draw = await request('/api/draw', { method: 'POST', body: JSON.stringify({ owner: 'B' }) });
  assert.equal(draw.response.status, 200);

  const exported = await request('/api/backup');
  assert.equal(exported.response.status, 200);
  const backup = exported.body;
  assert.equal(backup.format, 'movie-night-backup');
  assert.equal(backup.version, 1);
  assert.ok(Array.isArray(backup.movies) && backup.movies.length > 0);
  assert.ok(backup.movies.every(item => typeof item.groupName === 'string'), '备份包含分组字段');
  assert.ok(backup.profiles.some(profile => profile.owner === 'A' && profile.avatar), '备份包含头像');

  // 清空全部，再恢复备份。
  await request('/api/clear-all', { method: 'POST', body: JSON.stringify({ confirmation: '清空全部片单' }) });
  const empty = await request('/api/state');
  assert.deepEqual(empty.body.movies, []);

  const restored = await request('/api/restore', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(restored.response.status, 200);
  const after = restored.body;
  assert.equal(after.movies.length, backup.movies.length, '影片数量恢复一致');
  assert.equal(after.comments.length, 1);
  assert.equal(after.ratings.length, 1);
  assert.equal(after.profiles.A.name, '雨宝宝');
  assert.ok(after.movies.find(item => item.tmdbId === 710 && item.owner === 'A').groupName === '周末看', '分组恢复一致');
  assert.ok(after.lastDraw && after.lastDraw.tmdbId === 710, '抽签结果恢复一致');
  const restoredAvatar = await fetch(base + after.profiles.A.avatarUrl);
  assert.equal(restoredAvatar.status, 200);

  // 坏备份必须被拒绝，且不破坏现有数据。
  const bad = await request('/api/restore', { method: 'POST', body: JSON.stringify({ format: '别的格式' }) });
  assert.equal(bad.response.status, 400);
  const still = await request('/api/state');
  assert.equal(still.body.movies.length, backup.movies.length, '坏备份不能破坏现有数据');
});
