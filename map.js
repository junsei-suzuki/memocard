/* カードマップ（KJ法ボード）。canvas 一枚に全部描く。
   DOM ノードを何百枚も動かすとスマホで重くなるので、ここは当たり判定も自前で持つ。 */

const NODE_W = 130, NODE_H = 70;
const LONG_PRESS_MS = 420;
const DOUBLE_TAP_MS = 350;
const MOVE_THRESHOLD = 8; // これ未満の移動は「動いていない」とみなす（タップ/長押しの判定用）

// 白基調のテーマに合わせた配色（index.html の CSS 変数と揃えている）
const PALETTE = {
  bg: '#f8fafc',
  nodeFill: '#ffffff',
  nodeBack: '#eef2ff',
  text: '#0f172a',
  sub: '#64748b',
  link: '#94a3b899',
  accent: '#0284c7',
  imp: { 0: '#94a3b8', 1: '#0284c7', 2: '#ca8a04', 3: '#dc2626' },
};

export function initMap({ canvas, getState, onOpenCard, onDeleteCard, saveMap, getMap }) {
  const ctx = canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;

  let scope = 'all';
  let mapId = 'map:all';
  let map = { id: mapId, name: '', scope: { type: 'all' }, nodes: {}, groups: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

  let cards = [];       // このスコープに含まれるカード
  let linkPairs = [];    // 類題（破線で自動表示）

  let raf = null;
  let dirty = true;

  // 操作状態
  let touchMode = null; // 'pan' | 'drag' | 'connect' | 'group-drag' | null
  let dragNodeId = null;
  let dragGroupId = null;
  let dragOffset = { x: 0, y: 0 };
  let connectFrom = null;
  let connectPoint = null;
  let longPressTimer = null;
  let lastPan = null;
  let startPoint = null;    // 押し始めた位置。しきい値未満の移動は「動いていない」扱いにする
  let pinchStart = null;
  let selectedEdge = null;
  let flippedIds = new Set(); // タップして裏を表示中のカード
  let lastTapId = null;
  let lastTapTime = 0;

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

  function worldToScreen(x, y) {
    return { x: (x + map.viewport.x) * map.viewport.zoom, y: (y + map.viewport.y) * map.viewport.zoom };
  }
  function screenToWorld(x, y) {
    return { x: x / map.viewport.zoom - map.viewport.x, y: y / map.viewport.zoom - map.viewport.y };
  }
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  async function setScope(newScope) {
    scope = newScope;
    mapId = 'map:' + scope;
    const state = getState();
    cards = scope === 'all' ? state.cards.slice() : state.cards.filter(c => c.folderId === scope);

    const loaded = await getMap(mapId);
    map = loaded || { id: mapId, name: '', scope: { type: scope === 'all' ? 'all' : 'folder', folderId: scope }, nodes: {}, groups: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

    flippedIds.clear();

    // 新規カードには座標がないので、まだ配置されていない分だけ散らす
    const missing = cards.filter(c => !map.nodes[c.id]);
    if (missing.length) scatter(missing, Object.keys(map.nodes).length > 0);

    computeLinkPairs();
    dirty = true;
    persist();
  }

  function computeLinkPairs() {
    const state = getState();
    const idSet = new Set(cards.map(c => c.id));
    linkPairs = state.links.filter(l => idSet.has(l.aId) && idSet.has(l.bId));
  }

  function scatter(list, append) {
    // 簡易力学配置: 円状に初期配置してから、反発だけ何十回か回す
    const n = list.length;
    const cx = 400, cy = 300, r = 60 + n * 12;
    list.forEach((c, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      map.nodes[c.id] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
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
    scatter(cards, false);
    dirty = true;
    persist();
  }

  function persist() { saveMap(JSON.parse(JSON.stringify(map))).catch(() => {}); }

  function nodeAt(worldX, worldY) {
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      const p = map.nodes[c.id];
      if (!p) continue;
      if (Math.abs(worldX - p.x) < NODE_W / 2 && Math.abs(worldY - p.y) < NODE_H / 2) return c;
    }
    return null;
  }
  function groupAt(worldX, worldY) {
    for (let i = map.groups.length - 1; i >= 0; i--) {
      const g = map.groups[i];
      if (worldX >= g.x && worldX <= g.x + g.w && worldY >= g.y && worldY <= g.y + g.h) return g;
    }
    return null;
  }
  function edgeAt(worldX, worldY) {
    const all = [...map.edges.map(e => ({ ...e, auto: false })),
                 ...linkPairs.map(l => ({ aId: l.aId, bId: l.bId, auto: true }))];
    for (const e of all) {
      const a = map.nodes[e.aId], b = map.nodes[e.bId];
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
    if (e.touches && e.touches.length === 2) { startPinch(e); return; }
    const p = pointerPos(e);
    const w = screenToWorld(p.x, p.y);
    const card = nodeAt(w.x, w.y);
    const group = !card && groupAt(w.x, w.y);
    const edge = !card && !group && edgeAt(w.x, w.y);

    if (edge) { selectedEdge = edge; showEdgeMenu(edge); return; }

    if (card) {
      dragNodeId = card.id;
      dragOffset = { x: w.x - map.nodes[card.id].x, y: w.y - map.nodes[card.id].y };
      touchMode = 'pending'; // タップかドラッグか長押しか、動きを見て確定する
      startPoint = p;
      longPressTimer = setTimeout(() => {
        touchMode = 'connect';
        connectFrom = card.id;
        connectPoint = w;
        dirty = true;
      }, LONG_PRESS_MS);
      lastPan = p;
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
    if (e.touches && e.touches.length === 2) { movePinch(e); return; }
    const p = pointerPos(e);
    const w = screenToWorld(p.x, p.y);

    if (touchMode === 'pending' || touchMode === 'drag') {
      const moved = lastPan && Math.hypot(p.x - lastPan.x, p.y - lastPan.y) > 6;
      if (moved) {
        clearTimeout(longPressTimer);
        touchMode = 'drag';
        map.nodes[dragNodeId] = { x: w.x - dragOffset.x, y: w.y - dragOffset.y };
        dirty = true;
      }
    } else if (touchMode === 'connect') {
      connectPoint = w;
      dirty = true;
    } else if (touchMode === 'group-drag') {
      const g = map.groups.find(x => x.id === dragGroupId);
      if (g) {
        const nx = w.x - dragOffset.x, ny = w.y - dragOffset.y;
        const dx = nx - g.x, dy = ny - g.y;
        g.x = nx; g.y = ny;
        // 枠の中にあったカードも一緒に動かす
        cards.forEach(c => {
          const pos = map.nodes[c.id];
          if (pos && pos.x >= g.x - dx && pos.x <= g.x - dx + g.w && pos.y >= g.y - dy && pos.y <= g.y - dy + g.h) {
            pos.x += dx; pos.y += dy;
          }
        });
        dirty = true;
      }
    } else if (touchMode === 'pending-blank' || touchMode === 'pan') {
      const moved = lastPan && Math.hypot(p.x - lastPan.x, p.y - lastPan.y) > 6;
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
      const target = nodeAt(w.x, w.y);
      if (target && target.id !== connectFrom) {
        map.edges.push({ id: 'e' + Date.now(), aId: connectFrom, bId: target.id, kind: 'line', label: '' });
        persist();
      } else {
        // 相手を選ばずに長押しだけで離した場合は、カードの操作メニューを出す
        showNodeMenu(connectFrom);
      }
      connectFrom = null; connectPoint = null;
    } else if (touchMode === 'drag' || touchMode === 'group-drag') {
      persist();
    }
    touchMode = null; dragNodeId = null; dragGroupId = null;
    startPoint = null;
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
    if (!pinchStart) return startPinch(e);
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    map.viewport.zoom = Math.max(0.3, Math.min(2.5, pinchStart.zoom * (dist / pinchStart.dist)));
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

  /** カードがフォルダ画面などから削除されたとき、マップ側の参照も掃除する */
  function removeCard(cardId) {
    cards = cards.filter(c => c.id !== cardId);
    delete map.nodes[cardId];
    map.edges = map.edges.filter(e => e.aId !== cardId && e.bId !== cardId);
    linkPairs = linkPairs.filter(l => l.aId !== cardId && l.bId !== cardId);
    flippedIds.delete(cardId);
    dirty = true;
    persist();
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
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', (e) => { if (touchMode) onMove(e); });
  window.addEventListener('mouseup', (e) => { if (touchMode) onUp(e); });

  // ---------- 描画 ----------
  function draw() {
    if (!dirty) { raf = requestAnimationFrame(draw); return; }
    dirty = false;
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
      ctx.fillStyle = g.color + '22';
      ctx.fillRect(g.x, g.y, g.w, g.h);
      ctx.fillStyle = g.color; ctx.font = '13px sans-serif';
      ctx.fillText(g.title, g.x + 6, g.y - 6);
    });

    // 類題リンク（破線、自動）
    ctx.strokeStyle = PALETTE.link; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
    linkPairs.forEach(l => {
      const a = map.nodes[l.aId], b = map.nodes[l.bId];
      if (!a || !b) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    // 手描きの線・矢印
    ctx.setLineDash([]);
    map.edges.forEach(edge => {
      const a = map.nodes[edge.aId], b = map.nodes[edge.bId];
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
      const a = map.nodes[connectFrom];
      ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(connectPoint.x, connectPoint.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // カード（付箋）。タップした分は裏面を表示する
    cards.forEach(c => {
      const p = map.nodes[c.id];
      if (!p) return;
      const flipped = flippedIds.has(c.id);
      const x = p.x - NODE_W / 2, y = p.y - NODE_H / 2;
      ctx.fillStyle = flipped ? PALETTE.nodeBack : PALETTE.nodeFill;
      ctx.strokeStyle = PALETTE.imp[c.importance] || PALETTE.imp[0];
      ctx.lineWidth = 2.5;
      roundRect(x, y, NODE_W, NODE_H, 10);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = PALETTE.text; ctx.font = '13px sans-serif';
      wrapText((flipped ? c.back : c.front) || '(空欄)', x + 10, y + 24, NODE_W - 20, 16, 2);
      if (flipped) {
        ctx.fillStyle = PALETTE.sub; ctx.font = '10px sans-serif';
        ctx.fillText('裏', x + NODE_W - 18, y + 14);
      }
    });

    ctx.restore();
    ctx.restore();
    raf = requestAnimationFrame(draw);
  }

  function drawArrowHead(a, b) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 10;
    // ノード端まで少し引いた位置に矢じりを置く
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
