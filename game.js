/* ============================================================
 * 四国争霸 - 联机客户端 v2.3
 *
 * 相比 v2.2 新增：
 *   选都城阶段，在自己的象限上盖一个金色虚框 + "你的区域"
 *   一眼看清该点哪里
 * ============================================================ */

const WS_URL = 'ws://localhost:8080';
const MAP_SIZE = 10;
const TROOP_POWER = { infantry: 1, cavalry: 1, lightCav: 1 };
const TROOP_ORDER = ['infantry', 'cavalry', 'lightCav'];
const TROOP_COST = { infantry: 1, cavalry: 2, lightCav: 3 };
const TROOP_NAMES = { infantry: '步兵', cavalry: '骑兵', lightCav: '轻骑兵' };
const COLORS = ['#4a90d9', '#d94a4a', '#4ad94a', '#d9d94a'];
const QUAD_NAMES = ['左上', '右上', '左下', '右下'];

let ws = null;
let myId = -1;
let roomId = null;
let state = null;
let selected = null;
let cellCenterCache = null;
let cellDivs = null;
let myQuadrant = -1;
let lastPhase = null;
let renderScheduled = false;

const lobbyEl = document.getElementById('lobby');
const gameEl = document.getElementById('game');
const statusEl = document.getElementById('lobby-status');

// ===== WebSocket =====
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { statusEl.textContent = '已连接服务器'; };
  ws.onclose = () => { statusEl.textContent = '连接已断开'; };
  ws.onerror = () => { statusEl.textContent = '连接错误，服务器是否启动？'; };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function ensureConnected() {
  return new Promise((resolve) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    ws.addEventListener('open', () => resolve(), { once: true });
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.playerId;
      roomId = msg.roomId;
      statusEl.textContent = `已加入房间 ${roomId}，等待其他玩家...`;
      break;
    case 'roomCreated':
      statusEl.textContent = `房间 ${msg.roomId} 已创建，把房间号告诉朋友`;
      break;
    case 'roomState':
      if (!roomId) roomId = msg.roomId;
      statusEl.textContent = `房间 ${msg.roomId}，玩家 ${msg.count}/4`;
      break;
    case 'error':
      statusEl.textContent = '错误：' + msg.message;
      break;
    case 'hint':
      document.getElementById('cell-info').textContent = msg.message;
      break;
    case 'gameStart':
      myQuadrant = msg.quadrants[myId];
      lobbyEl.style.display = 'none';
      gameEl.style.display = 'flex';
      document.getElementById('my-id').textContent = 'P' + myId;
      document.getElementById('my-color').style.background = COLORS[myId];
      document.getElementById('cell-info').textContent =
        `选择都城：点你的象限（${QUAD_NAMES[myQuadrant]}）里的一个格子`;
      initMapDOM();
      break;
    case 'state':
      state = msg.state;
      scheduleRender();
      break;
    case 'gameover':
      break;
  }
}

document.getElementById('btn-create').onclick = async () => {
  await ensureConnected();
  send({ type: 'createRoom' });
};
document.getElementById('btn-join').onclick = async () => {
  const rid = document.getElementById('input-room').value.trim().toUpperCase();
  if (rid.length !== 4) { statusEl.textContent = '请输入 4 位房间号'; return; }
  await ensureConnected();
  send({ type: 'joinRoom', roomId: rid });
};

// ===== 工具 =====
function totalPower(t) {
  return t.infantry * TROOP_POWER.infantry
       + t.cavalry * TROOP_POWER.cavalry
       + t.lightCav * TROOP_POWER.lightCav;
}
function totalTroops(t) {
  return t.infantry + t.cavalry + t.lightCav;
}
function getQuadrant(x, y) {
  if (x < 5 && y < 5) return 0;
  if (x >= 5 && y < 5) return 1;
  if (x < 5 && y >= 5) return 2;
  return 3;
}
function phaseName() {
  if (!state) return '';
  return {
    waiting: '等待玩家',
    select: '选择都城',
    action: '行动阶段',
    recruit: '征兵建城',
    gameover: '游戏结束',
  }[state.phase] || '';
}

// ===== 初始化地图 DOM（只做一次） =====
function initMapDOM() {
  const mapEl = document.getElementById('map');
  mapEl.innerHTML = '';
  cellDivs = [];
  for (let y = 0; y < MAP_SIZE; y++) {
    cellDivs[y] = [];
    for (let x = 0; x < MAP_SIZE; x++) {
      const div = document.createElement('div');
      div.className = 'cell';

      const bar = document.createElement('div');
      bar.className = 'owner-bar';
      bar.style.display = 'none';
      div.appendChild(bar);

      const troop = document.createElement('div');
      troop.className = 'troop';
      troop.style.display = 'none';
      div.appendChild(troop);

      div._bar = bar;
      div._troop = troop;
      div._cache = {
        owner: undefined,
        type: undefined,
        mine: undefined,
        glow: undefined,
        selected: undefined,
        troopText: undefined,
        troopOpacity: undefined,
      };

      div.addEventListener('click', () => onCellClick(x, y));
      mapEl.appendChild(div);
      cellDivs[y][x] = div;
    }
  }
  rebuildCellCenterCache();
}

// ===== 渲染（rAF 节流） =====
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!state || !cellDivs) return;

  if (state.phase !== lastPhase) {
    document.getElementById('actions').innerHTML = '';
    if (state.phase !== 'action') {
      selected = null;
      hideSplitControl();
    }
    lastPhase = state.phase;
  }

  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      renderCell(x, y);
    }
  }

  const me = state.players[myId] || {};
  document.getElementById('turn').textContent = state.turn;
  document.getElementById('food').textContent = me.food ?? '-';

  if (state.phase === 'select') {
    const cnt = state.players.filter(p => p.capital).length;
    document.getElementById('phase').textContent = `选择都城 ${cnt}/4`;
  } else {
    document.getElementById('phase').textContent = phaseName();
  }

  document.getElementById('timer').textContent =
    state.timeLeft > 0 ? Math.ceil(state.timeLeft) + 's' : '--';

  updateQuadrantOverlay();   // 新增
  renderMovingLayer();
}

function renderCell(x, y) {
  const cell = state.map[y][x];
  const div = cellDivs[y][x];
  const bar = div._bar;
  const troop = div._troop;
  const c = div._cache;

  if (cell.owner !== c.owner) {
    if (cell.owner !== null) {
      bar.style.display = '';
      bar.style.background = COLORS[cell.owner];
      div.style.background = COLORS[cell.owner] + '66';
    } else {
      bar.style.display = 'none';
      div.style.background = '';
    }
    c.owner = cell.owner;
  }

  if (cell.type !== c.type) {
    div.classList.remove('capital', 'city');
    div.style.border = '';
    if (cell.type === 'capital') {
      div.classList.add('capital');
      div.style.border = '2px solid ' +
        (cell.owner !== null ? COLORS[cell.owner] : '#fff');
    } else if (cell.type === 'city') {
      div.classList.add('city');
    }
    c.type = cell.type;
  }

  const mine = cell.owner === myId;
  if (mine !== c.mine) {
    if (mine) div.classList.add('mine');
    else div.classList.remove('mine');
    c.mine = mine;
  }

  const glow = state.phase === 'select' && getQuadrant(x, y) === myQuadrant;
  if (glow !== c.glow) {
    div.style.boxShadow = glow
      ? 'inset 0 0 12px rgba(226, 176, 74, 0.55)'
      : '';
    c.glow = glow;
  }

  const sel = selected && selected.x === x && selected.y === y;
  if (sel !== c.selected) {
    if (sel) div.classList.add('selected');
    else div.classList.remove('selected');
    c.selected = sel;
  }

  const power = totalPower(cell.troops);
  let text = '';
  let op = '1';
  if (power > 0) {
    text = String(power);
  } else if (cell.owner === null && cell.type === 'empty') {
    text = '1';
    op = '0.35';
  }

  if (text !== c.troopText || op !== c.troopOpacity) {
    if (text) {
      troop.style.display = '';
      troop.textContent = text;
      troop.style.opacity = op;
    } else {
      troop.style.display = 'none';
    }
    c.troopText = text;
    c.troopOpacity = op;
  }
}

/**
 * 更新「你的区域」金色虚框
 * 只在 select 阶段、且自己还没选都城时显示
 */
function updateQuadrantOverlay() {
  const overlay = document.getElementById('quadrant-overlay');
  if (!overlay) return;

  const needShow =
    state &&
    state.phase === 'select' &&
    myQuadrant >= 0 &&
    !state.players[myId]?.capital;

  if (!needShow) {
    overlay.style.display = 'none';
    return;
  }

  // 根据象限计算位置（左上/右上/左下/右下）
  const cols = { 0: 0, 1: 1, 2: 0, 3: 1 };
  const rows = { 0: 0, 1: 0, 2: 1, 3: 1 };
  overlay.style.left = (cols[myQuadrant] * 50) + '%';
  overlay.style.top  = (rows[myQuadrant] * 50) + '%';
  overlay.style.width = '50%';
  overlay.style.height = '50%';
  overlay.style.display = 'flex';

  // 内容只创建一次
  if (!overlay.dataset.built) {
    overlay.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = '你的区域';
    overlay.appendChild(label);

    const arrow = document.createElement('div');
    arrow.className = 'hint-arrow';
    arrow.textContent = '↓ 点这里选都城 ↓';
    overlay.appendChild(arrow);

    overlay.dataset.built = '1';
  }
}

function renderMovingLayer() {
  const layer = document.getElementById('moving-layer');
  layer.innerHTML = '';
  if (!state || state.marching.length === 0) return;

  const paused = state.phase !== 'action';

  for (const m of state.marching) {
    const t = m.duration > 0 ? Math.min(1, m.elapsed / m.duration) : 1;
    const fromC = getCachedCellCenter(m.from.x, m.from.y);
    const toC = getCachedCellCenter(m.to.x, m.to.y);
    const cx = fromC.x + (toC.x - fromC.x) * t;
    const cy = fromC.y + (toC.y - fromC.y) * t;

    const dot = document.createElement('div');
    dot.className = 'marching-unit' + (paused ? ' paused' : '');
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';
    dot.style.background = COLORS[m.owner];
    dot.textContent = totalPower(m.troops);
    layer.appendChild(dot);
  }
}

function rebuildCellCenterCache() {
  const mapEl = document.getElementById('map');
  const mapRect = mapEl.getBoundingClientRect();
  cellCenterCache = [];
  for (let y = 0; y < MAP_SIZE; y++) {
    cellCenterCache[y] = [];
    for (let x = 0; x < MAP_SIZE; x++) {
      const div = cellDivs[y][x];
      const r = div.getBoundingClientRect();
      cellCenterCache[y][x] = {
        x: r.left - mapRect.left + r.width / 2,
        y: r.top - mapRect.top + r.height / 2,
      };
    }
  }
}

function getCachedCellCenter(x, y) {
  if (!cellCenterCache || !cellCenterCache[y]) return { x: 0, y: 0 };
  return cellCenterCache[y][x];
}

// ===== 分兵面板 =====
function showSplitControl() {
  if (!selected || !state) return;
  const cell = state.map[selected.y]?.[selected.x];
  if (!cell || cell.owner !== myId) {
    selected = null;
    hideSplitControl();
    return;
  }

  for (const type of TROOP_ORDER) {
    const input = document.getElementById('send-' + type);
    const hint = document.getElementById('max-' + type);
    const max = cell.troops[type];
    input.max = max;
    input.value = max;
    hint.textContent = '/' + max;
  }
  document.getElementById('split-row').style.display = 'flex';
  updateSplitSummary();
}
function hideSplitControl() {
  document.getElementById('split-row').style.display = 'none';
}
function onSplitDelta(type, delta) {
  const input = document.getElementById('send-' + type);
  const max = parseInt(input.max) || 0;
  let v = (parseInt(input.value) || 0) + delta;
  if (v < 0) v = 0;
  if (v > max) v = max;
  input.value = v;
  updateSplitSummary();
}
function onSplitInput(e) {
  const input = e.target;
  const max = parseInt(input.max) || 0;
  let v = parseInt(input.value);
  if (isNaN(v) || v < 0) v = 0;
  if (v > max) v = max;
  input.value = v;
  updateSplitSummary();
}
function updateSplitSummary() {
  let power = 0;
  for (const type of TROOP_ORDER) {
    const v = parseInt(document.getElementById('send-' + type).value) || 0;
    power += v * TROOP_POWER[type];
  }
  document.getElementById('split-total').textContent = power;
}
function onSelectAll() {
  for (const type of TROOP_ORDER) {
    const input = document.getElementById('send-' + type);
    input.value = input.max;
  }
  updateSplitSummary();
}
function onSelectHalf() {
  for (const type of TROOP_ORDER) {
    const input = document.getElementById('send-' + type);
    const max = parseInt(input.max) || 0;
    input.value = Math.floor(max / 2);
  }
  updateSplitSummary();
}
function onSelectClear() {
  for (const type of TROOP_ORDER) {
    document.getElementById('send-' + type).value = 0;
  }
  updateSplitSummary();
}

// ===== 点击地图 =====
function onCellClick(x, y) {
  if (!state) return;
  if (state.phase === 'gameover' || state.phase === 'waiting') return;
  const cell = state.map[y][x];

  if (state.phase === 'select') {
    if (cell.owner !== null) {
      document.getElementById('cell-info').textContent = '这个格子已经有人选了';
      return;
    }
    if (getQuadrant(x, y) !== myQuadrant) {
      document.getElementById('cell-info').textContent =
        `只能在你的象限（${QUAD_NAMES[myQuadrant]}）选都城`;
      return;
    }
    send({ type: 'selectCapital', x, y });
    return;
  }

  if (state.phase === 'recruit') {
    if (cell.owner !== myId) {
      document.getElementById('cell-info').textContent = '这不是你的土地';
      return;
    }
    if (cell.type === 'capital' || cell.type === 'city') {
      showRecruitActions(x, y);
    } else if (cell.type === 'empty') {
      showBuildAction(x, y);
    }
    return;
  }

  if (state.phase === 'action') {
    if (selected && selected.x === x && selected.y === y) {
      selected = null;
      hideSplitControl();
      render();
      return;
    }
    if (selected) {
      sendMove(selected.x, selected.y, x, y);
      return;
    }
    if (cell.owner === myId && totalTroops(cell.troops) > 0) {
      selected = { x, y };
      render();
      showSplitControl();
      document.getElementById('cell-info').textContent =
        `选中：战力 ${totalPower(cell.troops)}。调整派出兵力，再点目标格`;
    } else if (cell.owner === myId) {
      document.getElementById('cell-info').textContent = '这个格子没有兵';
    } else {
      document.getElementById('cell-info').textContent =
        '先点你自己的有兵格子选中部队';
    }
  }
}

function sendMove(fx, fy, tx, ty) {
  const troops = {
    infantry: parseInt(document.getElementById('send-infantry').value) || 0,
    cavalry: parseInt(document.getElementById('send-cavalry').value) || 0,
    lightCav: parseInt(document.getElementById('send-lightCav').value) || 0,
  };
  if (totalTroops(troops) === 0) {
    document.getElementById('cell-info').textContent = '派出兵力为 0';
    return;
  }
  send({
    type: 'move',
    from: { x: fx, y: fy },
    to: { x: tx, y: ty },
    troops,
  });
  selected = null;
  hideSplitControl();
}

function showRecruitActions(x, y) {
  const actionsEl = document.getElementById('actions');
  actionsEl.innerHTML = '';
  const me = state.players[myId];
  const cell = state.map[y][x];
  document.getElementById('cell-info').textContent =
    `${cell.type === 'capital' ? '都城' : '城池'} | 粮食 ${me.food}`;

  TROOP_ORDER.forEach(type => {
    const btn = document.createElement('button');
    btn.textContent = `征${TROOP_NAMES[type]}（${TROOP_COST[type]}粮）`;
    btn.disabled = me.food < TROOP_COST[type];
    btn.onclick = () => {
      send({ type: 'recruit', x, y, troopType: type });
    };
    actionsEl.appendChild(btn);
  });
}

function showBuildAction(x, y) {
  const actionsEl = document.getElementById('actions');
  actionsEl.innerHTML = '';
  const me = state.players[myId];
  document.getElementById('cell-info').textContent = `你的土地 | 粮食 ${me.food}`;
  const btn = document.createElement('button');
  btn.textContent = '建城（10粮）';
  btn.disabled = me.food < 10;
  btn.onclick = () => send({ type: 'buildCity', x, y });
  actionsEl.appendChild(btn);
}

// ===== 事件绑定 =====
window.addEventListener('resize', () => {
  if (cellDivs) rebuildCellCenterCache();
});

TROOP_ORDER.forEach(type => {
  document.getElementById('send-' + type).addEventListener('input', onSplitInput);
  document.querySelectorAll('.btn-step[data-type="' + type + '"]').forEach(btn => {
    btn.addEventListener('click', () => {
      onSplitDelta(type, parseInt(btn.getAttribute('data-delta')));
    });
  });
});

document.getElementById('btn-send-all').onclick = onSelectAll;
document.getElementById('btn-send-half').onclick = onSelectHalf;
document.getElementById('btn-send-clear').onclick = onSelectClear;

// ===== 启动 =====
connect();