/* カードマップ（KJ法ボード）。canvas 一枚に全部描く。
   DOM ノードを何百枚も動かすとスマホで重くなるので、ここは当たり判定も自前で持つ。 */

const NODE_W = 130, NODE_H = 70;
const LONG_PRESS_MS = 420;
const DOUBLE_TAP_MS = 350;
const MOVE_THRESHOLD = 6; // これ未満の移動は「動いていない」とみなす（タップ/長押しの判定用）
const ZOOM_MIN = 0.3, ZOOM_MAX = 2.5;
const GROUP_MIN_W = 90, GROUP_MIN_H = 70;
const CHILD_SCALE = 0.72; // 包含されたカードを少し小さく描く倍率

// 白基調のテーマに合わせた配色（index.html の CSS 変数と揃えている）
const PALETTE = {
  bg: '#f8fafc',
  nodeFill: '#ffffff',
  nodeBack: '#eef2ff',
  containerFill: '#f1f5f9',
  text: '#0f172a',
  sub: '#64748b',
  line: '#cbd5e1',
  link: '#94a3b899',
  accent: '#0284c7',
  imp: { 0: '#94a3b8', 1: '#0284c7', 2: '#ca8a04', 3: '#dc2626' },
};

export function initMap({ canvas, getState, onOpenCard, onDeleteCard, saveMap, getMap }) {
  const ctx = canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;

  let scope = 'all';
  let mapId = 'map:all';
  let map = emptyMap(mapId, { type: 'all' });

  let cards = [];       // このスコープに含まれるカード
  let linkPairs = [];   // 類題（破線で自動表示）
  let lastLayout = null; // 直近の描画で計算した配置（当たり判定にも使う）

  let raf = null;
  let dirty = true;

  // 操作状態
  let touchMode = null; // 'pending' | 'drag' | 'connect' | 'group-drag' | 'group-resize' | 'pan' | 'pending-blank' | null
  let dragNodeId = null;
  let dragParentId = null;      // カードが包含カードの中身をドラッグで抜け出しているとき、元の親
  let draggingChildFloat = null; // 抜け出し中のカードの現在位置（ワールド座標）
  let dragGroupId = null;
  let dragOffset = { x: 0, y: 0 };
  let resizeStart = null;
  let connectFrom = null;
  let connectPoint = null;
  let longPressTimer = null;
  let lastPan = null;
  let pinchStart = null;
  let selectedEdge = null;
  let flippedIds = new Set(); // タップして裏を表示中のカード
  let lastTapId = null;
  let lastTapTime = 0;

  function emptyMap(id, scopeObj) {
    return { id, name: '', scope: scopeObj, nodes: {}, groups: [], edges: [], containers: {}, viewport: { x: 0, y: 0, zoom: 1 } };
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    dirty = true;
  }
  window.addEventListener('resize', resize);

  function screenToWorld(x, y) {
    return { x: x / map.viewport.zoom - map.viewport.x, y: y / map.viewport.zoom - map.viewport.y };
  }
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function viewCenterWorld() {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(rect.width / 2, rect.height / 2);
  }

  // ---------- 包含関係のヘルパー ----------
  function containerOf(cardId) {
    for (const pid of Object.keys(map.containers)) {
      if (map.containers[pid].includes(cardId)) return pid;
    }
    return null;
  }
  function isContainer(cardId) { return !!(map.containers[cardId] && map.containers[cardId].length); }
  function topLevelCards() { return cards.filter(c => !containerOf(c.id)); }

  function childCellSize() { return { w: Math.round(NODE_W * CHILD_SCALE), h: Math.round(NODE_H * CHILD_SCALE) }; }

  function computeContainerLayout(parentId) {
    const kids = (map.containers[parentId] || []).filter(id => !(dragParentId === parentId && id === dragNodeId));
    const n = Math.max(1, kids.length);
    const cols = kids.length <= 1 ? 1 : kids.length <= 4 ? 2 : 3;
    const rows = Math.ceil(kids.length / cols) || 1;
    const { w: cw, h: ch } = childCellSize();
    const gap = 8, pad = 10, headerH = 26;
    const innerW = cols * cw + (cols - 1) * gap;
    const innerH = rows * ch + (rows - 1) * gap;
    const boxW = Math.max(NODE_W * 1.15, innerW + pad * 2);
    const boxH = headerH + innerH + pad * 2;
    return { kids, cols, rows, cw, ch, gap, pad, headerH, boxW, boxH };
  }

  function attachToContainer(parentId, childId) {
    if (!parentId || !childId || parentId === childId) return false;
    if (isContainer(childId)) return false; // 入れ子（包含の中に包含）は作らない
    if (!map.containers[parentId]) map.containers[parentId] = [];
    if (!map.containers[parentId].includes(childId)) map.containers[parentId].push(childId);
    return true;
  }
  function removeFromContainer(parentId, childId) {
    if (!map.containers[parentId]) return;
    map.containers[parentId] = map.containers[parentId].filter(id => id !== childId);
    if (!map.containers[parentId].length) delete map.containers[parentId];
  }

  // ---------- スコープの読み込み ----------
  async function setScope(newScope) {
    scope = newScope;
    mapId = 'map:' + scope;
    const state = getState();
    cards = scope === 'all' ? state.cards.slice() : state.cards.filter(c => c.folderId === scope);

    const loaded = await getMap(mapId);
    map = loaded || emptyMap(mapId, scope === 'all' ? { type: 'all' } : { type: 'folder', folderId: scope });
    if (!map.containers) map.containers = {}; // 旧バージョンのマップを開いたときの後方互換

    flippedIds.clear();

    // 新規カードには座標がないので、まだ配置されていない分だけ、今見えている範囲の中心付近に散らす
    const missing = topLevelCards().filter(c => !map.nodes[c.id]);
    if (missing.length) scatter(missing);

    computeLinkPairs();
    dirty = true;
    persist();
  }

  function computeLinkPairs() {
    const state = getState();
    const idSet = new Set(cards.map(c => c.id));
    linkPairs = state.links.filter(l => idSet.has(l.aId) && idSet.has(l.bId));
  }

  function scatter(list) {
    // 簡易力学配置: 今見えている範囲の中心を基準に円状に初期配置してから、反発だけ何十回か回す。
    // 画面の中心を基準にすることで、横幅の狭いスマホでも画面外に飛び出さないようにする。
    const n = list.length;
    const center = viewCenterWorld();
    const r = 60 + n * 12;
    list.forEach((c, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      map.nodes[c.id] = { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
    });
    for (let iter = 0; iter < 40; iter++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = map.nodes[list[i].id], b = map.nodes[list[j].id];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const min = NODE_W * 1.1;
          if (dist < min) {
            const push = (min - dist) / 2;
            const ux = dx / dist, uy = dy / dist;
            a.x -= ux * push; a.y -= uy * push;
            b.x += ux * push; b.y += uy * push;
          }
        }
      }
    }
  }

  function reflow() {
    scatter(topLevelCards());
    dirty = true;
    persist();
  }

  function persist() { saveMap(JSON.parse(JSON.stringify(map))).catch(() => {}); }

  /** カードがフォルダ画面などから削除されたとき、マップ側の参照も掃除する */
  function removeCard(cardId) {
    cards = cards.filter(c => c.id !== cardId);
    const wasPos = map.nodes[cardId] || viewCenterWorld();

    if (map.containers[cardId]) {
      // 自分が包含カードだった場合、中身は元の位置あたりへ解放する
      map.containers[cardId].forEach((kid, i) => {
        map.nodes[kid] = { x: wasPos.x + (i % 3 - 1) * 90, y: wasPos.y + Math.floor(i / 3) * 70 + 90 };
      });
      delete map.containers[cardId];
    }
    for (const pid of Object.keys(map.containers)) removeFromContainer(pid, cardId);

    delete map.nodes[cardId];
    map.edges = map.edges.filter(e => e.aId !== cardId && e.bId !== cardId);
    linkPairs = linkPairs.filter(l => l.aId !== cardId && l.bId !== cardId);
    flippedIds.delete(cardId);
    dirty = true;
    persist();
  }

  // ---------- レイアウト計算（描画と当たり判定の両方で使う） ----------
  function layoutFrame() {
    const posOf = new Map();  // 線をつなぐ中心点
    const boxOf = new Map();  // カード本体・包含カードの箱（左上+幅高さ）
    const childRects = new Map(); // 包含された中のカード

    topLevelCards().forEach(c => {
      const p = map.nodes[c.id];
      if (!p) return;
      if (isContainer(c.id)) {
        const L = computeContainerLayout(c.id);
        const x = p.x - L.boxW / 2, y = p.y - L.boxH / 2;
        boxOf.set(c.id, { x, y, w: L.boxW, h: L.boxH, isContainer: true, layout: L });
        posOf.set(c.id, { x: p.x, y: y + L.headerH / 2 });
        L.kids.forEach((kid, i) => {
          const col = i % L.cols, row = Math.floor(i / L.cols);
          const cx = x + L.pad + col * (L.cw + L.gap) + L.cw / 2;
          const cy = y + L.headerH + L.pad + row * (L.ch + L.gap) + L.ch / 2;
          const r = { x: cx - L.cw / 2, y: cy - L.ch / 2, w: L.cw, h: L.ch, parentId: c.id };
          childRects.set(kid, r);
          posOf.set(kid, { x: cx, y: cy });
        });
      } else {
        const x = p.x - NODE_W / 2, y = p.y - NODE_H / 2;
        boxOf.set(c.id, { x, y, w: NODE_W, h: NODE_H, isContainer: false });
        posOf.set(c.id, { x: p.x, y: p.y });
      }
    });
    return { posOf, boxOf, childRects };
  }

  // ---------- 当たり判定 ----------
  function hitTestAt(worldX, worldY) {
    const L = lastLayout || layoutFrame();
    for (const [cardId, r] of L.childRects) {
      if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) return { type: 'child', cardId, parentId: r.parentId };
    }
    const top = topLevelCards();
    for (let i = top.length - 1; i >= 0; i--) {
      const c = top[i];
      const b = L.boxOf.get(c.id);
      if (!b) continue;
      if (worldX >= b.x && worldX <= b.x + b.w && worldY >= b.y && worldY <= b.y + b.h) return { type: 'card', cardId: c.id };
    }
    return null;
  }
  function topLevelCardAt(worldX, worldY, excludeId) {
    const L = lastLayout || layoutFrame();
    const top = topLevelCards();
    for (let i = top.length - 1; i >= 0; i--) {
      const c = top[i];
      if (c.id === excludeId) continue;
      const b = L.boxOf.get(c.id);
      if (!b) continue;
      if (worldX >= b.x && worldX <= b.x + b.w && worldY >= b.y && worldY <= b.y + b.h) return c;
    }
    return null;
  }
  function currentCenterOf(cardId) {
    const L = lastLayout || layoutFrame();
    const r = L.childRects.get(cardId);
    if (r) return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const b = L.boxOf.get(cardId);
    if (b) return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    return map.nodes[cardId] || { x: 0, y: 0 };
  }

  function groupAt(worldX, worldY) {
    for (let i = map.groups.length - 1; i >= 0; i--) {
      const g = map.groups[i];
      if (worldX >= g.x && worldX <= g.x + g.w && worldY >= g.y && worldY <= g.y + g.h) return g;
    }
    return null;
  }
  function groupResizeHandleAt(worldX, worldY) {
    const HANDLE = 22;
    for (let i = map.groups.length - 1; i >= 0; i--) {
      const g = map.groups[i];
      if (worldX >= g.x + g.w - HANDLE && worldX <= g.x + g.w + 6 && worldY >= g.y + g.h - HANDLE && worldY <= g.y + g.h + 6) return g;
    }
    return null;
  }
  function edgeAt(worldX, worldY) {
    const L = lastLayout || layoutFrame();
    const all = [...map.edges.map(e => ({ ...e, auto: false })),
                 ...linkPairs.map(l => ({ aId: l.aId, bId: l.bId, auto: true }))];
    for (const e of all) {
      const a = L.posOf.get(e.aId), b = L.posOf.get(e.bId);
      if (!a || !b) continue;
      const d = distToSegment(worldX, worldY, a.x, a.y, b.x, b.y);
      if (d < 14) return e.auto ? null : map.edges.find(x => x.id === e.id);
    }
    return null;
  }
  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // ---------- 入力 ----------
  function onDown(e) {
    e.preventDefault();
    if (e.touches && e.touches.length >= 2) {
      clearTimeout(longPressTimer);
      touchMode = 'pinch';
      startPinch(e);
      return;
    }
    const p = pointerPos(e);
    const w = screenToWorld(p.x, p.y);
    const hit = hitTestAt(w.x, w.y);
    const resizeHandle = !hit && groupResizeHandleAt(w.x, w.y);
    const group = !hit && !resizeHandle && groupAt(w.x, w.y);
    const edge = !hit && !resizeHandle && !group && edgeAt(w.x, w.y);

    if (edge) { selectedEdge = edge; showEdgeMenu(edge); return; }

    if (resizeHandle) {
      dragGroupId = resizeHandle.id;
      resizeStart = { w: resizeHandle.w, h: resizeHandle.h, wx: w.x, wy: w.y };
      touchMode = 'group-resize';
      lastPan = p;
      return;
    }

    if (hit) {
      dragNodeId = hit.cardId;
      dragParentId = hit.type === 'child' ? hit.parentId : null;
      const origin = currentCenterOf(hit.cardId);
      dragOffset = { x: w.x - origin.x, y: w.y - origin.y };
      touchMode = 'pending'; // タップかドラッグか長押しか、動きを見て確定する
      lastPan = p;
      if (!dragParentId) {
        // 包含されている中のカードからは、線を引く操作を開始しない（単純化のため）
        longPressTimer = setTimeout(() => {
          touchMode = 'connect';
          connectFrom = hit.cardId;
          connectPoint = w;
          dirty = true;
        }, LONG_PRESS_MS);
      }
      return;
    }

    if (group) {
      dragGroupId = group.id;
      dragOffset = { x: w.x - group.x, y: w.y - group.y };
      touchMode = 'group-drag';
      lastPan = p;
      return;
    }

    // 空白: 長押しで枠作成、そうでなければパン
    touchMode = 'pending-blank';
    lastPan = p;
    longPressTimer = setTimeout(() => {
      touchMode = null;
      createGroupAt(w);
    }, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (touchMode === 'pinch' || (e.touches && e.touches.length >= 2)) { movePinch(e); return; }
    const p = pointerPos(e);
    const w = screenToWorld(p.x, p.y);

    if (touchMode === 'pending' || touchMode === 'drag') {
      const moved = lastPan && Math.hypot(p.x - lastPan.x, p.y - lastPan.y) > MOVE_THRESHOLD;
      if (moved || touchMode === 'drag') {
        clearTimeout(longPressTimer);
        touchMode = 'drag';
        const pos = { x: w.x - dragOffset.x, y: w.y - dragOffset.y };
        if (dragParentId) { draggingChildFloat = pos; } else { map.nodes[dragNodeId] = pos; }
        dirty = true;
      }
    } else if (touchMode === 'connect') {
      connectPoint = w;
      dirty = true;
    } else if (touchMode === 'group-resize') {
      const g = map.groups.find(x => x.id === dragGroupId);
      if (g && resizeStart) {
        g.w = Math.max(GROUP_MIN_W, resizeStart.w + (w.x - resizeStart.wx));
        g.h = Math.max(GROUP_MIN_H, resizeStart.h + (w.y - resizeStart.wy));
        dirty = true;
      }
    } else if (touchMode === 'group-drag') {
      const g = map.groups.find(x => x.id === dragGroupId);
      if (g) {
        const nx = w.x - dragOffset.x, ny = w.y - dragOffset.y;
        const dx = nx - g.x, dy = ny - g.y;
        g.x = nx; g.y = ny;
        // 枠の中にあったカードも一緒に動かす（包含された中のカードは親と一緒に動くので対象外）
        topLevelCards().forEach(c => {
          const pos = map.nodes[c.id];
          if (pos && pos.x >= g.x - dx && pos.x <= g.x - dx + g.w && pos.y >= g.y - dy && pos.y <= g.y - dy + g.h) {
            pos.x += dx; pos.y += dy;
          }
        });
        dirty = true;
      }
    } else if (touchMode === 'pending-blank' || touchMode === 'pan') {
      const moved = lastPan && Math.hypot(p.x - lastPan.x, p.y - lastPan.y) > MOVE_THRESHOLD;
      if (moved) {
        clearTimeout(longPressTimer);
        touchMode = 'pan';
        map.viewport.x += (p.x - lastPan.x) / map.viewport.zoom;
        map.viewport.y += (p.y - lastPan.y) / map.viewport.zoom;
        lastPan = p;
        dirty = true;
      }
    }
  }

  function onUp(e) {
    clearTimeout(longPressTimer);
    const remaining = e.touches ? e.touches.length : 0;

    if (touchMode === 'pinch') {
      if (remaining === 0) { touchMode = null; pinchStart = null; }
      dirty = true;
      return;
    }

    if (touchMode === 'pending' && dragNodeId) {
      // 動かずに離した = タップ。1回だけなら裏表を切りかえ、素早く2回タップしたら詳細を開く
      const cardId = dragNodeId;
      const now = Date.now();
      if (lastTapId === cardId && now - lastTapTime < DOUBLE_TAP_MS) {
        lastTapId = null; lastTapTime = 0;
        onOpenCard(cardId);
      } else {
        lastTapId = cardId; lastTapTime = now;
        if (flippedIds.has(cardId)) flippedIds.delete(cardId); else flippedIds.add(cardId);
        dirty = true;
      }
    } else if (touchMode === 'connect' && connectFrom) {
      const w = connectPoint;
      const target = topLevelCardAt(w.x, w.y, connectFrom);
      if (target) {
        map.edges.push({ id: 'e' + Date.now(), aId: connectFrom, bId: target.id, kind: 'line', label: '' });
        persist();
      } else {
        // 相手を選ばずに長押しだけで離した場合は、カードの操作メニューを出す
        showNodeMenu(connectFrom);
      }
      connectFrom = null; connectPoint = null;
    } else if (touchMode === 'drag' && dragParentId && draggingChildFloat) {
      // 包含カードの中から、別の場所へドラッグして離した
      const pos = draggingChildFloat;
      const oldParent = dragParentId;
      const target = topLevelCardAt(pos.x, pos.y, dragNodeId);
      removeFromContainer(oldParent, dragNodeId);
      if (target) {
        attachToContainer(target.id, dragNodeId);
      } else {
        map.nodes[dragNodeId] = pos; // 空所に離したら独立したカードに戻す
      }
      draggingChildFloat = null;
      persist();
    } else if (touchMode === 'drag' && !dragParentId) {
      // 通常のカード（包含カードも含む）をドラッグして離した。他のカードの上なら包含関係にする
      const pos = map.nodes[dragNodeId];
      if (pos && !isContainer(dragNodeId)) {
        const target = topLevelCardAt(pos.x, pos.y, dragNodeId);
        if (target) attachToContainer(target.id, dragNodeId);
      }
      persist();
    } else if (touchMode === 'group-drag' || touchMode === 'group-resize') {
      persist();
    }

    touchMode = null; dragNodeId = null; dragParentId = null; draggingChildFloat = null;
    dragGroupId = null; resizeStart = null;
    pinchStart = null;
    dirty = true;
  }

  function startPinch(e) {
    const [a, b] = e.touches;
    pinchStart = {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      zoom: map.viewport.zoom,
    };
  }
  function movePinch(e) {
    if (!e.touches || e.touches.length < 2) return;
    if (!pinchStart) return startPinch(e);
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    map.viewport.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStart.zoom * (dist / pinchStart.dist)));
    dirty = true;
  }
  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    map.viewport.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, map.viewport.zoom * factor));
    dirty = true;
  }

  function createGroupAt(w) {
    const title = prompt('グループのタイトル', 'グループ');
    if (title === null) return;
    map.groups.push({ id: 'g' + Date.now(), title, color: PALETTE.accent, x: w.x - 90, y: w.y - 60, w: 180, h: 120 });
    dirty = true;
    persist();
  }

  function showNodeMenu(cardId) {
    const choice = prompt('削除する場合は d を入力してください（キャンセルは空欄のままOK）');
    if (choice === 'd') onDeleteCard(cardId);
  }

  function showEdgeMenu(edge) {
    const choice = prompt('矢印(a) / 線(l) / 削除(d) / ラベル(それ以外を入力)', edge.kind === 'arrow' ? 'a' : 'l');
    if (choice === null) return;
    if (choice === 'd') {
      map.edges = map.edges.filter(x => x.id !== edge.id);
    } else if (choice === 'a') {
      edge.kind = 'arrow';
    } else if (choice === 'l') {
      edge.kind = 'line';
    } else {
      edge.label = choice;
    }
    dirty = true;
    persist();
  }

  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp);
  canvas.addEventListener('touchcancel', onUp);
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', (e) => { if (touchMode) onMove(e); });
  window.addEventListener('mouseup', (e) => { if (touchMode) onUp(e); });

  // ---------- 描画 ----------
  function draw() {
    if (!dirty) { raf = requestAnimationFrame(draw); return; }
    dirty = false;
    lastLayout = layoutFrame();
    const L = lastLayout;
    const cardsById = new Map(cards.map(c => [c.id, c]));

    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w / dpr, h / dpr);
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, w / dpr, h / dpr);

    ctx.save();
    ctx.translate(map.viewport.x * map.viewport.zoom, map.viewport.y * map.viewport.zoom);
    ctx.scale(map.viewport.zoom, map.viewport.zoom);

    // グループ枠
    map.groups.forEach(g => {
      ctx.strokeStyle = g.color; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.strokeRect(g.x, g.y, g.w, g.h);
      ctx.fillStyle = g.color + '1a';
      ctx.fillRect(g.x, g.y, g.w, g.h);
      ctx.fillStyle = g.color; ctx.font = '13px sans-serif';
      ctx.fillText(g.title, g.x + 6, g.y - 6);
      // 大きさを変えるハンドル
      ctx.fillStyle = g.color;
      ctx.beginPath();
      ctx.moveTo(g.x + g.w - 12, g.y + g.h);
      ctx.lineTo(g.x + g.w, g.y + g.h);
      ctx.lineTo(g.x + g.w, g.y + g.h - 12);
      ctx.closePath();
      ctx.fill();
    });

    // 類題リンク（破線、自動）
    ctx.strokeStyle = PALETTE.link; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
    linkPairs.forEach(l => {
      const a = L.posOf.get(l.aId), b = L.posOf.get(l.bId);
      if (!a || !b) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    // 手描きの線・矢印
    ctx.setLineDash([]);
    map.edges.forEach(edge => {
      const a = L.posOf.get(edge.aId), b = L.posOf.get(edge.bId);
      if (!a || !b) return;
      ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (edge.kind === 'arrow') drawArrowHead(a, b);
      if (edge.label) {
        ctx.fillStyle = PALETTE.text; ctx.font = '12px sans-serif';
        ctx.fillText(edge.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
      }
    });

    // 接続中のプレビュー線
    if (touchMode === 'connect' && connectFrom && connectPoint) {
      const a = L.posOf.get(connectFrom);
      if (a) {
        ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(connectPoint.x, connectPoint.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // カード・包含カード
    topLevelCards().forEach(c => {
      const b = L.boxOf.get(c.id);
      if (!b) return;
      if (b.isContainer) drawContainer(c, b, L, cardsById);
      else drawPlainCard(c, b);
    });

    // 包含カードから抜け出してドラッグ中のカードを、一番上に浮かせて描く
    if (dragParentId && draggingChildFloat && dragNodeId) {
      const floating = cardsById.get(dragNodeId);
      if (floating) drawFloatingCard(floating, draggingChildFloat);
    }

    ctx.restore();
    ctx.restore();
    raf = requestAnimationFrame(draw);
  }

  function drawPlainCard(c, b) {
    const flipped = flippedIds.has(c.id);
    ctx.fillStyle = flipped ? PALETTE.nodeBack : PALETTE.nodeFill;
    ctx.strokeStyle = PALETTE.imp[c.importance] ?? PALETTE.imp[0];
    ctx.lineWidth = 2.5;
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = PALETTE.text; ctx.font = '13px sans-serif';
    wrapText((flipped ? c.back : c.front) || '(空欄)', b.x + 10, b.y + 24, b.w - 20, 16, 2);
    if (flipped) {
      ctx.fillStyle = PALETTE.sub; ctx.font = '10px sans-serif';
      ctx.fillText('裏', b.x + b.w - 18, b.y + 14);
    }
  }

  function drawFloatingCard(c, pos) {
    const flipped = flippedIds.has(c.id);
    const x = pos.x - NODE_W / 2, y = pos.y - NODE_H / 2;
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = flipped ? PALETTE.nodeBack : PALETTE.nodeFill;
    ctx.strokeStyle = PALETTE.imp[c.importance] ?? PALETTE.imp[0];
    ctx.lineWidth = 2.5;
    roundRect(x, y, NODE_W, NODE_H, 10);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PALETTE.text; ctx.font = '13px sans-serif';
    wrapText((flipped ? c.back : c.front) || '(空欄)', x + 10, y + 24, NODE_W - 20, 16, 2);
  }

  function drawContainer(c, b, L, cardsById) {
    ctx.fillStyle = PALETTE.containerFill;
    ctx.strokeStyle = PALETTE.imp[c.importance] ?? PALETTE.imp[0];
    ctx.lineWidth = 2.5;
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill(); ctx.stroke();

    // ヘッダー: 包含カード自身の表裏（タップで裏表が切りかわる。中のカードとは別領域なので隠れない）
    const flipped = flippedIds.has(c.id);
    ctx.fillStyle = PALETTE.text; ctx.font = '12px sans-serif';
    ctx.fillText(ellipsize((flipped ? c.back : c.front) || '(空欄)', b.w - 16), b.x + 8, b.y + 18);
    ctx.strokeStyle = PALETTE.line; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(b.x + 6, b.y + b.layout.headerH); ctx.lineTo(b.x + b.w - 6, b.y + b.layout.headerH); ctx.stroke();

    // 中のカード
    b.layout.kids.forEach(kid => {
      const r = L.childRects.get(kid);
      const kc = cardsById.get(kid);
      if (!r || !kc) return;
      const kflipped = flippedIds.has(kid);
      ctx.fillStyle = kflipped ? PALETTE.nodeBack : PALETTE.nodeFill;
      ctx.strokeStyle = PALETTE.imp[kc.importance] ?? PALETTE.imp[0];
      ctx.lineWidth = 1.5;
      roundRect(r.x, r.y, r.w, r.h, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = PALETTE.text; ctx.font = '10px sans-serif';
      wrapText((kflipped ? kc.back : kc.front) || '(空欄)', r.x + 5, r.y + 13, r.w - 10, 11, 2);
    });
  }

  function drawArrowHead(a, b) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 10;
    const tx = b.x - Math.cos(angle) * (NODE_W / 2);
    const ty = b.y - Math.sin(angle) * (NODE_H / 2);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - len * Math.cos(angle - Math.PI / 6), ty - len * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tx - len * Math.cos(angle + Math.PI / 6), ty - len * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = PALETTE.accent;
    ctx.fill();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function ellipsize(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }
  function wrapText(text, x, y, maxWidth, lineHeight, maxLines) {
    const words = text.split('');
    let line = '', lines = 0;
    for (let i = 0; i < words.length && lines < maxLines; i++) {
      const test = line + words[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y + lines * lineHeight);
        line = words[i];
        lines++;
      } else {
        line = test;
      }
    }
    if (lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
  }

  function start() { resize(); dirty = true; if (!raf) draw(); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = null; }

  return { setScope, reflow, start, stop, removeCard };
}
