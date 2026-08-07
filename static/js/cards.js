const COMPACT_CATS = ['router', 'temperature-humidity-sensor', 'fan', 'speaker', 'watch', 'air-monitor'];

function cardBody(d) {
  const compact = COMPACT_CATS.includes(d.category);
  const on = propVal(d, d.onName) ?? propVal(d, 'on') ?? propVal(d, 'on@开关') ?? propVal(d, 'on@加湿器') ?? propVal(d, 'on@空调');
  if (d.category === 'air-conditioner') return acCard(d, on, compact);
  if (d.category === 'humidifier') return humCard(d, on, compact);
  if (d.category === 'temperature-humidity-sensor' || d.category === 'air-monitor') return sensorCard(d, compact);
  if (d.category === 'router') return routerCard(d, compact);
  if (d.category === 'camera') return cameraCard(d, on, compact);
  return genericCard(d, on, compact);
}

function cardShell(d, inner, wide, compact, extra, pwr, key) {
  const k = key || ('d:' + d.did);
  return `<div class="card ${wide ? 'wide' : ''} ${compact ? 'compact' : ''} ${extra || ''} ${d.online ? '' : 'offline'}" data-key="${k}"
    draggable="true"
    onmousedown="cardMouseDown(event,this)"
    onmouseup="cardMouseUp(this)"
    ondragstart="onDragStart(event,'${k}')"
    ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)"
    ondragleave="onDragLeaveCard(event)"
    ondrop="onDropCard(event,'${k}')">
    <div class="top">
      <span class="icon">${ICONS[d.category] || ICONS.default}</span>
      <div>
        <div class="nm">${esc(d.name)}</div>
        <div class="rm">${esc(d.room || '')}</div>
      </div>
      ${d.online ? '' : `<span class="online-badge off">离线</span>`}
    </div>
    ${pwr ? `<div class="pwr">${renderPowerBtn(pwr.did, pwr.name, pwr.on)}</div>` : ''}
    ${inner}
  </div>`;
}

// 空调
function acCard(d, on) {
  const temp = propVal(d, 'target-temperature');
  const envT = propVal(d, 'temperature');
  const mode = propVal(d, 'mode');
  const fan = propVal(d, 'fan-level@风机控制');
  const hsw = propVal(d, 'horizontal-swing');
  const eco = propVal(d, 'eco');
  // 新风(新风机 service,米家新风空调):开关 + 风速
  const freshOn = propVal(d, 'on@新风机');
  const freshFan = propVal(d, 'fan-level@新风机');
  const freshName = 'on@新风机';
  const name = d.onName || 'on@空调';
  const inner = `
    <div class="bigval">
      <div class="v temp-val">${temp !== undefined ? temp : '--'}<small>°C</small></div>
      <div class="l">设定温度${envT !== undefined ? ` · 室温 ${envT}°C` : ''}</div>
    </div>
    <div class="ctl">
      <div class="ctl-row"><span class="ctl-label">模式</span>${renderModeGroup(d.did, 'mode', mode)}</div>
      <div class="ctl-row"><span class="ctl-label">温度</span>${renderStep(d.did, 'target-temperature', temp, '°C')}</div>
      <div class="ctl-row"><span class="ctl-label">风速</span>${renderFanSlider(d.did, 'fan-level@风机控制', fan, 8)}</div>
      <div class="ctl-row"><span class="ctl-label">新风</span>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="display:flex;align-items:center;gap:5px">${renderSwitch(d.did, freshName, !!freshOn, `sendControl('${d.did}','${freshName}','${!freshOn}')`)}</span>
          <span style="flex:1">${renderFanSlider(d.did, 'fan-level@新风机', freshFan, 5)}</span>
        </div>
      </div>
      <div class="ctl-row"><span class="ctl-label">扫风·节能</span>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="display:flex;align-items:center;gap:5px">${renderSwitch(d.did, 'horizontal-swing', !!hsw, `sendControl('${d.did}','horizontal-swing','${!hsw}')`)}</span>
          <span style="display:flex;align-items:center;gap:5px">${renderSwitch(d.did, 'eco', !!eco, `sendControl('${d.did}','eco','${!eco}')`)}</span>
        </div>
      </div>
    </div>`;
  return cardShell(d, inner, true, false, '', { did: d.did, name, on: !!on });  // 空调 2x2,电源右上角
}

// 加湿器
function humCard(d, on) {
  const curH = propVal(d, 'relative-humidity');
  const target = propVal(d, 'target-humidity');
  const mode = propVal(d, 'mode');
  const name = d.onName || 'on@加湿器';
  const inner = `
    <div class="bigval">
      <div class="v hum-val">${curH !== undefined ? curH : '--'}<small>%</small></div>
      <div class="l">目标 ${target !== undefined ? target + '%' : ''}</div>
    </div>
    <div class="ctl">
      <div class="ctl-row"><span class="ctl-label">模式</span>${renderModeGroup(d.did, 'mode', mode)}</div>
      <div class="ctl-row"><span class="ctl-label">目标湿度</span>${renderStep(d.did, 'target-humidity', target, '%')}</div>
    </div>`;
  return cardShell(d, inner, false, true, '', { did: d.did, name, on: !!on });  // 加湿器缩为 1x1(compact),电源右上角
}

// 传感器:紧凑显示温度湿度
function sensorCard(d, compact) {
  const t = propVal(d, 'temperature');
  const h = propVal(d, 'relative-humidity');
  const aqi = propVal(d, 'air-quality-index');
  const co2 = propVal(d, 'co2-density');
  const rows = [];
  if (aqi !== undefined || co2 !== undefined) {
    const bits = [];
    if (aqi !== undefined) bits.push(`AQI <b class="${aqi > 100 ? 'amber' : 'green'}">${aqi}</b>`);
    if (co2 !== undefined) bits.push(`CO₂ <b class="${co2 > 1000 ? 'amber' : ''}">${co2}</b>`);
    rows.push(`<div class="valrow" style="${compact ? 'font-size:10px' : ''}"><span class="k">空气</span><span class="v">${bits.join(' · ')}</span></div>`);
  }
  const inner = `
    <div class="bigval" style="display:flex;justify-content:center;gap:16px">
      ${t !== undefined ? `<div><div class="v temp-val">${t}<small>°C</small></div><div class="l">温度</div></div>` : ''}
      ${h !== undefined ? `<div><div class="v hum-val">${h}<small>%</small></div><div class="l">湿度</div></div>` : ''}
    </div>
    ${rows.join('')}`;
  return cardShell(d, inner, false, compact);
}

// 路由器 — AP 模式,紧凑显示
function routerCard(d, compact) {
  const inner = compact
    ? `<div class="ctl-row" style="min-height:auto"><span class="ctl-label">角色</span><span class="v" style="font-size:11px;color:var(--muted)">AP 节点</span></div>`
    : `<div class="ctl">
        <div class="valrow"><span class="k">角色</span><span class="v">AP 节点</span></div>
        <div class="valrow"><span class="k">网络数据</span><span class="v" style="color:var(--muted);font-weight:400;font-size:12px">见爱快后台</span></div>
      </div>`;
  return cardShell(d, inner, false, compact);
}

// 摄像头
function cameraCard(d, on) {
  const night = propVal(d, 'night-shot');
  const rec = propVal(d, 'recording-mode');
  const motion = propVal(d, 'motion-detection');
  const name = d.onName || 'on@摄像机控制';
  const nightMap = { 0: '开', 1: '关', 2: '自动' };
  const recMap = { 0: '全程', 1: '移动', 2: '不录' };
  const inner = `
    <div class="ctl">
      <div class="cam-live" onclick="showCamera()">
        <div class="cam-live-hint">📹 实时画面加载中…</div>
        <span class="cam-badge">● 直播</span>
      </div>
      <div class="ctl-row"><span class="ctl-label">夜视</span>
        <div class="btn-group">${Object.entries(nightMap).map(([k, v]) =>
          `<button class="mbtn ${String(night) === k ? 'active' : ''}" onclick="sendControl('${d.did}','night-shot','${k}')">${v}</button>`).join('')}</div>
      </div>
      <div class="ctl-row"><span class="ctl-label">录制</span>
        <div class="btn-group">${Object.entries(recMap).map(([k, v]) =>
          `<button class="mbtn ${String(rec) === k ? 'active' : ''}" onclick="sendControl('${d.did}','recording-mode','${k}')">${v}</button>`).join('')}</div>
      </div>
      <div class="ctl-row"><span class="ctl-label">移动侦测</span>${renderSwitch(d.did, 'motion-detection', !!motion, `sendControl('${d.did}','motion-detection','${!motion}')`)}</div>
    </div>`;
  return cardShell(d, inner, true, false, 'cam-big', { did: d.did, name, on: !!on });  // 摄像机 2x3,电源右上角,点画面放大
}

// 通用(热水器/净化器/风扇/手环等)
// 找设备电源开关 spec:name=='on' 且 service_desc=='开关' 优先,排除'指示灯'等杂项
function onSpecOf(did) {
  const ss = specs[did] || [];
  return ss.find(s => s.name === 'on' && s.service_desc === '开关')
      || ss.find(s => s.name === 'on' && s.service_desc && s.service_desc !== '指示灯');
}
function genericCard(d, on, compact) {
  const pw = propVal(d, 'electric-power');
  const volt = propVal(d, 'voltage');
  const mode = propVal(d, 'mode');
  const onSpec = onSpecOf(d.did);
  const name = onSpec ? ('on@' + onSpec.service_desc) : null;
  const rows = [];
  if (pw !== undefined) rows.push(`<div class="valrow"><span class="k">功率</span><span class="v amber">${pw} W</span></div>`);
  if (volt !== undefined) rows.push(`<div class="valrow"><span class="k">电压</span><span class="v">${volt} V</span></div>`);
  if (mode !== undefined && specOf(d.did, 'mode')?.values) rows.push(`<div class="ctl-row"><span class="ctl-label">模式</span>${renderModeGroup(d.did, 'mode', mode)}</div>`);
  // 没有 on@ spec(如 BLE 循环扇,只有充电状态)→ 无法 API 控制,只显示状态/提示
  if (!name) {
    const inner = `<div class="ctl">
      ${rows.join('')}
      ${rows.length ? '' : '<div class="valrow"><span class="k">控制</span><span class="v" style="color:var(--muted);font-weight:400;font-size:12px">仅米家 App 可控制</span></div>'}
    </div>`;
    return cardShell(d, inner, false, compact);
  }
  const hasCtrl = rows.length > 0; // 有额外控件 → 电源固定右上角;只有电源的小卡(风扇/音箱/手环)电源留居中
  const inner = `
    <div class="ctl">
      ${hasCtrl ? '' : `<div class="ctl-row"><span class="ctl-label">电源</span>${renderPowerBtn(d.did, name, !!on)}</div>`}
      ${rows.join('')}
    </div>`;
  return cardShell(d, inner, false, compact, '', hasCtrl ? { did: d.did, name, on: !!on } : null);
}

// 局部更新:按 data-key 替换单个卡片节点(不重建 grid,时钟/摄像头/拖拽不受影响)
function updateCardByHtml(key, html) {
  const el = document.querySelector(`[data-key="${key}"]`);
  if (!el) return;
  if (!html) { el.remove(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild;
  el.replaceWith(fresh);
}
// 预报卡横向滚动(滚轮转横向,无滚动条;触屏滑动原生支持)
function bindFcScroll(root) {
  (root || document).querySelectorAll('.fc-scroll').forEach(el => {
    el.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  });
}

// ---------- 渲染 ----------
// 坑(2026-08-06):iframe 不能放在 grid 卡片里 —— grid.innerHTML 全量重建会
// 销毁它(下树即销毁 context→页面重载→WS 重连→等摄像头关键帧批 45-60s 才出
// 画面,每 10s 循环"无画面→等待→解码→画面")。iframe 常驻 body 下 #cam-float,
// 这里只重建卡片 + 重定位 #cam-float。
// ---------- 全卡片渲染(预报横条 + 设备 + 网络 + 信息,统一网格) ----------
function fcBarsHtml() {
  const w = lastWeather || {};
  const hours = w.hourly || [];
  const h24 = hours.map(x => `
    <div class="fc-h">
      <span class="fc-h-time">${String(x.hour).padStart(2, '0')}时</span>
      <span class="fc-h-icon">${wIcon(x.desc)}</span>
      <span class="fc-h-desc">${x.desc}</span>
    </div>`).join('');
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
  return `<div class="card fc-bar fc-24h fc-scroll" data-key="fc-24h">
    <div class="top"><span class="icon">⏰</span><div><div class="nm">24h 预报</div><div class="rm"></div></div></div>
    ${fcSparklineHtml(hours)}
    <div class="fc-inner">${h24 || '<div class="fc-h-desc">--</div>'}</div></div>`
    + `<div class="card fc-bar fc-7d fc-scroll" data-key="fc-7d">
    <div class="top"><span class="icon">📅</span><div><div class="nm">7 天预报</div><div class="rm"></div></div></div>
    <div class="fc-inner">${d7 || '<div class="fc-h-desc">--</div>'}</div></div>`;
}
function wxCardHtml() {
  const c = lastWeather?.current || {};
  return `<div class="card wx-card">
    <div class="wx-t">${c.temp || '--'}°</div>
    <div class="wx-d">${wIcon(c.desc)} ${c.desc || ''}</div>
    <div class="wx-x">湿度 ${c.humidity || '--'}%</div>
  </div>`;
}
function climateCardHtml() {
  const d = devices.find(x => x.category === 'temperature-humidity-sensor')
    || devices.find(x => x.category === 'air-monitor');
  const t = d ? propVal(d, 'temperature') : undefined;
  const h = d ? propVal(d, 'relative-humidity') : undefined;
  return `<div class="card climate-card" data-key="cl" draggable="true"
    onmousedown="cardMouseDown(event,this)" onmouseup="cardMouseUp(this)"
    ondragstart="onDragStart(event,'cl')" ondragend="onDragEnd()"
    ondragover="onDragOverCard(event)" ondragleave="onDragLeaveCard(event)" ondrop="onDropCard(event,'cl')">
    <div class="cc-t">${t !== undefined ? t + '°' : '--'}</div>
    <div class="cc-h">${h !== undefined ? h + '%' : ''}</div>
    <div class="cc-l">室内温湿度</div>
  </div>`;
}
function netGroupHtml() {
  const nets = (netDevices || []).filter(d => d.online);
  const subs = nets.map(d => `
    <div class="net-sub" onclick="showNetDetail('${d.mac}')">
      <div class="n">${esc(d.name)}</div>
      <div class="m">${d.ip || '-'}</div>
      <div class="nr"><span class="r-down">↓ ${fmtRate(d.download)}/s</span><span class="r-up">↑ ${fmtRate(d.upload)}/s</span><span class="r-conn">🔗${d.connect_num}</span></div>
    </div>`).join('');
  return `<div class="card net-group" data-key="net">
    <div class="top"><span class="icon">🌐</span><div><div class="nm">网络设备</div><div class="rm"></div></div></div>
    <div class="ng-title">${nets.length} 台在线</div>
    <div class="ng-grid">${subs || '<div class="net-sub" style="color:var(--muted)">暂无在线设备</div>'}</div>
  </div>`;
}
function gridSpanOf(d) {
  if (d.category === 'camera') return 9;           // 摄像机 3x3
  if (d.category === 'air-conditioner') return 4;  // 空调 2x2
  return 1;
}
// 单卡渲染安全包装:任何一张卡渲染抛异常只丢自己(显示错误占位),不影响其他卡
// (2026-08-07 用户要求卡片解耦 —— 之前 grid.innerHTML 整串拼接,一张卡炸全网格挂)
function safeCardHtml(fn, key) {
  try {
    const h = fn();
    return h || '';
  } catch (e) {
    console.error('卡片渲染失败', key, e);
    return `<div class="card err-card" data-key="${key}">⚠️ ${key}</div>`;
  }
}
