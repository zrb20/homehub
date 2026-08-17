let specs = {};   // did -> [prop defs]
let devices = []; // 设备+props
let busy = {};    // did -> 正在发送的控制

// ---------- 枚举翻译 ----------
const ENUM_CN = {
  'Auto': '自动', 'Normal': '正常', 'Dot': '按钮', 'Sleep': '睡眠',
  'Strong': '强力', 'Air-dry': '风干', 'Constant Humidity': '恒湿',
  'On': '开', 'Off': '关', 'Dim': '暗', 'Medium': '中等', 'High': '高',
  'Cool': '制冷', 'Dry': '除湿', 'Fan': '送风', 'Heat': '制热',
  'Level1': '1档', 'Level2': '2档', 'Level3': '3档', 'Level4': '4档',
  'Level5': '5档', 'Level6': '6档', 'Level7': '7档', 'Level8': '8档',
  'All Record': '全程录制', 'Motion Record': '移动录制', 'No Record': '不录制',
  'Low': '低', 'Cloud Recommendation': '云端推荐', 'Custom': '自定义',
  'Upward Flow': '向上送风', 'Top': '顶部', 'Middle': '中部', 'Bottow': '底部',
  'Downward Flow': '向下送风', 'Circular Flow': '环绕送风', 'Upper': '上方', 'Lower': '下方',
  'Weak Cold': '弱冷', 'Small Cold': '小冷', 'Comfort': '舒适', 'Big Cold': '强冷', 'Strong Cold': '强力冷',
  'Weak Heat': '弱热', 'Small Heat': '小热', 'Big Heat': '强热', 'Strong Heat': '强力热',
  'Default': '默认', 'No Faults': '正常', 'Moto Fault': '电机故障', 'Pump Fault': '水泵故障',
  'Pump Fail': '水泵失效', 'Lack Of Water': '缺水',
};
const cn = k => ENUM_CN[k] || k;

const ICONS = {
  outlet: '🔌', humidifier: '💨', camera: '📷', router: '📡',
  watch: '⌚', 'air-conditioner': '❄️', 'temperature-humidity-sensor': '🌡️',
  fan: '🌀', 'air-monitor': '🫧', speaker: '🔊', default: '📱',
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return r.json();
}

// 外部数据(设备名/房间名/网络设备名等)拼 innerHTML 前必须过 esc()
// 防止设备名带 HTML 时 XSS(2026-08-07 审查发现,内网低危但属低级错误)
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 监控屏软件开关(2026-08-07): 调 N4500 容器的 screen-power HTTP 服务
// http://192.168.203.25:8125/off 熄屏 /on 亮屏 /status 查询
let screenPowerOn = true;
async function toggleScreenPower() {
  try {
    const st = await fetch('http://192.168.203.25:8125/status').then(r => r.json());
    screenPowerOn = st.mode === 0;
  } catch (e) { /* 服务不可达默认亮屏 */ }
  const target = screenPowerOn ? 'off' : 'on';
  try {
    await fetch(`http://192.168.203.25:8125/${target}`);
    screenPowerOn = !screenPowerOn;
    const btn = document.getElementById('hdr-power');
    if (btn) {
      btn.textContent = screenPowerOn ? '🌙 熄屏' : '☀️ 亮屏';
      btn.title = screenPowerOn ? '熄屏' : '亮屏';
    }
  } catch (e) { /* 忽略 */ }
}

// ---------- 控制发送 ----------
async function sendControl(did, specName, value) {
  if (busy[did]) return;
  busy[did] = true;
  // 乐观更新:先本地改值并立即刷新该卡(用户要求"点完马上看到变化,不等同步")
  const d = devices.find(x => x.did === did);
  if (d) {
    const plain = specName.split('@')[0];  // 'on@开关' → 'on'(props 里 spec_name 带 @service,需消歧)
    const p = (d.props || []).find(x => String(x.spec_name) === specName)
           || (d.props || []).find(x => String(x.spec_name).split('@')[0] === plain);
    if (p) p.value = String(value);
    else d.props.push({ spec_name: specName, value: String(value) });
    optimistic[did] = optimistic[did] || {};
    optimistic[did][plain] = { v: String(value), ts: Date.now() };  // 记录乐观值+时间,0.8s 未确认回退真实值
    updateCardByHtml('d:' + did, cardBody(d));
    positionCamFloat();
  }
  try {
    await api('/api/mijia/device/' + did + '/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec_name: specName, value: String(value) }),
    });
  } catch (e) {
    alert('控制失败: ' + e.message);
    delete optimistic[did];  // 失败:放弃乐观值,拉真实状态
    loadMijia();
  } finally {
    busy[did] = false;
    setTimeout(loadMijia, 800);  // 0.8s 后校正(尽可能短,未确认立即回退真实值)
  }
}
let optimistic = {};  // did -> {spec_name: value} 控制后的乐观值,服务器确认前不被覆盖

// ---------- 辅助 ----------
function propVal(d, name) {
  // name 两种格式:'mode' 纯名(匹配任意 service)或 'fan-level@风机控制'(精确匹配)
  const hasSvc = String(name).includes('@');
  const p = hasSvc
    ? (d.props || []).find(x => String(x.spec_name) === name)
    : (d.props || []).find(x => String(x.spec_name).split('@')[0] === name);
  return p ? p.value : undefined;
}
function specOf(did, name) {
  // name 两种格式:'mode' 纯名(匹配任意 service)或 'fan-level@风机控制'(精确匹配 service)
  const str = String(name);
  const at = str.indexOf('@');
  if (at >= 0) {
    const plain = str.slice(0, at), svc = str.slice(at + 1);
    return (specs[did] || []).find(s => s.name === plain && s.service_desc === svc);
  }
  return (specs[did] || []).find(s => s.name === str);
}
function enCtl(did, name, val) {
  const s = specOf(did, name);
  return s && s.values ? s.values[val] : undefined;
}

// ---------- 控件渲染 ----------
