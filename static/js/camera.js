let camWatchUrl = null;
let camIframe = null;
let camReady = false;

async function ensureCamIframe() {
  if (camIframe || camReady) return;
  camReady = true; // 只尝试一次
  try {
    if (!camWatchUrl) {
      const r = await api('/api/camera/watch-url');
      camWatchUrl = r.url;
    }
    camIframe = document.createElement('iframe');
    camIframe.setAttribute('allow', 'autoplay');
    camIframe.src = camWatchUrl;
    bindCamScroll();  // 滚动/缩放时跟随重定位(手机端)(2026-08-07)
    camIframe.onload = () => {
      const live = document.querySelector('.cam-live');
      if (live) live.classList.add('loaded');
    };
    document.getElementById('cam-float').appendChild(camIframe); // 常驻,永不移动
    positionCamFloat();
  } catch (e) { /* 失败:卡片只显示提示 */ }
}

// iframe 常驻 #cam-float,根据弹层开关状态用 fixed 定位模拟卡片/放大两种形态。
// 绝不 appendChild 移动 iframe —— 一旦下树(哪怕同步重插)grid 重建时会销毁
// context 导致页面重载 + WS 重连 + 等关键帧(45-60s),周期性"无画面"。
function positionCamFloat() {
  const f = document.getElementById('cam-float');
  if (!f || !camIframe) return;
  const ov = document.getElementById('camera-overlay');
  const big = ov.classList.contains('show');
  const target = big
    ? document.getElementById('cam-frame-slot')
    : document.querySelector('.cam-live');
  if (!target) { f.style.display = 'none'; return; }
  const r = target.getBoundingClientRect();
  f.style.display = 'block';
  f.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;'
    + 'width:' + r.width + 'px;height:' + r.height + 'px;'
    + 'z-index:' + (big ? 30 : 15) + ';overflow:hidden;border-radius:8px;'
    + 'background:#000;pointer-events:none;';
}

// 滚动时重定位摄像头 iframe(手机端页面可滚动, fixed 相对视口需要跟随)(2026-08-07)
let _camScrollBind = false;
function bindCamScroll() {
  if (_camScrollBind) return;
  _camScrollBind = true;
  // 用 passive:true 减少滚动卡顿(只读定位不 preventDefault)
  window.addEventListener('scroll', () => {
    if (camIframe && camIframe.style.display !== 'none') positionCamFloat();
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    if (camIframe) positionCamFloat();
  });
}

// 点击卡片画面 / 放大按钮 → 弹层放大(只改 overlay 状态 + 重定位,不动 iframe)
function showCamera() {
  document.getElementById('camera-overlay').classList.add('show');
  positionCamFloat();
}

// 关闭 → 回到卡片小画面
function closeCamera() {
  document.getElementById('camera-overlay').classList.remove('show');
  positionCamFloat();
}

// ---------- 时钟 ----------
