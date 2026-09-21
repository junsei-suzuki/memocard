import * as db from './db.js';
import * as srs from './srs.js';
import { initMap } from './map.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const FOLDER_COLORS = ['#38bdf8','#f472b6','#a78bfa','#fb923c','#4ade80','#f87171','#facc15','#22d3ee'];
const IMP_LABEL = { 0:'', 1:'覚えた', 2:'あやしい', 3:'苦手' };

let state = {
  folders: [], cards: [], links: [],
  currentFolderId: null, currentCardId: null,
  editingCardId: null, editImportance: 0,
  editFrontImgs: [], editBackImgs: [], editLinkIds: [],
  reviewQueue: [], reviewIndex: 0, reviewShowingBack: false, reviewLinkMap: new Map(),
};

// ---------- 画面遷移 ----------
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === id));
}

$$('.tab-btn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.screen === 'reviewScreen') startReview();
  else if (b.dataset.screen === 'mapScreen') openMap();
  else if (b.dataset.screen === 'searchScreen') { showScreen('searchScreen'); $('#globalSearch').focus(); }
  else showScreen(b.dataset.screen);
}));

$('#btnSettings').addEventListener('click', () => showScreen('settingsScreen'));
$('#btnSettingsBack').addEventListener('click', () => showScreen('homeScreen'));

// ---------- データ読み込み ----------
async function reload() {
  state.folders = await db.all('folders');
  state.cards = await db.all('cards');
  state.links = await db.all('links');
}

function cardsInFolder(folderId) {
  return state.cards.filter(c => c.folderId === folderId);
}

function linksOf(cardId) {
  return state.links.filter(l => l.aId === cardId || l.bId === cardId);
}
function otherEnd(link, cardId) { return link.aId === cardId ? link.bId : link.aId; }

// ---------- ホーム ----------
async function renderHome() {
  const now = Date.now();
  const dueCards = state.cards.filter(c => c.srs.due <= now);
  $('#dueCount').textContent = dueCards.length;

  const grid = $('#folderGrid');
  grid.innerHTML = '';
  state.folders.forEach(f => {
    const n = cardsInFolder(f.id).length;
    const tile = document.createElement('button');
    tile.className = 'folder-tile';
    tile.innerHTML = `<span class="dot" style="background:${f.color}"></span>
      <span class="name">${escapeHtml(f.name)}</span>
      <span class="count">${n}枚</span>`;
    tile.addEventListener('click', () => openFolder(f.id));
    grid.appendChild(tile);
  });
  const addTile = document.createElement('button');
  addTile.className = 'folder-tile add-folder-tile';
  addTile.textContent = '＋ フォルダを作成';
  addTile.addEventListener('click', createFolder);
  grid.appendChild(addTile);
}

async function createFolder() {
  const name = prompt('フォルダ名');
  if (!name) return;
  const color = FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length];
  const folder = { id: db.uid(), name, color, parentId: null, order: state.folders.length, createdAt: Date.now() };
  await db.put('folders', folder);
  await reload();
  renderHome();
}

$('#homeSearch').addEventListener('focus', () => { showScreen('searchScreen'); $('#globalSearch').focus(); });

// ---------- フォルダ内一覧 ----------
function openFolder(id) {
  state.currentFolderId = id;
  const f = state.folders.find(x => x.id === id);
  $('#folderTitle').textContent = f ? f.name : 'フォルダ';
  renderFolderCards();
  showScreen('folderScreen');
}
$('#btnFolderBack').addEventListener('click', () => showScreen('homeScreen'));
$('#btnFolderMenu').addEventListener('click', async () => {
  const f = state.folders.find(x => x.id === state.currentFolderId);
  if (!f) return;
  const action = prompt('「rename」で名前変更、「delete」で削除', 'rename');
  if (action === 'rename') {
    const name = prompt('新しい名前', f.name);
    if (name) { f.name = name; await db.put('folders', f); await reload(); openFolder(f.id); renderHome(); }
  } else if (action === 'delete') {
    if (cardsInFolder(f.id).length && !confirm('カードが入っています。フォルダごと削除しますか？')) return;
    for (const c of cardsInFolder(f.id)) await deleteCardCascade(c.id);
    await db.remove('folders', f.id);
    await reload();
    showScreen('homeScreen'); renderHome();
  }
});

function renderFolderCards(filter = '') {
  const list = $('#cardList');
  list.innerHTML = '';
  let cards = cardsInFolder(state.currentFolderId);
  if (filter) {
    const q = filter.toLowerCase();
    cards = cards.filter(c => (c.front + c.back).toLowerCase().includes(q));
  }
  cards.sort((a,b) => a.srs.due - b.srs.due);
  $('#folderEmpty').style.display = cards.length ? 'none' : 'block';
  cards.forEach(c => {
    const row = document.createElement('div');
    row.className = `card-row imp${c.importance}`;
    const dueTxt = c.srs.due <= Date.now() ? '復習予定' : new Date(c.srs.due).toLocaleDateString('ja-JP', {month:'numeric', day:'numeric'});
    row.innerHTML = `<div class="front">${escapeHtml(truncate(c.front, 40))}</div><div class="due-badge">${dueTxt}</div>`;
    row.addEventListener('click', () => openCard(c.id));
    list.appendChild(row);
  });
}
$('#folderSearch').addEventListener('input', (e) => renderFolderCards(e.target.value));

// ---------- カード詳細 ----------
function openCard(id) {
  state.currentCardId = id;
  state.cardShowingBack = false;
  renderCardFace();
  renderCardLinks();
  showScreen('cardScreen');
}
$('#btnCardBack').addEventListener('click', () => showScreen('folderScreen'));
$('#btnCardEdit').addEventListener('click', () => openEditor(state.currentCardId));

function renderCardFace() {
  const c = state.cards.find(x => x.id === state.currentCardId);
  if (!c) return;
  const face = $('#cardFace');
  const showBack = state.cardShowingBack;
  const text = showBack ? c.back : c.front;
  const imgs = showBack ? c.backImages : c.frontImages;
  face.innerHTML = `<div>${escapeHtml(text) || '（空欄）'}</div>` +
    (imgs && imgs.length ? imgs.map(b => `<img src="${URL.createObjectURL(b)}">`).join('') : '');
}
$('#cardFace').addEventListener('click', () => { state.cardShowingBack = !state.cardShowingBack; renderCardFace(); });

function renderCardLinks() {
  const box = $('#cardLinks');
  const links = linksOf(state.currentCardId);
  if (!links.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div style="color:var(--sub); font-size:.85em; margin:10px 0 4px;">類題</div>';
  links.forEach(l => {
    const other = state.cards.find(c => c.id === otherEnd(l, state.currentCardId));
    if (!other) return;
    const f = state.folders.find(x => x.id === other.folderId);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.cursor = 'pointer';
    chip.textContent = `${f ? f.name + ' / ' : ''}${truncate(other.front, 16)}`;
    chip.addEventListener('click', () => openCard(other.id));
    box.appendChild(chip);
  });
}

async function deleteCardCascade(cardId) {
  for (const l of linksOf(cardId)) await db.remove('links', l.id);
  await db.remove('cards', cardId);
}

// ---------- カード編集 ----------
function openEditor(cardId) {
  state.editingCardId = cardId;
  const c = cardId ? state.cards.find(x => x.id === cardId) : null;
  $('#editTitle').textContent = c ? 'カードを編集' : 'カードを追加';
  $('#editFront').value = c ? c.front : '';
  $('#editBack').value = c ? c.back : '';
  state.editImportance = c ? c.importance : 0;
  state.editFrontImgs = c ? [...c.frontImages] : [];
  state.editBackImgs = c ? [...c.backImages] : [];
  state.editLinkIds = c ? linksOf(c.id).map(l => otherEnd(l, c.id)) : [];

  const sel = $('#editFolder');
  sel.innerHTML = state.folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  sel.value = c ? c.folderId : (state.currentFolderId || (state.folders[0] && state.folders[0].id) || '');

  $$('.imp-picker button').forEach(b => b.classList.toggle('sel', Number(b.dataset.i) === state.editImportance));
  renderImgRow('frontImgs', state.editFrontImgs);
  renderImgRow('backImgs', state.editBackImgs);
  renderLinkChips();
  $('#linkSearch').value = '';
  showScreen('editScreen');
}
$('#fabAdd').addEventListener('click', () => {
  if (!state.folders.length) { alert('先にフォルダを作成してください'); createFolder(); return; }
  openEditor(null);
});
$('#btnEditCancel').addEventListener('click', () => showScreen(state.editingCardId ? 'cardScreen' : (state.currentFolderId ? 'folderScreen' : 'homeScreen')));

$$('.imp-picker button').forEach(b => b.addEventListener('click', () => {
  state.editImportance = Number(b.dataset.i);
  $$('.imp-picker button').forEach(x => x.classList.toggle('sel', x === b));
}));

function renderImgRow(rowId, imgs) {
  const row = $('#' + rowId);
  row.innerHTML = '';
  imgs.forEach((blob, i) => {
    const t = document.createElement('div');
    t.className = 'img-thumb';
    t.innerHTML = `<img src="${URL.createObjectURL(blob)}"><button class="rm">✕</button>`;
    t.querySelector('.rm').addEventListener('click', () => { imgs.splice(i, 1); renderImgRow(rowId, imgs); });
    row.appendChild(t);
  });
  const add = document.createElement('button');
  add.className = 'img-add'; add.textContent = '＋';
  add.addEventListener('click', () => (rowId === 'frontImgs' ? $('#imgFileFront') : $('#imgFileBack')).click());
  row.appendChild(add);
}

async function resizeImage(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
}
$('#imgFileFront').addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  state.editFrontImgs.push(await resizeImage(e.target.files[0]));
  renderImgRow('frontImgs', state.editFrontImgs);
  e.target.value = '';
});
$('#imgFileBack').addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  state.editBackImgs.push(await resizeImage(e.target.files[0]));
  renderImgRow('backImgs', state.editBackImgs);
  e.target.value = '';
});

function renderLinkChips() {
  const box = $('#linkChips');
  box.innerHTML = '';
  state.editLinkIds.forEach(id => {
    const other = state.cards.find(c => c.id === id);
    if (!other) return;
    const f = state.folders.find(x => x.id === other.folderId);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml((f ? f.name + ' / ' : '') + truncate(other.front, 16))} <button>✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.editLinkIds = state.editLinkIds.filter(x => x !== id);
      renderLinkChips();
    });
    box.appendChild(chip);
  });
}
$('#linkSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const existing = $('#linkSearchResults');
  if (existing) existing.remove();
  if (!q) return;
  const results = state.cards
    .filter(c => c.id !== state.editingCardId && !state.editLinkIds.includes(c.id))
    .filter(c => (c.front + c.back).toLowerCase().includes(q))
    .slice(0, 8);
  const box = document.createElement('div');
  box.id = 'linkSearchResults';
  box.style.cssText = 'background:var(--panel2); border:1px solid var(--line); border-radius:8px; margin-top:6px; max-height:200px; overflow-y:auto;';
  results.forEach(c => {
    const f = state.folders.find(x => x.id === c.folderId);
    const item = document.createElement('div');
    item.className = 'search-result';
    item.innerHTML = `${escapeHtml(truncate(c.front, 30))}<small>${f ? escapeHtml(f.name) : ''}</small>`;
    item.addEventListener('click', () => {
      state.editLinkIds.push(c.id);
      renderLinkChips();
      $('#linkSearch').value = '';
      box.remove();
    });
    box.appendChild(item);
  });
  $('#linkSearch').insertAdjacentElement('afterend', box);
});

$('#btnEditSave').addEventListener('click', async () => {
  const front = $('#editFront').value.trim();
  const back = $('#editBack').value.trim();
  if (!front && !back) { alert('表か裏に何か入力してください'); return; }
  const folderId = $('#editFolder').value;
  const isNew = !state.editingCardId;
  const id = state.editingCardId || db.uid();
  const existing = isNew ? null : state.cards.find(c => c.id === id);

  const card = {
    id, folderId,
    front, back,
    frontImages: state.editFrontImgs,
    backImages: state.editBackImgs,
    importance: state.editImportance,
    tags: existing ? existing.tags : [],
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now(),
    srs: existing ? existing.srs : srs.initial(),
  };
  await db.put('cards', card);

  // リンクの差分を反映（無向。aId<bId に正規化して重複を防ぐ）
  const prevLinkIds = isNew ? [] : linksOf(id).map(l => otherEnd(l, id));
  const toAdd = state.editLinkIds.filter(x => !prevLinkIds.includes(x));
  const toRemove = isNew ? [] : linksOf(id).filter(l => !state.editLinkIds.includes(otherEnd(l, id)));
  for (const l of toRemove) await db.remove('links', l.id);
  for (const otherId of toAdd) {
    const [aId, bId] = [id, otherId].sort();
    await db.put('links', { id: db.uid(), aId, bId, kind: 'similar', label: '', note: '', createdAt: Date.now() });
  }

  await reload();
  state.currentCardId = id;
  renderHome();
  if (state.currentFolderId) renderFolderCards();
  openCard(id);
});

// ---------- 検索 ----------
$('#globalSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const box = $('#searchResults');
  box.innerHTML = '';
  if (!q) return;
  const results = state.cards.filter(c =>
    (c.front + ' ' + c.back + ' ' + c.tags.join(' ')).toLowerCase().includes(q));
  results.forEach(c => {
    const f = state.folders.find(x => x.id === c.folderId);
    const item = document.createElement('div');
    item.className = 'search-result';
    item.innerHTML = `${escapeHtml(truncate(c.front, 40))}<small>${f ? escapeHtml(f.name) : ''}</small>`;
    item.addEventListener('click', () => openCard(c.id));
    box.appendChild(item);
  });
  if (!results.length) box.innerHTML = '<div class="empty">見つかりませんでした</div>';
});

// ---------- 復習 ----------
function startReview() {
  const now = Date.now();
  state.reviewQueue = state.cards.filter(c => c.srs.due <= now).sort((a,b) => a.srs.due - b.srs.due);
  state.reviewIndex = 0;
  state.reviewShowingBack = false;
  if (!state.reviewQueue.length) {
    showScreen('reviewScreen');
    $('#reviewProgress').textContent = '復習';
    $('#reviewFace').innerHTML = '<div>今日の復習は終わりました🎉</div>';
    $('#gradeRow').style.display = 'none';
    $('#reviewHint').textContent = '';
    return;
  }
  showScreen('reviewScreen');
  renderReviewCard();
}

function currentReviewCard() { return state.reviewQueue[state.reviewIndex]; }

function renderReviewCard() {
  const c = currentReviewCard();
  if (!c) { finishReview(); return; }
  $('#reviewProgress').textContent = `復習 ${state.reviewIndex + 1}/${state.reviewQueue.length}`;
  state.reviewShowingBack = false;
  const text = c.front;
  $('#reviewFace').innerHTML = `<div>${escapeHtml(text) || '（空欄）'}</div>` +
    (c.frontImages && c.frontImages.length ? c.frontImages.map(b => `<img src="${URL.createObjectURL(b)}">`).join('') : '');
  $('#reviewHint').textContent = 'タップで裏を見る';
  $('#gradeRow').style.display = 'none';
}

$('#reviewFace').addEventListener('click', () => {
  const c = currentReviewCard();
  if (!c || state.reviewShowingBack) return;
  state.reviewShowingBack = true;
  $('#reviewFace').innerHTML = `<div>${escapeHtml(c.back) || '（空欄）'}</div>` +
    (c.backImages && c.backImages.length ? c.backImages.map(b => `<img src="${URL.createObjectURL(b)}">`).join('') : '');
  $('#reviewHint').textContent = '';
  $('#gradeRow').style.display = 'flex';
});

$('#gradeRow').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-g]');
  if (!btn) return;
  const grade = btn.dataset.g;
  const c = currentReviewCard();
  if (!c) return;

  c.srs = srs.next(c.srs, grade, c.importance);
  const toWrite = [c];

  // 類題重点復習: 落としたら1ホップだけ今日に引き寄せる
  const focusLinked = $('#focusLinked').checked;
  if ((grade === 'again' || grade === 'hard')) {
    for (const l of linksOf(c.id)) {
      const other = state.cards.find(x => x.id === otherEnd(l, c.id));
      if (!other) continue;
      other.srs = srs.pullDue(other.srs);
      toWrite.push(other);
      if (focusLinked && !state.reviewQueue.some(q => q.id === other.id)) {
        state.reviewQueue.push(other);
      }
    }
  }
  await db.putMany('cards', toWrite);
  await reload();

  if (grade === 'again') {
    // 当日中にもう一度出すので、末尾に積み直す
    state.reviewQueue.push(state.reviewQueue[state.reviewIndex]);
  }
  state.reviewIndex++;
  renderReviewCard();
  renderHome();
});

function finishReview() {
  $('#reviewProgress').textContent = '復習';
  $('#reviewFace').innerHTML = '<div>今日の復習は終わりました🎉</div>';
  $('#gradeRow').style.display = 'none';
  $('#reviewHint').textContent = '';
  updateBadge();
}
$('#btnReviewClose').addEventListener('click', () => showScreen('homeScreen'));
$('#btnStartReview').addEventListener('click', startReview);

// ---------- マップ ----------
const CUSTOM_MAP_ID = 'map:custom';

async function addCardToCustomMap(cardId) {
  let map = await db.get('maps', CUSTOM_MAP_ID);
  if (!map) {
    map = { id: CUSTOM_MAP_ID, name: 'カードマップ', scope: { type: 'custom', cardIds: [] },
      nodes: {}, groups: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
  if (!map.scope.cardIds) map.scope.cardIds = [];
  if (map.scope.cardIds.includes(cardId)) {
    alert('すでにカードマップに追加されています');
    return;
  }
  map.scope.cardIds.push(cardId);
  await db.put('maps', map);
  if (confirm('カードマップに複製しました。今すぐマップを開きますか？')) {
    showScreen('mapScreen');
    openMap('custom');
  }
}
$('#btnCardToMap').addEventListener('click', () => addCardToCustomMap(state.currentCardId));

let mapController = null;
function openMap(forceScope) {
  const sel = $('#mapScope');
  sel.innerHTML = '<option value="custom">カードマップ（追加したカード）</option><option value="all">すべて</option>' +
    state.folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  if (forceScope) sel.value = forceScope;
  showScreen('mapScreen');
  if (!mapController) {
    mapController = initMap({
      canvas: $('#mapCanvas'),
      getState: () => state,
      onOpenCard: openCard,
      saveMap: (m) => db.put('maps', m),
      getMap: (id) => db.get('maps', id),
    });
  }
  mapController.setScope(sel.value);
  mapController.start();
}
$('#btnMapBack').addEventListener('click', () => { mapController && mapController.stop(); showScreen('homeScreen'); });
$('#mapScope').addEventListener('change', (e) => mapController && mapController.setScope(e.target.value));
$('#btnMapReflow').addEventListener('click', () => mapController && mapController.reflow());

// ---------- バックアップ ----------
$('#btnExport').addEventListener('click', async () => {
  const blobToB64 = (b) => new Promise(res => {
    const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b);
  });
  const cards = [];
  for (const c of state.cards) {
    cards.push({
      ...c,
      frontImages: await Promise.all(c.frontImages.map(blobToB64)),
      backImages: await Promise.all(c.backImages.map(blobToB64)),
    });
  }
  const data = { version: 1, exportedAt: Date.now(), folders: state.folders, cards, links: state.links };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `memocard-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('現在のデータに読み込んだ内容を追加します。よろしいですか？')) { e.target.value=''; return; }
  const data = JSON.parse(await file.text());
  const b64ToBlob = (s) => fetch(s).then(r => r.blob());
  for (const f of data.folders) await db.put('folders', f);
  for (const c of data.cards) {
    await db.put('cards', {
      ...c,
      frontImages: await Promise.all(c.frontImages.map(b64ToBlob)),
      backImages: await Promise.all(c.backImages.map(b64ToBlob)),
    });
  }
  for (const l of data.links) await db.put('links', l);
  await reload();
  renderHome();
  alert('読み込みました');
  e.target.value = '';
});

// ---------- 通知バッジ ----------
async function updateBadge() {
  const n = state.cards.filter(c => c.srs.due <= Date.now()).length;
  if ('setAppBadge' in navigator) {
    try { n > 0 ? await navigator.setAppBadge(n) : await navigator.clearAppBadge(); } catch {}
  }
}
$('#btnNotifPermission').addEventListener('click', async () => {
  if ('Notification' in window) {
    const perm = await Notification.requestPermission();
    alert(perm === 'granted' ? '通知を許可しました' : '許可されませんでした');
  } else {
    alert('この端末は通知に対応していません');
  }
});

// ---------- ユーティリティ ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function truncate(s, n) { return (s || '').length > n ? s.slice(0, n) + '…' : (s || ''); }

// ---------- 起動 ----------
async function boot() {
  await reload();
  renderHome();
  updateBadge();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
boot();
