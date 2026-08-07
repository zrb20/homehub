function tick() {
  // 强制 Asia/Shanghai:容器 Chrome 可能 UTC,不依赖浏览器时区
  const now = new Date();
  const el = document.getElementById('info-clock');
  if (el) el.textContent = now.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

// ---------- 初始化 ----------
async function init() {
  await initOrder();
  await loadCardCfg();
  ensureCamIframe(); // 预取 watch URL + 创建 iframe(卡片实时画面)
  try {
    const s = await api('/api/mijia/specs');
    specs = s.specs;
  } catch (e) { /* specs 加载失败不影响状态展示 */ }
  await loadMijia();
  loadNetwork();
  loadWeather();
  tick();
  setInterval(tick, 1000);
  setInterval(loadMijia, 10000);
  setInterval(loadNetwork, 5000);  // 爱快数据源 5s 才更新一次(后端缓存5s),前端 5s 对齐即可,避免无效请求
  setInterval(loadWeather, 900000);  // 天气 15 分钟刷新(后端缓存 30 分钟)
}
init();
