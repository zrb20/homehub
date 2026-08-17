let cardList = null;    // [{t:'d',id}, {t:'i'}, {t:'m',k}, {t:'add'}]
let hiddenDevices = []; // 隐藏的设备 did
let dragKey = null;

// 设备类型:窄屏(手机/平板)用 mobile 布局,宽屏(监控屏)用 desktop(2026-08-07)
function layoutDev() {
  return (window.matchMedia && window.matchMedia('(max-width: 1200px)').matches)
    ? 'mobile' : 'desktop';
}

function cardKey(item) {
  if (item.t === 'd') return 'd:' + item.id;
  if (item.t === 'net') return 'net';
  if (item.t === 'wx') return 'wx';
  if (item.t === 'cl') return 'cl';
  if (item.t === 'wan') return 'wan';
  if (item.t === 'i') return 'i';
  if (item.t === 'm') return 'm:' + item.k;
  return 'add';
}
// 确保固定卡(cl 温湿度 / net 网络大卡 / i 信息卡)在列表中;
// 顺序: 摄像机 → info → net(三个 3x3,info 在中间),cl 插设备后
function ensureFixedInList(list) {
  const has = k => list.some(x => cardKey(x) === k);
  let ins = 0, camAfter = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].t === 'd') {
      ins = i + 1;
      const d = devices.find(x => x.did === list[i].id);
      if (d && d.category === 'camera') camAfter = i + 1;
    }
  }
  const addItem = (item, pos) => {
    if (!has(cardKey(item))) {
      const p = pos !== undefined ? pos : ins++;
      list.splice(p, 0, item);
      if (camAfter >= p) camAfter++;
      if (ins > p) ins++;
    }
  };
  addItem({ t: 'i' }, camAfter >= 0 ? camAfter : undefined);        // info 紧跟摄像机
  addItem({ t: 'net' }, camAfter >= 0 ? camAfter + 1 : undefined);  // net 在 info 后
  addItem({ t: 'cl' });
  return list;
}
function getCardList() {
  if (!cardList) {
    cardList = [];
    for (const d of devices) cardList.push({ t: 'd', id: d.did });
    for (const k of (cardCfg.minis || [])) cardList.push({ t: 'm', k });
    cardList.push({ t: 'add' });
    ensureFixedInList(cardList);  // 插 net(摄像机后) + i(net后) + cl(设备后)
  } else {
    // 米家新增设备不在列表里会永远不显示(2026-08-07 审查发现):
    // 在线设备没在 cardList 中的追加到 add 前(不写回后端,保持用户排布)
    const known = new Set(cardList.filter(x => x.t === 'd').map(x => x.id));
    const addIdx = cardList.findIndex(x => x.t === 'add');
    let ins = addIdx >= 0 ? addIdx : cardList.length;
    for (const d of devices) {
      if (d.online && !known.has(d.did)) {
        cardList.splice(ins++, 0, { t: 'd', id: d.did });
      }
    }
  }
  return cardList;
}
async function initOrder() {
  try {
    const d = await api('/api/layout/order?dev=' + layoutDev());
    if (Array.isArray(d.list) && d.list.length) {
      cardList = ensureFixedInList(d.list.filter(x => x && x.t));
      hiddenDevices = Array.isArray(d.hidden) ? d.hidden : [];
    } else if (Array.isArray(d.order) && d.order.length) {
      // 旧格式(did 数组)迁移为通用卡列表
      cardList = d.order.map(id => ({ t: 'd', id }));
      for (const k of (cardCfg.minis || [])) cardList.push({ t: 'm', k });
      cardList.push({ t: 'add' });
      cardList = ensureFixedInList(cardList);
      hiddenDevices = [];
      saveOrder();
    }
  } catch (e) {}
}
function saveOrder() {
  fetch('/api/layout/order?dev=' + layoutDev(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ list: cardList, hidden: hiddenDevices }),
  }).catch(() => {});
}
// 鼠标按下时若在控件(滑条/开关/按钮)上,临时关闭卡片 draggable —— HTML5 拖拽按
// mousedown 时的 draggable 状态决定是否开始,松手恢复。否则滑风速条会拖走卡片
// (2026-08-07 用户两次报,第一版 onDragStart 守卫无效:dragstart 的 target 永远是
// draggable 卡片而非 input,closest('input') 查不到)。
function cardMouseDown(e, card) {
  // 只排除真正需要原生拖动的控件(滑条/文本输入)。button/checkbox 按下拖动应拖卡片,
  // 否则设备卡上按钮多,用户找不到空白处拖拽排序(2026-08-07 用户报信息卡/设备卡不能互换)。
  if (e.target.closest('input[type=range], input[type=text], input[type=number], select, textarea, .fan-slider')) {
    card.draggable = false;
  }
}
function cardMouseUp(card) {
  card.draggable = true;
}
function onDragStart(e, key) {
  dragKey = key;
  e.dataTransfer.setData('text/plain', key);
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => { e.target.closest('.card').classList.add('dragging'); });
}
function onDragEnd() {
  dragKey = null;
  document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over'));
}
function onDragOverCard(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.card');
  if (card) card.classList.add('drag-over');
}
function onDragLeaveCard(e) {
  const card = e.target.closest('.card');
  if (card) card.classList.remove('drag-over');
}
function onDropCard(e, targetKey) {
  e.preventDefault();
  // 先读 src 再清 dragKey —— onDragEnd() 会把 dragKey 置 null,若 dataTransfer
  // 读不到(text/plain 在部分环境/模拟下不可用)则 src 变空,drop 静默失败
  // (2026-08-07 用户报信息卡/设备卡不能互换的真因)。
  const src = dragKey || e.dataTransfer.getData('text/plain');
  onDragEnd();
  if (!src || src === targetKey) return;
  const list = getCardList();
  const from = list.findIndex(x => cardKey(x) === src);
  const to = list.findIndex(x => cardKey(x) === targetKey);
  if (from < 0 || to < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  cardList = list;
  saveOrder();
  renderMijia();
}

// ---------- 卡片渲染 ----------
// 内容少的设备类型 → 紧凑半高卡
