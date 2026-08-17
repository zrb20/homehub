function renderMijia() {
  const grid = document.getElementById('mi-grid');
  const deviceMap = new Map(devices.map(d => [d.did, d]));
  const list = getCardList();
  const rendered = new Set();
  let html = '', used = 0;
  const LIMIT = 44;  // 设备区 = 行 2-6 共 5 行 45 格,留 1 格给加号卡
  // 预报横条(行1:24h 5格 + 7天 4格)
  html += fcBarsHtml24() + fcBarsHtml7d();
  // 单轮流式:严格按 list 顺序渲染(拖拽顺序=显示顺序,信息卡/设备卡可互换)。
  // 所有卡都占 used 计数(否则 LIMIT=44 失效,mini 全渲染会溢出行2-6 变成 7 行);
  // 3x3 大卡(摄像机/net/info)不受 LIMIT 跳过(永远完整渲染),1x1/2x2 受 LIMIT。
  for (const item of list) {
    const key = cardKey(item);
    if (rendered.has(key)) continue;
    if (item.t === 'd') {
      const d = deviceMap.get(item.id);
      if (!d) continue;
      if (!d.online) continue;  // 离线设备默认隐藏
      if (hiddenDevices.includes(item.id)) continue;
      const span = gridSpanOf(d);
      if (span > 1) {
        html += safeCardHtml(() => cardBody(d), key); used += span; rendered.add(key);
      } else if (used + span <= LIMIT) {
        html += safeCardHtml(() => cardBody(d), key); used += span; rendered.add(key);
      }
    } else if (item.t === 'net') {
      html += safeCardHtml(() => netGroupHtml(), 'net'); used += 9; rendered.add(key);  // 3x3 大卡不受 LIMIT
    } else if (item.t === 'i') {
      if (!cardCfg.info) continue;
      html += safeCardHtml(() => infoCardHtml(), 'i'); used += 9; rendered.add(key);  // 3x3 大卡不受 LIMIT
    } else if (item.t === 'cl') {
      if (used + 1 > LIMIT) continue;
      html += safeCardHtml(() => climateCardHtml(), 'cl'); used += 1; rendered.add(key);
    } else if (item.t === 'm') {
      if (!(cardCfg.minis || []).includes(item.k)) continue;
      if (used + 1 > LIMIT) continue;
      const m = safeCardHtml(() => infoMiniHtml(item.k), 'm:' + item.k);
      // infoMiniHtml 数据缺失返回 ''(不占格);渲染异常返回 err-card(占格显示警告)
      if (!m) continue;
      html += m; used += 1; rendered.add(key);
    }
  }
  // 加号卡:网格末尾(管理入口)
  if (used < 45) {
    html += `<div class="card add-card" data-key="add" onclick="showCardManager()">＋</div>`;
  }
  grid.innerHTML = html;
  tick();  // grid 重建会重置 #info-clock 为 --:--:--,立即补一次避免 10s 闪烁
  bindFcScroll(grid);
  drawSparkline();  // 24h 折线实测宽度重绘(fc-inner flex 均分后宽度随布局)
  positionCamFloat(); // iframe 常驻,仅跟随卡片/弹层位置
}

async function loadMijia() {
  try {
    const data = await api('/api/mijia/state');
    const newDevices = data.devices;
    newDevices.forEach(d => {
      const onSpec = onSpecOf(d.did);
      d.onName = onSpec ? ('on@' + onSpec.service_desc) : null;
    });
    // 乐观值:服务器返回==乐观值=设备已到位,确认成功清标记;
    // 服务器还是旧值(未同步完)→ 同步窗口内(5s)保持乐观值,超时仍不同=控制未生效,回退真实值
    for (const did of Object.keys(optimistic)) {
      const d = newDevices.find(x => x.did === did);
      if (!d) { delete optimistic[did]; continue; }
      const op = optimistic[did];
      for (const [name, rec] of Object.entries(op)) {
        const p = (d.props || []).find(x => String(x.spec_name) === name)
               || (d.props || []).find(x => String(x.spec_name).split('@')[0] === name);
        if (p && String(p.value) === String(rec.v)) {
          delete op[name];  // 设备已到位
        } else if (Date.now() - rec.ts > 800) {
          delete op[name];  // 0.8s 未确认 = 控制没生效,回退服务器真实值
        } else {
          if (p) p.value = String(rec.v);
          else d.props.push({ spec_name: name, value: String(rec.v) });
        }
      }
      if (!Object.keys(op).length) delete optimistic[did];
    }
    // 设备集合/在线状态变化(增删/上下线)→ 才全量重建;否则只局部更新数值卡
    const sig = newDevices.map(d => d.did + (d.online ? ':1' : ':0')).sort().join(',');
    if (sig !== lastDevSig) {
      lastDevSig = sig;
      devices = newDevices;
      renderMijia();
      return;
    }
    devices = newDevices;
    devices.forEach(d => {
      const key = 'd:' + d.did;
      if (document.querySelector(`[data-key="${key}"]`)) {
        updateCardByHtml(key, cardBody(d));
      }
    });
    updateCardByHtml('cl', climateCardHtml());
    positionCamFloat();  // 设备卡局部重建后 iframe 位置可能变
  } catch (e) {
    // 网络失败不覆盖整页,保持现状等下次轮询
  }
}
let lastDevSig = '';
// ---------- 网络设备 ----------
function fmtRate(bps) {
  if (!bps || bps <= 0) return '0';
  if (bps < 1024) return bps + ' B';
  if (bps < 1048576) return (bps / 1024).toFixed(bps < 10240 ? 1 : 0) + ' KB';
  return (bps / 1048576).toFixed(1) + ' MB';
}
function fmtTotal(bytes) {
  if (!bytes) return '0';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// ---------- 天气(室外 + 24h + 7天) ----------
// 农历 1900-2100 数据表(位编码:闰月/大小月)
const LUNAR_INFO = [
0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
0x0d520];
function lunarYearDays(y) { let s = 348; for (let i = 0x8000; i > 0x8; i >>= 1) s += (LUNAR_INFO[y - 1900] & i) ? 1 : 0; return s + (leapMonth(y) ? leapDays(y) : 0); }
function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function solarToLunar(y, m, d) {
  let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
  let lunarYear = 1900;
  while (lunarYear < 2101 && offset >= lunarYearDays(lunarYear)) { offset -= lunarYearDays(lunarYear); lunarYear++; }
  let leap = leapMonth(lunarYear), isLeap = false, lunarMonth = 1;
  while (lunarMonth <= 12) {
    const days = isLeap ? leapDays(lunarYear) : monthDays(lunarYear, lunarMonth);
    if (offset < days) break;
    offset -= days;
    if (isLeap) { isLeap = false; lunarMonth++; }
    else if (lunarMonth === leap) { isLeap = true; }
    else lunarMonth++;
  }
  const lunarDay = offset + 1;
  const MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  const D10 = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let dayStr;
  if (lunarDay === 10) dayStr = '初十';
  else if (lunarDay === 20) dayStr = '二十';
  else if (lunarDay === 30) dayStr = '三十';
  else if (lunarDay < 10) dayStr = '初' + D10[lunarDay - 1];
  else if (lunarDay < 20) dayStr = '十' + D10[lunarDay - 11];
  else dayStr = '廿' + D10[lunarDay - 21];
  return (isLeap ? '闰' : '') + MONTHS[lunarMonth - 1] + '月' + dayStr;
}

// 农历 → 公历(UTC)
function lunarToSolar(y, m, d, isLeap) {
  let offset = 0;
  for (let i = 1900; i < y; i++) offset += lunarYearDays(i);
  const leap = leapMonth(y);
  for (let i = 1; i < m; i++) {
    if (i === leap) offset += leapDays(y);
    offset += monthDays(y, i);
  }
  if (isLeap) offset += leapDays(y);
  offset += d - 1;
  return new Date(Date.UTC(1900, 0, 31) + offset * 86400000);
}

// 下一个节日(阳历+农历,UTC)
function nextFestival() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const fests = [];
  const push = (name, dt) => fests.push({ name, date: dt, diff: Math.floor((dt - now) / 86400000) });
  push('元旦', new Date(Date.UTC(y, 0, 1)));
  push('清明节', new Date(Date.UTC(y, 3, 5)));
  push('劳动节', new Date(Date.UTC(y, 4, 1)));
  push('国庆节', new Date(Date.UTC(y, 9, 1)));
  push('春节', lunarToSolar(y, 1, 1));
  push('元宵节', lunarToSolar(y, 1, 15));
  push('端午节', lunarToSolar(y, 5, 5));
  push('中秋节', lunarToSolar(y, 8, 15));
  push('重阳节', lunarToSolar(y, 9, 9));
  push('春节', lunarToSolar(y + 1, 1, 1));  // 今年春节已过的兜底
  let best = null;
  for (const f of fests) if (f.diff >= 0 && (!best || f.diff < best.diff)) best = f;
  return best;
}

// 农历日(数字,1=初一)
function lunarDayOf(y, m, d) {
  let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
  let lunarYear = 1900;
  while (lunarYear < 2101 && offset >= lunarYearDays(lunarYear)) { offset -= lunarYearDays(lunarYear); lunarYear++; }
  const leap = leapMonth(lunarYear);
  let isLeap = false, lunarMonth = 1;
  while (lunarMonth <= 12) {
    const days = isLeap ? leapDays(lunarYear) : monthDays(lunarYear, lunarMonth);
    if (offset < days) break;
    offset -= days;
    if (isLeap) { isLeap = false; lunarMonth++; }
    else if (lunarMonth === leap) { isLeap = true; }
    else lunarMonth++;
  }
  return offset + 1;
}
// 月相(按农历日近似)
function moonPhase() {
  const now = new Date();
  const day = lunarDayOf(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  if (day <= 2 || day >= 29) return '🌑 新月';
  if (day <= 6) return '🌒 娥眉月';
  if (day <= 9) return '🌓 上弦月';
  if (day <= 13) return '🌔 盈凸月';
  if (day <= 17) return '🌕 满月';
  if (day <= 21) return '🌖 亏凸月';
  if (day <= 24) return '🌗 下弦月';
  return '🌘 残月';
}

let lastWeather = null;
function infoCardHtml() {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  let lunar = '';
  try { lunar = solarToLunar(now.getFullYear(), now.getMonth() + 1, now.getDate()); } catch (e) {}
  const w = lastWeather || {}, c = w.current || {};
  // 3x3 大卡:日期/时间/农历 + 当前天气 + WAN 流量 + 环境(体感/风/日出日落)
  const gridItems = [
    (c.feels !== undefined && c.feels !== '') ? `<div><span class="k">体感</span><span class="v">${c.feels}°</span></div>` : '',
    (c.wind !== undefined && c.wind !== '') ? `<div><span class="k">风速</span><span class="v">${c.wind} km/h</span></div>` : '',
    w.sunrise ? `<div><span class="k">日出</span><span class="v">☀️ ${w.sunrise}</span></div>` : '',
    w.sunset ? `<div><span class="k">日落</span><span class="v">🌇 ${w.sunset}</span></div>` : '',
  ].filter(Boolean).join('');
  return `<div class="card info-card info-3x3" data-key="i" draggable="true"
    ondragstart="onDragStart(event,'i')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'i')">
    <div class="info-date">${now.getMonth() + 1}月${now.getDate()}日 <span class="info-week">周${week}</span></div>
    <div class="info-clock" id="info-clock">--:--:--</div>
    <div class="info-lunar">农历 ${lunar || '--'}</div>
    <div class="info-weather">
      <span class="iw-t">${c.temp || '--'}°</span>
      <span class="iw-d">${wIcon(c.desc)} ${c.desc || ''} · 湿度 ${c.humidity || '--'}%</span>
    </div>
    <div class="info-grid">${gridItems}</div>
  </div>`;
}

// 1x1 信息小卡(kind: fest 节日 / week 本周 / today 今日 / moon 月相 / air 空气 / devices 设备;填剩余空格)
function infoMiniHtml(kind) {
  if (kind === 'fest') {
    try {
      const f = nextFestival();
      if (f) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-fest">🎉 ${f.name}<br><b>${f.diff}</b> 天后</div></div>`;
    } catch (e) {}
  }
  if (kind === 'week') {
    try {
      const dailies = (lastWeather && lastWeather.daily) || [];
      if (dailies.length) {
        const mx = Math.max(...dailies.map(x => +x.max));
        const mn = Math.min(...dailies.map(x => +x.min));
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">📅 本周<br>最高 <b>${mx}°</b> · 最低 <b>${mn}°</b></div></div>`;
      }
    } catch (e) {}
  }
  if (kind === 'today') {
    try {
      const d0 = (lastWeather && lastWeather.daily && lastWeather.daily[0]) || {};
      if (d0.max) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">☀️ 今日<br>${d0.desc || ''} <b>${d0.max}°</b>/${d0.min}°</div></div>`;
    } catch (e) {}
  }
  if (kind === 'moon') {
    try { return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌙 月相<br>${moonPhase()}</div></div>`; } catch (e) {}
  }
  if (kind === 'air') {
    const d = devices.find(x => x.category === 'air-monitor');
    if (d) {
      const aqi = propVal(d, 'air-quality-index');
      const co2 = propVal(d, 'co2-density');
      if (aqi !== undefined || co2 !== undefined) {
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🫧 空气<br>${aqi !== undefined ? 'AQI <b>' + aqi + '</b>' : ''}${co2 !== undefined ? ' · CO₂ <b>' + co2 + '</b>' : ''}</div></div>`;
      }
    }
  }
  if (kind === 'devices') {
    const online = devices.filter(x => x.online).length;
    if (devices.length) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">📱 米家<br><b>${online}</b>/${devices.length} 在线</div></div>`;
  }
  if (kind === 'net') {
    const on = (netDevices || []).filter(x => x.online);
    const dn = on.reduce((s, x) => s + (x.download || 0), 0);
    const up = on.reduce((s, x) => s + (x.upload || 0), 0);
    if (on.length) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌐 网络<br>↓ <b>${fmtRate(dn)}</b> ↑ <b>${fmtRate(up)}</b></div></div>`;
  }
  if (kind === 'tomorrow') {
    try {
      const d1 = (lastWeather && lastWeather.daily && lastWeather.daily[1]) || {};
      if (d1.max) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">⏭ 明日<br>${d1.desc || ''} <b>${d1.max}°</b>/${d1.min}°</div></div>`;
    } catch (e) {}
  }
  if (kind === 'weekend') {
    const now = new Date();
    const day = now.getDay();  // 0=周日
    const toSat = (6 - day + 7) % 7;
    const toSun = (7 - day + 7) % 7;
    const diff = Math.min(toSat, toSun);
    const label = diff === 0 ? '今天' : (diff === 1 ? '明天' : diff + ' 天后');
    return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🎯 周末<br><b>${label}</b></div></div>`;
  }
  if (kind === 'rain') {
    try {
      const dailies = (lastWeather && lastWeather.daily) || [];
      if (dailies.length) {
        const rain = dailies.filter(x => (x.desc || '').includes('雨')).length;
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌧 本周<br><b>${rain}</b>/7 天有雨</div></div>`;
      }
    } catch (e) {}
  }
  if (kind === 'uv') {
    try {
      const d0 = (lastWeather && lastWeather.daily && lastWeather.daily[0]) || {};
      if (d0.uv !== undefined && d0.uv !== '') {
        const lv = d0.uv >= 8 ? '很强' : d0.uv >= 6 ? '强' : d0.uv >= 4 ? '中等' : d0.uv >= 2 ? '弱' : '很弱';
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">☀️ 紫外线<br><b>${d0.uv}</b> ${lv}</div></div>`;
      }
    } catch (e) {}
  }
  if (kind === 'press') {
    try {
      const p = lastWeather && lastWeather.current && lastWeather.current.pressure;
      if (p !== null && p !== undefined && p !== '') return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">⏱ 气压<br><b>${p}</b> hPa</div></div>`;
    } catch (e) {}
  }
  if (kind === 'hum') {
    const d = devices.find(x => x.category === 'temperature-humidity-sensor')
      || devices.find(x => x.category === 'air-monitor');
    if (d) {
      const h = propVal(d, 'relative-humidity');
      if (h !== undefined) {
        const lv = h < 30 ? '干燥' : h < 60 ? '舒适' : h < 70 ? '略湿' : '潮湿';
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">💧 湿度<br><b>${h}%</b> ${lv}</div></div>`;
      }
    }
  }
  if (kind === 'devices') {
    const online = devices.filter(x => x.online).length;
    if (devices.length) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">📱 米家<br><b>${online}</b>/${devices.length} 在线</div></div>`;
  }
  if (kind === 'offline') {
    const off = devices.filter(x => !x.online);
    if (off.length) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">📴 离线<br><b>${off.length}</b> 台</div></div>`;
  }
  if (kind === 'tempdiff') {
    const d = devices.find(x => x.category === 'temperature-humidity-sensor')
      || devices.find(x => x.category === 'air-monitor');
    const t = d ? propVal(d, 'temperature') : undefined;
    const wt = lastWeather?.current?.temp;
    if (t !== undefined && wt !== undefined) {
      const diff = Math.round(t - wt);
      return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌡 室内外温差<br><b>${diff > 0 ? '+' : ''}${diff}°</b></div></div>`;
    }
  }
  if (kind === 'today') {
    const now = new Date();
    const pct = Math.round((now.getHours() + now.getMinutes() / 60) / 24 * 100);
    return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">⏳ 今日<br><b>${pct}%</b> 已过</div></div>`;
  }
  if (kind === 'sunset') {
    try {
      const s = lastWeather?.sunset;
      if (s) {
        const [hh, mm] = s.split(':').map(Number);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const setMin = hh * 60 + mm;
        const left = setMin - nowMin;
        const txt = left > 0 ? `${Math.floor(left / 60)}h${left % 60}m 后` : '已日落';
        return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌇 日落 ${s}<br><b>${txt}</b></div></div>`;
      }
    } catch (e) {}
  }
  if (kind === 'pm25') {
    const d = devices.find(x => x.category === 'air-monitor');
    if (d) {
      const p = propVal(d, 'pm25-density');
      if (p !== undefined) return `<div class="card info-mini" data-key="m:${kind}" draggable="true"
    ondragstart="onDragStart(event,'m:${kind}')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'m:${kind}')"><div class="mini-week">🌫 PM2.5<br><b>${p}</b></div></div>`;
    }
  }
  return '';
}

// ---------- 卡片管理(信息卡配置,后端存储,所有设备一致) ----------
// 只保留顶部总览条/预报条没有的信息;12 种备用卡,卡片管理面板勾选
const MINI_NAMES = {
  fest: '🎉 节日倒计时', moon: '🌙 月相', air: '🫧 空气质量',
  uv: '☀️ 紫外线', press: '⏱ 气压', weekend: '🎯 周末倒计时',
  devices: '📱 米家在线', offline: '📴 离线设备', tempdiff: '🌡 室内外温差',
  today: '⏳ 今日进度', sunset: '🌇 距日落', pm25: '🌫 PM2.5',
};
let cardCfg = { info: true, minis: ['fest', 'moon', 'air', 'uv', 'press', 'weekend', 'devices', 'offline', 'tempdiff', 'today', 'sunset', 'pm25'] };

async function loadCardCfg() {
  try {
    const d = await api('/api/layout/cards');
    if (d && d.cards) {
      const cfg = d.cards;
      // 过滤已移除的类型(重复类型清理)
      // 注意:不再无条件补默认——用户取消的卡要能持久保存(2026-08-07 审查发现
      // 旧逻辑每次加载都把默认卡补回,minis 只能增不能减)
      if (Array.isArray(cfg.minis)) {
        cfg.minis = cfg.minis.filter(k => MINI_NAMES[k]);
      }
      cardCfg = cfg;
    }
  } catch (e) {}
}
function saveCardCfg() {
  cardCfg.info = document.getElementById('cfg-info').checked;
  cardCfg.minis = Object.keys(MINI_NAMES).filter(k => document.getElementById('cfg-' + k).checked);
  hiddenDevices = [...document.querySelectorAll('#cfg-list input[data-did]:not(:checked)')].map(i => i.dataset.did);
  fetch('/api/layout/cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cards: cardCfg }),
  }).catch(() => {});
  saveOrder();  // 隐藏设备列表随 order 存后端
  renderMijia();
}
function showCardManager() {
  // 统一列表:日期大卡 → 设备 → 信息小卡(所有卡一个列表管理)
  const rows = [
    `<label class="cfg-row"><span>📅 日期/农历大卡</span><input type="checkbox" id="cfg-info" ${cardCfg.info ? 'checked' : ''}></label>`,
    ...devices.map(d =>
      `<label class="cfg-row"><span>${ICONS[d.category] || ICONS.default} ${esc(d.name)}</span><input type="checkbox" data-did="${d.did}" ${hiddenDevices.includes(d.did) ? '' : 'checked'}></label>`),
    ...Object.keys(MINI_NAMES).map(k =>
      `<label class="cfg-row"><span>${MINI_NAMES[k]}</span><input type="checkbox" id="cfg-${k}" ${(cardCfg.minis || []).includes(k) ? 'checked' : ''}></label>`),
  ];
  document.getElementById('cfg-list').innerHTML = rows.join('');
  document.getElementById('card-overlay').classList.add('show');
}
function closeCardManager() {
  document.getElementById('card-overlay').classList.remove('show');
}

function wIcon(desc) {
  if (!desc) return '';
  if (desc.includes('雷')) return '⛈️';
  if (desc.includes('雪')) return '❄️';
  if (desc.includes('雨')) return '🌧️';
  if (desc.includes('雾')) return '🌫️';
  if (desc.includes('阴')) return '☁️';
  if (desc.includes('云')) return '⛅';
  if (desc.includes('晴')) return '☀️';
  return '';
}

async function loadWeather() {
  try {
    const w = await api('/api/weather');
    lastWeather = w;
    // 局部更新预报卡 + 信息卡(天气数据变了才刷,不重建 grid)
    updateCardByHtml('fc-24h', fcBarsHtml24());
    updateCardByHtml('fc-7d', fcBarsHtml7d());
    updateCardByHtml('i', infoCardHtml());
    // mini 卡依赖天气数据(气压等):局部更新,避免首次渲染 lastWeather=null 时残留 null。
    // 若某 mini 卡在首次渲染(lastWeather=null)时没生成 DOM,局部更新找不到元素 →
    // 全量重建一次补齐(天气 15min 才刷一次,重建成本可接受)。
    let missingMini = false;
    (cardCfg.minis || []).forEach(k => {
      // 启用的 mini 卡在 DOM 缺失 = 首次渲染时数据没到(如 lastWeather=null 的
      // 气压卡)→ 标记重建;局部更新补不上"从未渲染"的卡
      if (!document.querySelector('[data-key="m:' + k + '"]')) missingMini = true;
      updateCardByHtml('m:' + k, infoMiniHtml(k));
    });
    if (missingMini) { renderMijia(); return; }
    tick();
    bindFcScroll();
    drawSparkline();  // 24h 折线实测宽度重绘
    // 手机端横滑布局稳定后重绘折线(宽度用 scrollWidth, 需等 CSS 生效)(2026-08-07)
    setTimeout(drawSparkline, 500);
    // 设备视口切换(手机↔桌面)时重绘折线
    if (!window._sparkMqBound) {
      window._sparkMqBound = true;
      const mq = window.matchMedia('(max-width: 700px)');
      const onMq = () => setTimeout(drawSparkline, 300);
      mq.addEventListener('change', onMq);
    }
  } catch (e) { /* 天气加载失败不阻塞 */ }
}

function fcBarsHtml24() {
  const w = lastWeather || {};
  const hours = w.hourly || [];
  const h24 = hours.map(x => `
    <div class="fc-h">
      <span class="fc-h-time">${String(x.hour).padStart(2, '0')}时</span>
      <span class="fc-h-icon">${wIcon(x.desc)}</span>
      <span class="fc-h-desc">${x.desc}</span>
    </div>`).join('');
  return `<div class="card fc-bar fc-24h fc-scroll" data-key="fc-24h">
    <div class="top"><span class="icon">⏰</span><div><div class="nm">24h 预报</div><div class="rm"></div></div></div>
    <div class="fc-inner">${fcSparklineHtml(hours)}${h24 || '<div class="fc-h-desc">--</div>'}</div></div>`;
}

// 24h 温度折线图:渲染后 drawSparkline() 实测宽度重绘(fc-inner flex 均分,宽度不定)
function fcSparklineHtml() {
  return `<div class="fc-spark-wrap"><svg class="fc-spark" height="52"></svg></div>`;
}
function drawSparkline() {
  const svg = document.querySelector('.fc-24h .fc-spark');
  const inner = document.querySelector('.fc-24h .fc-inner');
  const hours = (lastWeather || {}).hourly || [];
  if (!svg || !inner || hours.length < 2) return;
  const W = (window.matchMedia && window.matchMedia('(max-width: 700px)').matches)
    ? (document.querySelector('.fc-24h .fc-h')
        ? document.querySelector('.fc-24h .fc-h').getBoundingClientRect().width * hours.length
        : inner.scrollWidth)  // 手机端:折线宽 = 每列宽×列数,保证点与时间列对齐(2026-08-07)
    : inner.clientWidth;  // 桌面:实际可用宽度(随 flex 均分)
  const H = 52, PAD_TOP = 20, PAD_BOT = 5;  // 顶部留白给温度标签
  const temps = hours.map(x => parseFloat(x.temp));
  if (temps.some(t => isNaN(t))) return;
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const span = (tmax - tmin) || 1;
  const STEP = W / hours.length;
  const pts = temps.map((t, i) => {
    const x = i * STEP + STEP / 2;
    const y = H - PAD_BOT - ((t - tmin) / span) * (H - PAD_TOP - PAD_BOT);
    return [x, y];
  });
  const line = pts.map(p => p.join(',')).join(' ');
  const dots = pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.2" fill="var(--blue)"/>`).join('');
  // 温度跟随点上下浮动,13px 字号 + 背景描边(压折线也清晰)
  const labels = pts.map((p, i) =>
    `<text x="${p[0]}" y="${p[1] - 8}" text-anchor="middle" font-size="13" font-weight="600" fill="var(--text)">${Math.round(temps[i])}°</text>`).join('');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.style.width = W + 'px';  // 覆盖 CSS width:100%(手机端横滑用 scrollWidth)(2026-08-07)
  svg.innerHTML = `<polyline points="${line}" fill="none" stroke="var(--blue)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}`;
}

function fcBarsHtml7d() {
  const w = lastWeather || {};
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const d7 = (w.daily || []).map((d, i) => {
    let dt = new Date();
    try { dt = new Date(+d.date.slice(0, 4), +d.date.slice(4, 6) - 1, +d.date.slice(6, 8)); } catch (e) {}
    const label = i === 0 ? '今天' : i === 1 ? '明天' : '周' + days[dt.getDay()];
    return `<div class="fc-d">
      <span class="fc-d-day">${label}</span>
      <span class="fc-d-icon">${wIcon(d.desc)}</span>
      <span class="fc-d-temp"><b>${d.max}°</b>/${d.min}°</span>
      <span class="fc-d-desc">${d.desc}</span>
    </div>`;
  }).join('');
  return `<div class="card fc-bar fc-7d fc-scroll" data-key="fc-7d">
    <div class="top"><span class="icon">📅</span><div><div class="nm">7 天预报</div><div class="rm"></div></div></div>
    <div class="fc-inner">${d7 || '<div class="fc-h-desc">--</div>'}</div></div>`;
}

let netDevices = [];
let lastWan = null;  // WAN 出口数据(wan2/wan3/adsl1)

function renderHdrWan(wans) {
  const el = document.getElementById('hdr-wan');
  if (!wans || !wans.length) return;
  el.innerHTML = ['wan2', 'wan3', 'adsl1'].map(n => {
    const w = wans.find(x => x.name === n);
    if (!w) return '';
    return `<span class="hdr-wan-item"><b>${n.toUpperCase()}</b><i class="d">↓${fmtRate(w.download)}</i><i class="u">↑${fmtRate(w.upload)}</i></span>`;
  }).join('');
}
async function loadNetwork() {
  try {
    const data = await api('/api/network/devices');
    netDevices = data.devices;
    updateCardByHtml('net', netGroupHtml());  // 局部更新网络大卡,不重建 grid
    api('/api/network/wan').then(d => { lastWan = d.wans; renderHdrWan(d.wans); }).catch(() => {});
  } catch (e) {
    // 网络失败不覆盖整页,保持现状等下次轮询
  }
}

async function showNetDetail(mac) {
  const d = netDevices.find(x => x.mac === mac);
  if (!d) return;
  const overlay = document.getElementById('overlay');
  const sheet = document.getElementById('sheet');
  const rows = [
    ['设备名称', esc(d.name)],
    ['IP 地址', d.ip || '-'],
    ['MAC 地址', d.mac || '-'],
    ['下载速度', fmtRate(d.download) + '/s'],
    ['上传速度', fmtRate(d.upload) + '/s'],
    ['连接数', String(d.connect_num)],
    ['累计下载', fmtTotal(d.total_down)],
    ['累计上传', fmtTotal(d.total_up)],
    ['在线时长', d.uptime || '-'],
    ['最后在线', d.last_seen || (d.online ? '当前在线' : '-')],
  ];
  sheet.innerHTML = `
    <button class="close" onclick="closeSheet()">✕</button>
    <h2>${esc(d.name)}</h2>
    <div class="sub">${d.online ? '🟢 在线' : '⚫ 离线'} · 数据来源:爱快</div>
    ${rows.map(([k, v]) => `<div class="prop-row"><span class="prop-name">${k}</span><span class="prop-val">${v}</span></div>`).join('')}
    <div id="conn-area" style="margin-top:10px"><div class="sub">连接列表加载中…</div></div>`;
  overlay.classList.add('show');

  // 加载连接详情
  if (d.online) {
    try {
      const cd = await api('/api/network/connections/' + d.ip);
      const conns = cd.conn || [];
      const connHtml = conns.length
        ? conns.slice(0, 50).map(c => `
          <div class="conn-row">
            <div class="conn-main">
              <span class="conn-app">${esc(c.app_name || c.protocol || '?')}</span>
              <span class="conn-dst">${esc(c.dst_addr || '?')}:${esc(c.dst_port ?? '')}</span>
              <span class="conn-proto">${c.protocol || ''}</span>
            </div>
            <div class="conn-meta">${c.status || ''} · ↓${fmtTotal(c.total_down)} ↑${fmtTotal(c.total_up)}</div>
          </div>`).join('')
        : '<div class="sub">暂无连接</div>';
      document.getElementById('conn-area').innerHTML = `
        <div class="sub" style="margin-bottom:6px">🔗 连接详情(${cd.conn_num || conns.length} 条,显示前 ${Math.min(conns.length, 50)} 条)</div>
        ${connHtml}`;
    } catch (e) {
      document.getElementById('conn-area').innerHTML = '<div class="sub">连接列表加载失败</div>';
    }
  } else {
    document.getElementById('conn-area').innerHTML = '<div class="sub">设备离线,无连接数据</div>';
  }
}

function closeSheet() {
  document.getElementById('overlay').classList.remove('show');
}

// ---------- 摄像头画面(单例 iframe 常驻 #cam-float,永不移动/销毁) ----------
