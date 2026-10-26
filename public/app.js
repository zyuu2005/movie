'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const OWNER_NAMES = { A: '雨', B: '奇' };
const IDENTITY_KEY = 'movieNight.identity';
const TMDB_KEY = 'movieNight.tmdbKey';

// 本地只记身份和 TMDB Key；头像、名字、评分、评论均放服务端，换设备不丢失。
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 当前会话仍可使用 */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* noop */ } },
};

const state = {
  identity: '', data: null, tab: 'common', pollTimer: null,
  searchResults: [], drawing: false, requestId: 0,
  discussionTmdb: null, avatarData: '',
};

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function posterUrl(path, size = 'w342') {
  return path && /^\/[\w./-]+$/.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

function posterMarkup(movie, className) {
  const url = posterUrl(movie.posterPath);
  if (url) return `<img class="${className}" src="${url}" alt="${escapeHTML(movie.title)}海报" loading="lazy" referrerpolicy="no-referrer">`;
  return `<div class="${className} poster-fallback">${escapeHTML(movie.title)}</div>`;
}

function profileName(owner) {
  return state.data?.profiles?.[owner]?.name || OWNER_NAMES[owner] || owner;
}

function avatarMarkup(owner, className = '', imageOverride = null) {
  const profile = state.data?.profiles?.[owner];
  const url = imageOverride !== null ? imageOverride : profile?.avatarUrl;
  const name = profileName(owner);
  return `<span class="avatar ${className}">${url
    ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(name)}的头像">`
    : escapeHTML(name.slice(0, 1))}</span>`;
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
}

// ---------- 身份与页面进入 ----------
function showIdentityPicker() {
  clearInterval(state.pollTimer);
  state.identity = '';
  state.data = null;
  $('#roomView').classList.add('hidden');
  $('#headerRoom').classList.add('hidden');
  $('#welcomeView').classList.remove('hidden');
}

async function enterRoom() {
  storage.set(IDENTITY_KEY, state.identity);
  $('#welcomeView').classList.add('hidden');
  $('#roomView').classList.remove('hidden');
  $('#headerRoom').classList.remove('hidden');
  $('#identityBadge').textContent = OWNER_NAMES[state.identity];
  $('#movieList').innerHTML = '<div class="empty-list"><span>☁</span><h3>正在打开片单…</h3></div>';
  try {
    await fetchState(false);
    startPolling();
  } catch (error) {
    toast(error.message);
    $('#movieList').innerHTML = '<div class="empty-list"><h3>暂时连接不上</h3><p>请确认服务端已启动，再刷新页面。</p></div>';
  }
}

// ---------- API、轮询与状态更新 ----------
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后再试');
  return body;
}

function setSyncStatus(ok, text) {
  $('#syncDot').classList.toggle('offline', !ok);
  $('#syncText').textContent = text;
}

async function fetchState(silent = true) {
  if (!state.identity) return;
  const requestId = ++state.requestId;
  if (!silent) setSyncStatus(true, '同步中…');
  try {
    const data = await api('/api/state');
    if (requestId !== state.requestId) return;
    const changed = !state.data || data.revision !== state.data.revision;
    state.data = data;
    if (changed) renderRoom();
    setSyncStatus(true, '已同步');
  } catch (error) {
    setSyncStatus(false, '等待重连');
    if (!silent) throw error;
  }
}

function applyMutation(promise, successMessage) {
  return promise.then(data => {
    state.requestId++;
    state.data = data;
    renderRoom();
    setSyncStatus(true, '已同步');
    if (successMessage) toast(successMessage);
    return data;
  }).catch(error => {
    toast(error.message);
    fetchState();
    throw error;
  });
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.drawing) fetchState();
  }, 2500);
}

// ---------- 个人资料 ----------
function renderProfile() {
  if (!state.data) return;
  $('#headerAvatar').innerHTML = avatarMarkup(state.identity);
  $('#profileBtnName').textContent = profileName(state.identity);
  for (const owner of ['A', 'B']) {
    const tab = $(`.list-tabs [data-tab="${owner}"]`);
    tab.innerHTML = `${escapeHTML(profileName(owner))}的片单 <b id="${owner.toLowerCase()}Count">0</b>`;
  }
}

function openProfile() {
  state.avatarData = '';
  $('#profileNameInput').value = profileName(state.identity);
  refreshAvatarPreview();
  $('#profileDialog').showModal();
}

function refreshAvatarPreview() {
  const preview = $('#profileAvatarPreview');
  const url = state.avatarData || state.data.profiles[state.identity].avatarUrl;
  preview.innerHTML = url
    ? `<img src="${escapeHTML(url)}" alt="头像预览">`
    : escapeHTML(profileName(state.identity).slice(0, 1));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function prepareAvatar(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    toast('请选择 JPG、PNG 或 WebP 图片');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('图片不能超过 5 MB');
    return;
  }
  try {
    const image = await loadImage(await readFile(file));
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const side = Math.min(image.width, image.height);
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) / 2;
    canvas.getContext('2d').drawImage(image, sx, sy, side, side, 0, 0, 256, 256);
    state.avatarData = canvas.toDataURL('image/jpeg', 0.82);
    refreshAvatarPreview();
  } catch {
    toast('图片读取失败，请换一张试试');
  }
}

// ---------- 片单与抽签渲染 ----------
function getCommonMovies() {
  if (!state.data) return [];
  return state.data.common.map(pair => {
    const otherOwner = state.identity === 'A' ? 'B' : 'A';
    return { ...pair[state.identity], pairB: pair[otherOwner] };
  });
}

function movieRatings(tmdbId) {
  return state.data.ratings.filter(rating => rating.tmdbId === tmdbId);
}

function movieComments(tmdbId) {
  return state.data.comments.filter(comment => comment.tmdbId === tmdbId);
}

function renderRoom() {
  if (!state.data) return;
  renderProfile();
  const movies = state.data.movies;
  $('#commonCount').textContent = state.data.common.length;
  $('#aCount').textContent = movies.filter(movie => movie.owner === 'A').length;
  $('#bCount').textContent = movies.filter(movie => movie.owner === 'B').length;
  $('#movieTotal').textContent = `${new Set(movies.map(movie => movie.tmdbId)).size} 部电影`;
  renderDraw();
  renderList();
  renderSearchResults();
  if ($('#discussionDialog').open) renderDiscussion();
}

function renderDraw() {
  const draw = state.data.lastDraw;
  $('#drawEmpty').classList.toggle('hidden', Boolean(draw));
  $('#drawResult').classList.toggle('hidden', !draw);
  if (!draw) return;
  const ownMovie = state.data.movies.find(movie => movie.tmdbId === draw.tmdbId && movie.owner === state.identity);
  const scope = draw.scope === 'common' ? '来自共同想看' : '来自两个人的片单';
  const watchedButton = ownMovie
    ? `<button class="secondary-button" data-draw-watched="${ownMovie.id}" data-watched="${!ownMovie.watched}">${ownMovie.watched ? '取消已看标记' : '标记为已看完'}</button>`
    : '';
  $('#drawResult').innerHTML = `
    ${posterMarkup(draw, 'draw-poster')}
    <div class="draw-info">
      <p class="eyebrow">TONIGHT'S PICK · ${scope}</p>
      <h2>${escapeHTML(draw.title)}</h2>
      <p class="draw-meta">${escapeHTML(draw.year || '年份未知')} · 今晚就看这一部</p>
      <p class="draw-overview">${escapeHTML(draw.overview || '没有简介，也不妨碍今晚的期待。')}</p>
      <p class="draw-by">由 ${escapeHTML(profileName(draw.drawnBy))} 抽取 · 抽签不会自动标记已看</p>
    </div>
    <div class="draw-actions">
      ${watchedButton}
      <button class="secondary-button" data-draw-discuss="${draw.tmdbId}">评分与评论</button>
      <button class="draw-button" id="redrawBtn"><span class="draw-spark">✦</span> 再抽一次</button>
    </div>`;
}

function movieCard(movie, isCommon = false) {
  const canManage = movie.owner === state.identity;
  const ownWatched = movie.watched;
  const otherWatched = isCommon && movie.pairB.watched;
  const bothWatched = isCommon && ownWatched && otherWatched;
  const ratings = movieRatings(movie.tmdbId);
  const comments = movieComments(movie.tmdbId);
  const average = ratings.length ? (ratings.reduce((sum, item) => sum + item.score, 0) / ratings.length).toFixed(1) : '';
  let badges = isCommon
    ? `<span class="badge">共同想看</span>${bothWatched ? '<span class="badge watched-badge">双方已看完</span>' : (ownWatched || otherWatched ? '<span class="badge watched-badge">一方已看</span>' : '')}`
    : `${movie.watched ? '<span class="badge watched-badge">已看完</span>' : '<span class="badge">未看</span>'}`;
  if (average) badges += `<span class="badge discussion-badge">★ ${average}</span>`;
  if (comments.length) badges += `<span class="badge">💬 ${comments.length}</span>`;
  return `<article class="movie-card ${isCommon ? (bothWatched ? 'watched' : '') : (movie.watched ? 'watched' : '')}">
    ${posterMarkup(movie, 'movie-poster')}
    <div class="movie-info">
      <div class="movie-title-row"><h3>${escapeHTML(movie.title)}</h3></div>
      <p class="movie-year">${escapeHTML(movie.year || '年份未知')}</p>
      <p class="movie-overview">${escapeHTML(movie.overview || '这部电影还没有简介。')}</p>
      <div class="movie-badges">${badges}</div>
      <div class="movie-actions">
        <button class="discuss-button" data-discuss-tmdb="${movie.tmdbId}">★ 评分与评论</button>
        ${canManage ? `<button data-watch-id="${movie.id}" data-watched="${!movie.watched}">${movie.watched ? '↶ 取消已看' : '✓ 标记已看完'}</button>
        <button class="delete-movie" data-delete-id="${movie.id}" data-title="${escapeHTML(movie.title)}" aria-label="删除${escapeHTML(movie.title)}">删除</button>` : ''}
      </div>
    </div>
  </article>`;
}

function renderList() {
  const common = getCommonMovies();
  let movies;
  if (state.tab === 'common') {
    movies = common;
    $('#listCaption').textContent = common.length ? '两个人都加入的电影会在这里相遇。' : '同一部电影分别被雨、奇加入后，就会自动出现在这里。';
  } else {
    movies = state.data.movies.filter(movie => movie.owner === state.tab);
    $('#listCaption').textContent = state.tab === state.identity ? '这是你的片单，只有你可以修改自己的影片。' : '对方的片单仅可查看，也可以一起评分和评论。';
  }
  if (!movies.length) {
    const copy = state.tab === 'common'
      ? ['♡', '还没有共同的期待', '让对方也搜索并加入同一部电影吧']
      : ['🎬', `${profileName(state.tab)}的片单还是空的`, state.tab === state.identity ? '从上方搜索第一部电影吧' : '等对方种下一点期待'];
    $('#movieList').innerHTML = `<div class="empty-list"><span>${copy[0]}</span><h3>${copy[1]}</h3><p>${copy[2]}</p></div>`;
    return;
  }
  $('#movieList').innerHTML = movies.map(movie => movieCard(movie, state.tab === 'common')).join('');
}

// ---------- 评分与评论 ----------
function formatCommentTime(value) {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function openDiscussion(tmdbId) {
  state.discussionTmdb = Number(tmdbId);
  renderDiscussion();
  $('#discussionDialog').showModal();
}

function renderDiscussion() {
  const tmdbId = state.discussionTmdb;
  const movie = state.data?.movies.find(item => item.tmdbId === tmdbId);
  if (!movie) {
    if ($('#discussionDialog').open) $('#discussionDialog').close();
    return;
  }
  const draft = $('#commentInput')?.value || '';
  const ratings = movieRatings(tmdbId);
  const comments = movieComments(tmdbId);
  const ownRating = ratings.find(item => item.owner === state.identity)?.score || 0;
  const average = ratings.length ? (ratings.reduce((sum, item) => sum + item.score, 0) / ratings.length).toFixed(1) : '—';
  const partnerRatings = ['A', 'B'].map(owner => {
    const score = ratings.find(item => item.owner === owner)?.score;
    return `<div class="partner-rating">${avatarMarkup(owner)}<span>${escapeHTML(profileName(owner))}</span><b>${score ? `★ ${score}` : '未评分'}</b></div>`;
  }).join('');
  const stars = [1, 2, 3, 4, 5].map(score => `<button type="button" class="star-button ${score <= ownRating ? 'active' : ''}" data-score="${score}" aria-label="评 ${score} 星">★</button>`).join('');
  const commentList = comments.length ? comments.map(comment => `
    <article class="comment-item">
      ${avatarMarkup(comment.owner)}
      <div><div class="comment-meta"><strong>${escapeHTML(profileName(comment.owner))}</strong><time>${escapeHTML(formatCommentTime(comment.createdAt))}</time>
      ${comment.owner === state.identity ? `<button data-delete-comment="${comment.id}">删除</button>` : ''}</div>
      <p class="comment-text">${escapeHTML(comment.body)}</p></div>
    </article>`).join('') : '<div class="empty-comments">还没有评论，看完来聊两句吧。</div>';

  $('#discussionContent').innerHTML = `
    <div class="discussion-hero">${posterMarkup(movie, 'movie-poster')}<div><p class="eyebrow">RATE & TALK</p><h2>${escapeHTML(movie.title)}</h2><p>${escapeHTML(movie.year || '年份未知')} · 两个人的观影小记录</p></div></div>
    <div class="discussion-body">
      <div class="rating-summary"><strong>${average}</strong><span>平均评分 · ${ratings.length} 人已评分</span></div>
      <div class="partner-ratings">${partnerRatings}</div>
      <div class="my-rating"><span>我的评分</span><div class="stars">${stars}</div></div>
      <div class="comments-heading"><h3>评论</h3><span>${comments.length} 条</span></div>
      <form id="commentForm" class="comment-form">
        ${avatarMarkup(state.identity)}
        <textarea id="commentInput" maxlength="500" placeholder="说说这部电影…" required></textarea>
        <button class="secondary-button" type="submit">发表</button>
      </form>
      <div class="comment-list">${commentList}</div>
    </div>`;
  $('#commentInput').value = draft;
}

// ---------- TMDB 设置与后端代理搜索 ----------
function apiKey() { return storage.get(TMDB_KEY) || ''; }

function updateApiSettings() {
  const hasKey = Boolean(apiKey());
  $('#apiKeyInput').value = apiKey();
  $('#apiKeyStatus').textContent = hasKey ? '已保存在此浏览器 ✓' : '首次使用，请填入 API Key';
  $('#apiSettings').open = !hasKey;
}

async function searchMovies(query) {
  const key = apiKey();
  if (!key) {
    $('#apiSettings').open = true;
    $('#apiKeyInput').focus();
    toast('请先填写并保存你的 TMDB API Key');
    return;
  }
  const message = $('#searchMessage');
  message.classList.remove('hidden');
  message.textContent = '正在通过服务器寻找电影…';
  $('#searchResults').classList.add('hidden');
  $('#searchForm button').disabled = true;
  try {
    const body = await api('/api/tmdb/search', { method: 'POST', body: JSON.stringify({ apiKey: key, query }) });
    state.searchResults = body.results;
    if (!state.searchResults.length) {
      message.textContent = '没有找到相关电影，试试原名或更短的关键词。';
    } else {
      message.textContent = `找到 ${state.searchResults.length} 部候选影片，重名电影请根据年份与简介选择。`;
      $('#searchResults').classList.remove('hidden');
    }
    renderSearchResults();
  } catch (error) {
    message.textContent = `搜索失败：${error.message}`;
  } finally {
    $('#searchForm button').disabled = false;
  }
}

function renderSearchResults() {
  if (!state.data || !state.searchResults.length) return;
  const ownIds = new Set(state.data.movies.filter(movie => movie.owner === state.identity).map(movie => movie.tmdbId));
  $('#searchResults').innerHTML = state.searchResults.map((movie, index) => {
    const added = ownIds.has(movie.tmdbId);
    return `<article class="search-item">
      ${posterMarkup(movie, 'search-poster')}
      <div><h3>${escapeHTML(movie.title)}<span class="year">${escapeHTML(movie.year || '年份未知')}</span></h3><p>${escapeHTML(movie.overview || '暂无简介')}</p></div>
      <button class="add-button ${added ? 'added' : ''}" data-add-index="${index}" ${added ? 'disabled' : ''}>${added ? '已加入 ✓' : '+ 加入我的片单'}</button>
    </article>`;
  }).join('');
}

async function addMovie(index, button) {
  const movie = state.searchResults[index];
  if (!movie) return;
  button.disabled = true;
  try {
    await applyMutation(api('/api/movies', {
      method: 'POST', body: JSON.stringify({ owner: state.identity, ...movie }),
    }), `已把《${movie.title}》加入${profileName(state.identity)}的片单`);
  } catch { button.disabled = false; }
}

async function drawMovie() {
  if (state.drawing) return;
  state.drawing = true;
  const buttons = [$('#drawBtn'), $('#redrawBtn')].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; button.classList.add('drawing'); });
  try {
    const [data] = await Promise.all([
      api('/api/draw', { method: 'POST', body: JSON.stringify({ owner: state.identity }) }),
      new Promise(resolve => setTimeout(resolve, 650)),
    ]);
    state.requestId++;
    state.data = data;
    renderRoom();
    setSyncStatus(true, '已同步');
    $('#drawCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    toast(error.message);
  } finally {
    state.drawing = false;
    buttons.forEach(button => { button.disabled = false; button.classList.remove('drawing'); });
  }
}

// ---------- 页面事件 ----------
$$('.identity-button').forEach(button => button.addEventListener('click', () => {
  state.identity = button.dataset.identity;
  enterRoom();
}));

$('#switchIdentityBtn').addEventListener('click', () => {
  storage.remove(IDENTITY_KEY);
  showIdentityPicker();
});
$('#profileBtn').addEventListener('click', openProfile);
$('#avatarInput').addEventListener('change', event => {
  prepareAvatar(event.target.files[0]);
  event.target.value = '';
});

$('#profileForm').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const name = $('#profileNameInput').value.trim();
  if (!name) { toast('名字不能为空'); return; }
  $('#saveProfileBtn').disabled = true;
  try {
    if (state.avatarData) {
      await applyMutation(api('/api/profile/avatar', {
        method: 'POST', body: JSON.stringify({ owner: state.identity, image: state.avatarData }),
      }));
    }
    await applyMutation(api('/api/profile', {
      method: 'POST', body: JSON.stringify({ owner: state.identity, name }),
    }));
    $('#profileDialog').close();
    toast('头像和名字已同步保存');
  } catch { /* applyMutation 已提示 */ } finally {
    $('#saveProfileBtn').disabled = false;
  }
});

$('#saveApiKeyBtn').addEventListener('click', () => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) { toast('请先粘贴 API Key'); return; }
  storage.set(TMDB_KEY, key);
  updateApiSettings();
  $('#apiSettings').open = false;
  toast('API Key 已仅保存在当前浏览器');
});

$('#searchForm').addEventListener('submit', event => {
  event.preventDefault();
  const query = $('#searchInput').value.trim();
  if (query) searchMovies(query);
});
$('#searchResults').addEventListener('click', event => {
  const button = event.target.closest('[data-add-index]');
  if (button) addMovie(Number(button.dataset.addIndex), button).catch(() => {});
});

$$('.list-tabs button').forEach(button => button.addEventListener('click', () => {
  state.tab = button.dataset.tab;
  $$('.list-tabs button').forEach(tab => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  renderList();
}));

async function updateWatched(id, watched) {
  await applyMutation(api(`/api/movies/${id}`, {
    method: 'PATCH', body: JSON.stringify({ owner: state.identity, watched }),
  }), watched ? '已标记看完，它不会再参与抽签' : '已恢复为未看');
}

$('#movieList').addEventListener('click', event => {
  const watch = event.target.closest('[data-watch-id]');
  const remove = event.target.closest('[data-delete-id]');
  const discuss = event.target.closest('[data-discuss-tmdb]');
  if (discuss) openDiscussion(discuss.dataset.discussTmdb);
  if (watch) updateWatched(Number(watch.dataset.watchId), watch.dataset.watched === 'true').catch(() => {});
  if (remove && window.confirm(`确定从自己的片单删除《${remove.dataset.title}》吗？`)) {
    applyMutation(api(`/api/movies/${remove.dataset.deleteId}`, {
      method: 'DELETE', body: JSON.stringify({ owner: state.identity }),
    }), '已从片单删除').catch(() => {});
  }
});

$('#drawBtn').addEventListener('click', drawMovie);
$('#drawResult').addEventListener('click', event => {
  if (event.target.closest('#redrawBtn')) drawMovie();
  const watched = event.target.closest('[data-draw-watched]');
  const discuss = event.target.closest('[data-draw-discuss]');
  if (watched) updateWatched(Number(watched.dataset.drawWatched), watched.dataset.watched === 'true').catch(() => {});
  if (discuss) openDiscussion(discuss.dataset.drawDiscuss);
});

$('#closeDiscussionBtn').addEventListener('click', () => $('#discussionDialog').close());
$('#discussionContent').addEventListener('click', event => {
  const star = event.target.closest('[data-score]');
  const remove = event.target.closest('[data-delete-comment]');
  if (star) {
    applyMutation(api('/api/ratings', {
      method: 'POST',
      body: JSON.stringify({ owner: state.identity, tmdbId: state.discussionTmdb, score: Number(star.dataset.score) }),
    }), `已评 ${star.dataset.score} 星`).catch(() => {});
  }
  if (remove && window.confirm('确定删除这条评论吗？')) {
    applyMutation(api(`/api/comments/${remove.dataset.deleteComment}`, {
      method: 'DELETE', body: JSON.stringify({ owner: state.identity }),
    }), '评论已删除').catch(() => {});
  }
});
$('#discussionContent').addEventListener('submit', event => {
  if (event.target.id !== 'commentForm') return;
  event.preventDefault();
  const body = $('#commentInput').value.trim();
  if (!body) return;
  applyMutation(api('/api/comments', {
    method: 'POST', body: JSON.stringify({ owner: state.identity, tmdbId: state.discussionTmdb, body }),
  }), '评论已发表').catch(() => {});
});

$('#clearWatchedBtn').addEventListener('click', () => {
  if (!window.confirm('确定重置全部已看标记吗？雨和奇的所有影片都会恢复为未看。')) return;
  applyMutation(api('/api/reset-watched', {
    method: 'POST', body: JSON.stringify({ confirmation: true }),
  }), '所有影片已恢复为未看').catch(() => {});
});

$('#clearAllBtn').addEventListener('click', () => {
  $('#confirmInput').value = '';
  $('#confirmClearBtn').disabled = true;
  $('#confirmDialog').showModal();
  setTimeout(() => $('#confirmInput').focus(), 100);
});
$('#confirmInput').addEventListener('input', event => {
  $('#confirmClearBtn').disabled = event.target.value.trim() !== '清空全部片单';
});
$('#confirmClearBtn').addEventListener('click', event => {
  event.preventDefault();
  if ($('#confirmInput').value.trim() !== '清空全部片单') return;
  applyMutation(api('/api/clear-all', {
    method: 'POST', body: JSON.stringify({ confirmation: '清空全部片单' }),
  }), '全部片单、评分和评论已清空').then(() => $('#confirmDialog').close()).catch(() => {});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchState();
});
window.addEventListener('online', () => fetchState());

(function init() {
  updateApiSettings();
  const savedIdentity = storage.get(IDENTITY_KEY);
  if (savedIdentity === 'A' || savedIdentity === 'B') {
    state.identity = savedIdentity;
    enterRoom();
  } else {
    showIdentityPicker();
  }
})();
