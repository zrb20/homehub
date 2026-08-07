function renderSwitch(did, name, checked, onchange) {
  const b = busy[did] ? 'busy' : '';
  return `<label class="switch ${b}">
    <input type="checkbox" ${checked ? 'checked' : ''} onchange="${onchange}">
    <span class="slider"></span>
  </label>`;
}

function renderPowerBtn(did, name, on) {
  const b = busy[did] ? 'busy' : '';
  return `<button class="power-btn ${on ? 'on' : ''} ${b}" onclick="sendControl('${did}','${name}','${!on}')">⏻</button>`;
}

function renderModeGroup(did, name, currentVal) {
  const s = specOf(did, name);
  if (!s || !s.values) return '';
  const b = busy[did] ? 'busy' : '';
  return `<div class="btn-group">${Object.entries(s.values).map(([k, v]) =>
    `<button class="mbtn ${String(currentVal) === String(k) ? 'active' : ''} ${b}"
      onclick="sendControl('${did}','${name}','${k}')">${cn(v)}</button>`
  ).join('')}</div>`;
}

function renderStep(did, name, val, unit) {
  const s = specOf(did, name);
  const step = s ? s.step || 1 : 1;
  const mn = s ? s.min : null, mx = s ? s.max : null;
  const b = busy[did] ? 'busy' : '';
  const v = (val === undefined || val === null) ? '' : val;
  return `<div class="step-ctl">
    <button class="step-btn ${b}" onclick="stepCtrl('${did}','${name}',-${step})">−</button>
    <span class="step-val">${v}${unit || ''}</span>
    <button class="step-btn ${b}" onclick="stepCtrl('${did}','${name}',${step})">＋</button>
  </div>`;
}

// 风速滑动条:0=自动,1..max 档位。拖动实时改显示,松手才发控制(避免拖动狂发请求)
function renderFanSlider(did, name, val, max) {
  const v = (val === undefined || val === null) ? 0 : Number(val);
  const lbl = v === 0 ? '自动' : v + '档';
  const b = busy[did] ? 'busy' : '';
  return `<div class="fan-slider ${b}">
    <input type="range" min="0" max="${max}" step="1" value="${v}" draggable="false"
      oninput="this.parentNode.querySelector('.fs-val').textContent = (this.value==='0' ? '自动' : this.value+'档')"
      onchange="sendControl('${did}','${name}',this.value)">
    <span class="fs-val">${lbl}</span>
  </div>`;
}

async function stepCtrl(did, name, delta) {
  const s = specOf(did, name);
  const cur = propVal(devices.find(d => d.did === did), name);
  if (cur === undefined) return;
  let next = Math.round((parseFloat(cur) + delta) * 10) / 10;
  if (s && s.min !== null) next = Math.max(s.min, next);
  if (s && s.max !== null) next = Math.min(s.max, next);
  await sendControl(did, name, next);
}

// ---------- 卡片系统(设备卡+信息卡统一排序,后端存储,所有设备一致) ----------
