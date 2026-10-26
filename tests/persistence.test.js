const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', `persistence-${process.pid}.db`);
let server;

async function start(port) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    server.stdout.on('data', chunk => {
      if (chunk.toString().includes('已启动')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once('error', reject);
  });
}

async function stop() {
  if (!server || server.killed) return;
  server.kill();
  await new Promise(resolve => server.once('exit', resolve));
}

test.after(async () => {
  await stop();
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true });
});

test('云端同款 DB_PATH 在服务重启后保留完整片单', async () => {
  const port = 44500 + Math.floor(Math.random() * 500);
  await start(port);
  const add = await fetch(`http://127.0.0.1:${port}/api/movies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: 'A', tmdbId: 8080, title: '云端持久化测试',
      year: '2026', overview: '重启后仍应存在', posterPath: '',
    }),
  });
  assert.equal(add.status, 201);
  await stop();

  // 使用同一个持久路径重新启动，模拟云端实例重启。
  await start(port);
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then(response => response.json());
  assert.equal(state.movies.length, 1);
  assert.equal(state.movies[0].title, '云端持久化测试');
  assert.equal(state.movies[0].overview, '重启后仍应存在');
});
