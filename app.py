"""
家庭设备控制面板后端 v3 — 单页监控屏 (docker 容器版)
米家设备(个性化控制) + 网络设备(zr_monitor) + 摄像头分发
v3: miloco 交互全部走 HTTP API(后端 1810),不再依赖 miloco-cli subprocess,
    适配容器部署(环境变量配置: MILOCO_BASE_URL / MILOCO_TOKEN / CAMERA_ID / ZR_DEVICE_INFO)
- /api/mijia/state   批量设备状态(props 缓存 8s)
- /api/mijia/specs   设备控制能力定义(spec 缓存 24h)
- POST /api/mijia/device/{did}/control  控制
- /api/network/devices  网络设备列表
- /api/camera/*       摄像头实时画面(分发)
"""
import json
import os
import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor

import asyncio
import hashlib
import requests
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

# ---------- 配置(容器用环境变量) ----------

MILOCO_BASE_URL = os.environ.get("MILOCO_BASE_URL", "http://127.0.0.1:1810")
MILOCO_TOKEN = os.environ.get("MILOCO_TOKEN", "")
CAMERA_ID = os.environ.get("CAMERA_ID", "525201437")
ZR_DEVICE_INFO = os.environ.get("ZR_DEVICE_INFO", os.path.expanduser("~/zr_monitor/device_info.json"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="家庭设备面板 v3 (docker)")

# ---------- miloco HTTP 客户端 ----------

def _miloco_token() -> str:
    """token 来源:环境变量优先,否则读本机 miloco config.json(开发模式)。"""
    if MILOCO_TOKEN:
        return MILOCO_TOKEN
    try:
        with open(os.path.expanduser("~/.hermes/miloco/config.json"), encoding="utf-8") as f:
            return json.load(f).get("server", {}).get("token", "")
    except Exception:
        return ""


def _miot_headers() -> dict:
    return {"Authorization": f"Bearer {_miloco_token()}"}


def _miot_get(path: str, timeout: int = 15) -> dict:
    r = requests.get(f"{MILOCO_BASE_URL}{path}", headers=_miot_headers(), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _miot_post(path: str, body: dict, timeout: int = 15) -> dict:
    r = requests.post(
        f"{MILOCO_BASE_URL}{path}", json=body,
        headers={**_miot_headers(), "Content-Type": "application/json"}, timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def _infer_value(raw: str):
    """与 miloco-cli 一致:true/false → bool, 数字 → int/float, 其余 → str。"""
    if raw.lower() == "true":
        return True
    if raw.lower() == "false":
        return False
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


# ---------- Spec 解析(HTTP 结构化 dict 版) ----------

_UNIT_CN = {
    "celsius": "°C", "percentage": "%", "watt": "W", "arcdegrees": "°",
    "minutes": "分钟", "ppm": "ppm", "mg/m3": "mg/m³", "uint16": "", "uint32": "",
    "hours": "小时", "kelvin": "K", "lux": "lux", "milliwatt": "mW",
}


def parse_spec_dict(spec: dict) -> list[dict]:
    """HTTP spec dict → 前端 props 结构(与 v2 CLI 解析输出兼容)。"""
    props = []
    for iid, e in (spec or {}).items():
        vr = e.get("value_range") or []
        values = None
        vl = e.get("value_list")
        if vl:
            values = {str(v.get("value")): v.get("name") for v in vl}
        props.append({
            "iid": iid,
            "service": e.get("service_type_name", ""),
            "service_desc": e.get("service_description", ""),
            "name": e.get("type_name", ""),
            "access": "wr" if e.get("writeable") else "r",
            "type": e.get("format", ""),
            "comment": (e.get("description") or "").strip(),
            "values": values,
            "min": vr[0] if len(vr) > 0 else None,
            "max": vr[1] if len(vr) > 1 else None,
            "step": vr[2] if len(vr) > 2 else None,
            "unit": _UNIT_CN.get(e.get("unit", ""), e.get("unit", "")),
        })
    return props


_spec_cache: dict[str, tuple[float, list[dict]]] = {}


def get_spec(did: str) -> list[dict]:
    """设备属性定义,24 小时缓存。失败返回空列表。"""
    now = time.time()
    if did in _spec_cache and now - _spec_cache[did][0] < 86400:
        return _spec_cache[did][1]
    try:
        data = _miot_get(f"/api/miot/devices/{did}/spec").get("data", {})
        props = parse_spec_dict(data.get("spec", {}))
    except Exception:
        return []
    _spec_cache[did] = (now, props)
    return props


# ---------- 设备列表与状态 ----------

_devices_cache = {"ts": 0.0, "data": None}
_devices_lock = threading.Lock()  # single-flight(2026-08-07)


def get_devices() -> list[dict]:
    now = time.time()
    if _devices_cache["data"] is not None and now - _devices_cache["ts"] < 5:
        return _devices_cache["data"]
    with _devices_lock:
        now = time.time()
        if _devices_cache["data"] is not None and now - _devices_cache["ts"] < 5:
            return _devices_cache["data"]
        return _get_devices_unlocked()


def _get_devices_unlocked() -> list[dict]:
    now = time.time()
    devices = []
    try:
        data = _miot_get("/api/miot/home").get("data", {})
        devices = [{
            "did": d.get("did", ""),
            "name": d.get("name", ""),
            "room": d.get("room", ""),
            "category": d.get("category", ""),
            "online": bool(d.get("online", False)),
        } for d in data.get("devices", [])]
    except Exception:
        pass
    _devices_cache["ts"] = now
    _devices_cache["data"] = devices
    return devices


def get_props(did: str) -> list[dict]:
    try:
        data = _miot_get(f"/api/miot/devices/{did}/status").get("data", {})
    except Exception:
        return []
    props = [p for p in data.get("properties", []) if p.get("code", -1) == 0]
    # HTTP status 的 properties 不带 spec_name(CLI 会补),前端 propVal 靠
    # spec_name 匹配属性 → 缺了它所有状态/控制都失效。用 spec 补上。
    if props:
        # spec_name 用 name@service_desc 格式(同名字段如空调 fan-level 风机控制/新风机、
        # 三个 on 空调/指示灯/新风机,靠 service 消歧);无 service 时退回纯名。
        name_by_iid = {}
        for sp in get_spec(did):
            nm = sp["name"]
            if sp.get("service_desc"):
                nm = f"{nm}@{sp['service_desc']}"
            name_by_iid[sp["iid"]] = nm
        for p in props:
            if "spec_name" not in p:
                p["spec_name"] = name_by_iid.get(p["iid"], p["iid"])
    return props


_state_cache = {"ts": 0.0, "data": None}
_state_lock = threading.Lock()  # single-flight(2026-08-07)


def get_state() -> dict:
    """所有设备列表 + 在线设备的 props,8 秒缓存。single-flight:并发请求共享一次刷新。"""
    now = time.time()
    if _state_cache["data"] is not None and now - _state_cache["ts"] < 8:
        return _state_cache["data"]

    with _state_lock:
        # double-check:持锁后再查,等待线程直接拿缓存
        now = time.time()
        if _state_cache["data"] is not None and now - _state_cache["ts"] < 8:
            return _state_cache["data"]
        return _get_state_unlocked()


def _get_state_unlocked() -> dict:
    devices = get_devices()
    online = [d for d in devices if d["online"]]
    props_map: dict[str, list[dict]] = {}
    if online:
        with ThreadPoolExecutor(max_workers=6) as ex:
            results = ex.map(get_props, [d["did"] for d in online])
            for d, props in zip(online, results):
                props_map[d["did"]] = props

    for d in devices:
        d["props"] = props_map.get(d["did"], [])

    state = {
        "devices": devices,
        "total": len(devices),
        "online": len(online),
        "ts": time.strftime("%H:%M:%S"),
    }
    _state_cache["ts"] = time.time()
    _state_cache["data"] = state
    return state


@app.get("/api/mijia/state")
def mijia_state():
    return get_state()


@app.get("/api/mijia/specs")
def mijia_specs():
    """所有在线设备的控制能力定义(spec)。"""
    devices = get_devices()
    out = {}
    for d in devices:
        if d["online"]:
            out[d["did"]] = get_spec(d["did"])
    return {"specs": out}


class ControlRequest(BaseModel):
    spec_name: str
    value: str


def _resolve_control(did: str, spec_name: str, value: str) -> dict:
    """spec_name → iid(与 miloco-cli lookup_iid_by_key 等价);value 类型推断。"""
    key = re.sub(r"\([^)]*\)$", "", spec_name).strip()
    if re.match(r"^(prop|action)\.\d+\.\d+$", key):
        return {"iid": key, "value": _infer_value(value)}
    m = re.match(r"^(.+?)@(.+)$", key)
    type_name, desc = (m.group(1), m.group(2)) if m else (key, None)
    for p in get_spec(did):
        if p["name"] == type_name and (desc is None or p.get("service_desc") == desc):
            return {"iid": p["iid"], "value": _infer_value(value)}
    raise HTTPException(400, detail=f"未找到 spec_name '{spec_name}' 对应的属性")


@app.post("/api/mijia/device/{did}/control")
def mijia_control(did: str, req: ControlRequest):
    try:
        resolved = _resolve_control(did, req.spec_name, req.value)
        data = _miot_post(
            f"/api/miot/devices/{did}/control",
            {"type": "set_property", "iid": resolved["iid"], "value": resolved["value"]},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=str(e))
    if data.get("code", 0) != 0:
        raise HTTPException(502, detail=data.get("message", "设备侧执行失败"))
    _state_cache["ts"] = 0.0
    _devices_cache["ts"] = 0.0
    return {"ok": True, "detail": json.dumps(data, ensure_ascii=False)}


# ---------- 爱快实时数据 ----------

IKUAI_URL = os.environ.get("IKUAI_URL", "http://192.168.203.1")
IKUAI_USER = os.environ.get("IKUAI_USER", "admin")
IKUAI_PASS = os.environ.get("IKUAI_PASS", "")  # 必填,不设默认(2026-08-07 归档清理硬编码密码)

# requests.Session 非线程安全(2026-08-07 审查):用 threading.local 每线程自建,
# 避免 5s 轮询 + 多浏览器并发时多线程共享 session 竞态
_tls = threading.local()
_ikuai_cache = {"ts": 0.0, "data": None}
_ikuai_lock = threading.Lock()  # 缓存 single-flight


def _ikuai_session():
    if not hasattr(_tls, "session"):
        _tls.session = None
    return _tls.session


def _ikuai_login():
    s = requests.Session()
    md5 = hashlib.md5(IKUAI_PASS.encode()).hexdigest()
    try:
        s.post(f"{IKUAI_URL}/Action/login", json={"username": IKUAI_USER, "passwd": md5}, timeout=10)
        _tls.session = s
    except Exception:
        _tls.session = None


def get_ikuai_terminals() -> list[dict]:
    """爱快终端列表(实时速率+连接数),5 秒缓存。single-flight:并发请求共享同一次刷新。"""
    now = time.time()
    if _ikuai_cache["data"] is not None and now - _ikuai_cache["ts"] < 5:
        return _ikuai_cache["data"]

    with _ikuai_lock:
        # double-check:持锁后再查一次,避免等待线程重复拉取
        now = time.time()
        if _ikuai_cache["data"] is not None and now - _ikuai_cache["ts"] < 5:
            return _ikuai_cache["data"]
        return _get_ikuai_terminals_unlocked()


def _get_ikuai_terminals_unlocked() -> list[dict]:
    now = time.time()
    if _ikuai_session() is None:
        _ikuai_login()
    terms = []
    for attempt in range(2):  # session 过期自动重登一次
        if _ikuai_session() is None:
            break
        try:
            r = _ikuai_session().post(
                f"{IKUAI_URL}/Action/call",
                json={"func_name": "monitor_lanip", "action": "show"}, timeout=10)
            terms = r.json().get("results", {}).get("data", [])
            break
        except Exception:
            _ikuai_login()

    out = []
    for t in terms:
        name = unquote(t.get("comment") or t.get("termname") or t.get("hostname") or "")
        out.append({
            "mac": t.get("mac", ""),
            "ip": t.get("ip_addr", ""),
            "name": name or "未知设备",
            "online": t.get("connect_num", 0) > 0,
            "download": t.get("download", 0) or 0,
            "upload": t.get("upload", 0) or 0,
            "connect_num": t.get("connect_num", 0) or 0,
            "total_down": t.get("total_down", 0) or 0,
            "total_up": t.get("total_up", 0) or 0,
            "uptime": t.get("uptime", ""),
            "last_seen": "",
        })
    _ikuai_cache["ts"] = time.time()
    _ikuai_cache["data"] = out
    return out


_conn_cache: dict[str, tuple[float, dict]] = {}


def get_ikuai_connections(ip: str) -> dict:
    """设备连接详情(爱快 monitor_lanip TYPE=conn),3 秒缓存。"""
    now = time.time()
    if ip in _conn_cache and now - _conn_cache[ip][0] < 3:
        return _conn_cache[ip][1]

    if _ikuai_session() is None:
        _ikuai_login()
    conns = []
    conn_num = 0
    proto_stats = []
    for attempt in range(2):
        if _ikuai_session() is None:
            break
        try:
            r = _ikuai_session().post(
                f"{IKUAI_URL}/Action/call",
                json={"func_name": "monitor_lanip", "action": "show",
                      "param": {"TYPE": "conn,conn_num", "ip": ip,
                                "proto": "all", "interface": "all", "limit": ""}},
                timeout=10)
            res = r.json().get("results", {})
            conns = res.get("conn", [])
            conn_num = res.get("conn_num", 0) or 0
            proto_stats = res.get("protocol_stats", [])
            break
        except Exception:
            _ikuai_login()

    out = {"ip": ip, "conn": conns[:200], "conn_num": conn_num,
           "protocol_stats": proto_stats, "ts": time.strftime("%H:%M:%S")}
    _conn_cache[ip] = (now, out)
    return out


@app.get("/api/network/connections/{ip}")
def network_connections(ip: str):
    return get_ikuai_connections(ip)


_wan_cache = {"ts": 0.0, "data": None}
_wan_lock = threading.Lock()  # single-flight(2026-08-07)


def get_ikuai_wan() -> list[dict]:
    """爱快 WAN 口实时流量(上下行+连接数),5 秒缓存。single-flight。"""
    now = time.time()
    if _wan_cache["data"] is not None and now - _wan_cache["ts"] < 5:
        return _wan_cache["data"]
    with _wan_lock:
        now = time.time()
        if _wan_cache["data"] is not None and now - _wan_cache["ts"] < 5:
            return _wan_cache["data"]
        return _get_ikuai_wan_unlocked()


def _get_ikuai_wan_unlocked() -> list[dict]:
    if _ikuai_session() is None:
        _ikuai_login()
    wans = []
    for attempt in range(2):
        if _ikuai_session() is None:
            break
        try:
            r = _ikuai_session().post(
                f"{IKUAI_URL}/Action/call",
                json={"func_name": "monitor_iface", "action": "show",
                      "param": {"TYPE": "iface_stream"}}, timeout=10)
            stream = r.json().get("results", {}).get("iface_stream", [])
            wans = [{
                "name": t.get("interface", ""),
                "ip": t.get("ip_addr", ""),
                "upload": t.get("upload", 0) or 0,
                "download": t.get("download", 0) or 0,
                "connect_num": t.get("connect_num", 0) or 0,
            } for t in stream
              if (t.get("interface", "").startswith("wan")
                  or t.get("interface", "").startswith("adsl"))
              and t.get("interface") != "wan1"]  # wan1 空口(ip --)不显示
            break
        except Exception:
            _ikuai_login()
    _wan_cache["ts"] = time.time()
    _wan_cache["data"] = wans
    return wans


@app.get("/api/network/wan")
def network_wan():
    return {"wans": get_ikuai_wan(), "ts": time.strftime("%H:%M:%S")}


# ---------- 摄像头实时画面 ----------

@app.get("/api/camera/watch-url")
def camera_watch_url():
    """HomeHub 分发方案:修改版观看页(embedded 无滚动),前端连 HomeHub 分发。"""
    tok = _miloco_token()
    if not tok:
        raise HTTPException(500, detail="miloco token 读取失败")
    return {"url": f"/api/camera/watch?token={tok}&embedded=1"}


@app.get("/api/camera/watch")
def camera_watch():
    """自托管修改版实时观看页(看门狗放宽:老摄像头帧稀疏不误判重连)。"""
    try:
        with open(os.path.join(BASE_DIR, "miloco-watch.html"), encoding="utf-8") as f:
            html = f.read()
    except Exception:
        raise HTTPException(500, detail="miloco-watch.html 缺失")
    return HTMLResponse(html.replace("__MILOCO_TOKEN__", _miloco_token()))


@app.get("/api/camera/devices")
def camera_devices():
    """代理 miloco 感知设备列表(同源避免 CORS 预检)。"""
    try:
        r = requests.get(f"{MILOCO_BASE_URL}/api/perception/devices",
                         headers=_miot_headers(), timeout=8)
        return JSONResponse(status_code=r.status_code, content=r.json())
    except Exception as e:
        raise HTTPException(502, detail=f"miloco devices 代理失败: {e}")


# ---------- 摄像头流转发(1 路拉流,多端广播) ----------

_cam_bridge = {"clients": {}, "task": None, "init": None}
_CAM_QMAX = 16  # 每客户端队列上限,满则丢帧(背压,2026-08-07 审查:慢客户端不阻塞广播)


@app.websocket("/api/camera/ws")
async def camera_ws(websocket: WebSocket):
    """前端连这里;后端维护唯一一路到 miloco 的流,广播给所有客户端。
    每客户端独立 asyncio.Queue + 发送任务——慢客户端队列满丢帧,不阻塞整条流。"""
    await websocket.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=_CAM_QMAX)
    # 新客户端先补发 init 信令(编码信息),否则等不到 miloco 单独补发
    if _cam_bridge["init"]:
        await q.put(_cam_bridge["init"])
    _cam_bridge["clients"][websocket] = q
    if _cam_bridge["task"] is None or _cam_bridge["task"].done():
        _cam_bridge["task"] = asyncio.create_task(_miloco_bridge())

    async def _sender():
        try:
            while True:
                msg = await q.get()
                if isinstance(msg, bytes):
                    await websocket.send_bytes(msg)
                else:
                    await websocket.send_text(msg)
        except Exception:
            pass  # 客户端断开,发送失败即结束

    sender = asyncio.create_task(_sender())
    try:
        while True:
            await websocket.receive_text()  # 前端不发消息;仅等待断开
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        _cam_bridge["clients"].pop(websocket, None)
        if not _cam_bridge["clients"] and _cam_bridge["task"] and not _cam_bridge["task"].done():
            _cam_bridge["task"].cancel()
            _cam_bridge["task"] = None


async def _miloco_bridge():
    """连 miloco WS(摄像头流),把帧/信令入队给所有前端。断线自动重连。
    背压:客户端消费慢时队列满,put_nowait 直接丢帧(不影响其他客户端)。"""
    import websockets
    tok = _miloco_token()
    ws_base = MILOCO_BASE_URL.replace("http://", "ws://").replace("https://", "wss://")
    url = (f"{ws_base}/api/miot/ws/video_stream"
           f"?camera_id={CAMERA_ID}&channel=0&token={tok}")
    while True:
        try:
            async with websockets.connect(url, max_size=2**26) as ws:
                _cam_bridge["init"] = None  # 新会话重新缓存 init
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, str):
                        _cam_bridge["init"] = msg  # 缓存 init 信令
                    dead = []
                    for client, q in list(_cam_bridge["clients"].items()):
                        try:
                            q.put_nowait(msg)  # 队列满丢帧(背压)
                        except Exception:
                            dead.append(client)
                    for c in dead:
                        _cam_bridge["clients"].pop(c, None)
                    if not _cam_bridge["clients"]:
                        return  # 无客户端,退出;由新连接重新拉起
        except asyncio.CancelledError:
            return
        except Exception:
            await asyncio.sleep(3)  # miloco 断线,重连


# ---------- 网络设备 ----------

def _ip_key(ip: str):
    """IP 转数字元组用于排序(字符串排序会把 .100 排在 .18 前面)。"""
    try:
        return tuple(int(x) for x in ip.split("."))
    except Exception:
        return (999, 999, 999, 999)


@app.get("/api/network/devices")
def network_devices():
    """在线设备来自爱快(实时速率+连接数),离线设备用 zr_monitor 兜底折叠。"""
    terms = get_ikuai_terminals()
    online = [t for t in terms if t["online"]]

    offline = []
    if os.path.exists(ZR_DEVICE_INFO):
        with open(ZR_DEVICE_INFO, encoding="utf-8") as f:
            zr = json.load(f)
        online_macs = {t["mac"].lower() for t in terms}
        for mac, info in zr.items():
            if mac.lower() in online_macs:
                continue
            offline.append({
                "mac": mac,
                "ip": info.get("设备当前IP", ""),
                "name": info.get("设备名称", mac),
                "online": False,
                "download": 0, "upload": 0, "connect_num": 0,
                "total_down": 0, "total_up": 0, "uptime": "",
                "last_seen": info.get("最后在线时间", ""),
            })

    devices = online + offline
    # 在线优先,组内按 IP 从小到大
    devices.sort(key=lambda d: (not d["online"], _ip_key(d["ip"])))
    return {
        "devices": devices,
        "total": len(devices),
        "online": len(online),
        "ts": time.strftime("%H:%M:%S"),
    }


# ---------- 天气(室外) ----------

WEATHER_LAT = float(os.environ.get("WEATHER_LAT", "30.722"))   # 用户位置 N30°43'19"
WEATHER_LON = float(os.environ.get("WEATHER_LON", "116.311"))  # E116°18'39"
WEATHER_CITY_ID = os.environ.get("WEATHER_CITY_ID", "101220601")  # 安庆(中国天气网第二源,城市粒度)
QWEATHER_HOST = os.environ.get("QWEATHER_HOST", "")          # 和风私有 Host(控制台凭据详情里)
QWEATHER_KEY = os.environ.get("QWEATHER_KEY", "")            # 和风 API Key
_weather_cache = {"ts": 0.0, "data": None}
_weather_lock = threading.Lock()  # single-flight(2026-08-07)


def _wttr_translate(desc: str) -> str:
    """wttr.in 英文天气描述 → 中文(关键词匹配)。"""
    en = (desc or "").lower()
    if "thund" in en: return "雷阵雨"
    if "snow" in en or "sleet" in en: return "雨夹雪"
    if "freezing" in en or "ice" in en: return "冻雨"
    if "heavy" in en and "rain" in en: return "大雨"
    if "light" in en and "rain" in en: return "小雨"
    if "shower" in en: return "阵雨"
    if "rain" in en: return "雨"
    if "fog" in en or "mist" in en: return "雾"
    if "cloudy" in en and "partly" in en: return "多云"
    if "cloudy" in en or "overcast" in en: return "阴"
    if "sunny" in en or "clear" in en: return "晴"
    return desc or ""


def _wmo_code(code) -> str:
    """Open-Meteo WMO weather_code → 中文。"""
    try: code = int(code)
    except (TypeError, ValueError): return ""
    if code == 0: return "晴"
    if code == 1: return "大致晴朗"
    if code == 2: return "多云"
    if code == 3: return "阴"
    if code in (45, 48): return "雾"
    if code in (51, 53, 55, 56, 57): return "毛毛雨"
    if code in (61, 63, 65, 66, 67): return "雨"
    if code in (71, 73, 75, 77): return "雪"
    if code in (80, 81, 82): return "阵雨"
    if code in (85, 86): return "阵雪"
    if code in (95, 96, 99): return "雷阵雨"
    return ""


def get_weather() -> dict:
    """室外天气(多源聚合):Open-Meteo(坐标,24h 小时唯一源) + 中国天气网(安庆,官方中文)。
    当前温度/湿度、7 天温度取双源平均;天气描述优先中国天气网。30 分钟缓存。
    single-flight:缓存过期时并发请求共享一次刷新。"""
    now = time.time()
    if _weather_cache["data"] is not None and now - _weather_cache["ts"] < 1800:
        return _weather_cache["data"]
    with _weather_lock:
        now = time.time()
        if _weather_cache["data"] is not None and now - _weather_cache["ts"] < 1800:
            return _weather_cache["data"]
        return _get_weather_unlocked()


def _get_weather_unlocked() -> dict:
    # 4 源并行取数(2026-08-07 审查:原串行 6-7 请求最坏 50s,改并发)
    def _fetch_om():
        d = {}
        try:
            r = requests.get("http://api.open-meteo.com/v1/forecast", params={
                "latitude": WEATHER_LAT, "longitude": WEATHER_LON,
                "current": "temperature_2m,relative_humidity_2m,weather_code,apparent_temperature,wind_speed_10m,pressure_msl",
                "hourly": "temperature_2m,weather_code",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum",
                "forecast_days": 7,
                "forecast_hours": 24,
                "timezone": "Asia/Shanghai",
            }, timeout=8)
            dd = r.json()
            cur = dd.get("current", {})
            d["current"] = {
                "temp": round(cur["temperature_2m"]),
                "humidity": round(cur["relative_humidity_2m"]),
                "desc": _wmo_code(cur.get("weather_code")),
                "feels": round(cur.get("apparent_temperature") or cur["temperature_2m"]),
                "wind": round(cur.get("wind_speed_10m") or 0),
                "pressure": round(cur.get("pressure_msl") or 0),
            }
            h = dd.get("hourly", {})
            d["hourly"] = [
                {"hour": int(t[11:13]), "temp": str(round(temp)), "desc": _wmo_code(code)}
                for t, temp, code in zip(h.get("time", []), h.get("temperature_2m", []), h.get("weather_code", []))
            ]
            # 过滤首点(当前整点已过去),不能按 hour 数值过滤(跨天凌晨误杀)
            cur_hour = int(time.strftime("%H"))
            if d["hourly"] and d["hourly"][0]["hour"] <= cur_hour:
                d["hourly"] = d["hourly"][1:]
            dl = dd.get("daily", {})
            d["daily"] = {}
            for i, t in enumerate(dl.get("time", [])):
                date = t.replace("-", "")
                d["daily"][date] = {
                    "max": round(dl["temperature_2m_max"][i]),
                    "min": round(dl["temperature_2m_min"][i]),
                    "desc": _wmo_code(dl["weather_code"][i]),
                    "uv": round(dl.get("uv_index_max", [0] * 7)[i] or 0),
                    "precip": round(dl.get("precipitation_sum", [0] * 7)[i] or 0),
                }
                if i == 0:
                    d["sunrise"] = dl.get("sunrise", [""])[0][11:16] if dl.get("sunrise") else ""
                    d["sunset"] = dl.get("sunset", [""])[0][11:16] if dl.get("sunset") else ""
        except Exception:
            pass
        return d

    def _fetch_cn():
        d = {}
        try:
            r = requests.get(f"http://d1.weather.com.cn/dingzhi/{WEATHER_CITY_ID}.html",
                             headers={"Referer": "http://www.weather.com.cn/"}, timeout=8)
            r.encoding = "utf-8"
            m = re.search(r"weatherinfo\":(\{.*?\})\};?", r.text)
            if m:
                wi = json.loads(m.group(1))
                d["current"] = {
                    "temp": int(str(wi.get("temp", "0")).replace("℃", "") or 0),
                    "desc": wi.get("weather", ""),
                }
        except Exception:
            pass
        try:
            ym = time.strftime("%Y%m")
            r = requests.get(
                f"http://d1.weather.com.cn/calendar_new/{ym[:4]}/{WEATHER_CITY_ID}_{ym}.html",
                headers={"Referer": f"http://www.weather.com.cn/weather/{WEATHER_CITY_ID}.shtml"},
                timeout=8)
            r.encoding = "utf-8"
            m = re.search(r"=\s*(\[.*\])", r.text, re.S)
            if m:
                for day in json.loads(m.group(1)):
                    date = day.get("date", "")
                    if date:
                        d.setdefault("daily", {})[date] = {
                            "max": int(day.get("hmax") or 0),
                            "min": int(day.get("hmin") or 0),
                            "desc": day.get("w1") or day.get("des", ""),
                        }
        except Exception:
            pass
        return d

    def _fetch_wt():
        d = {}
        try:
            r = requests.get(f"https://wttr.in/{WEATHER_LAT},{WEATHER_LON}?format=j1&lang=zh", timeout=8)
            dd = r.json()
            cur = dd.get("current_condition", [{}])[0]
            d["current"] = {
                "temp": int(float(cur.get("temp_C", 0) or 0)),
                "humidity": int(float(cur.get("humidity", 0) or 0)),
                "desc": _wttr_translate((cur.get("lang_zh") or cur.get("weatherDesc") or [{}])[0].get("value", "")),
            }
            for w in dd.get("weather", [])[:3]:
                date = w.get("date", "").replace("-", "")
                d.setdefault("daily", {})[date] = {
                    "max": int(float(w.get("maxtempC", 0) or 0)),
                    "min": int(float(w.get("mintempC", 0) or 0)),
                }
        except Exception:
            pass
        return d

    def _fetch_qw():
        d = {}
        if not (QWEATHER_HOST and QWEATHER_KEY):
            return d
        try:
            base = f"https://{QWEATHER_HOST}"
            params = f"location={WEATHER_LON},{WEATHER_LAT}&key={QWEATHER_KEY}"
            r = requests.get(f"{base}/v7/weather/now?{params}", timeout=8)
            n = r.json().get("now", {})
            if n:
                d["current"] = {
                    "temp": int(float(n.get("temp", 0) or 0)),
                    "humidity": int(float(n.get("humidity", 0) or 0)),
                    "desc": n.get("text", ""),
                }
            r = requests.get(f"{base}/v7/weather/24h?{params}", timeout=8)
            d["hourly"] = [{
                "hour": int(x.get("fxTime", "")[11:13]),
                "temp": str(round(float(x.get("temp", 0) or 0))),
                "desc": x.get("text", ""),
            } for x in r.json().get("hourly", [])]
            r = requests.get(f"{base}/v7/weather/7d?{params}", timeout=8)
            d["daily"] = {
                x.get("fxDate", "").replace("-", ""): {
                    "max": int(float(x.get("tempMax", 0) or 0)),
                    "min": int(float(x.get("tempMin", 0) or 0)),
                    "desc": x.get("textDay", ""),
                }
                for x in r.json().get("daily", [])
            }
        except Exception:
            pass
        return d

    # 4 源并发:最快 ~8s,最坏也是 8s(不再叠加 4x8=32s+)
    om = cn = wt = qw = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_om, f_cn, f_wt, f_qw = ex.submit(_fetch_om), ex.submit(_fetch_cn), ex.submit(_fetch_wt), ex.submit(_fetch_qw)
        try: om = f_om.result()
        except Exception: pass
        try: cn = f_cn.result()
        except Exception: pass
        try: wt = f_wt.result()
        except Exception: pass
        try: qw = f_qw.result()
        except Exception: pass
    # 聚合输出
    out = {"current": {}, "hourly": [], "daily": [], "sources": []}
    srcs = []
    if om.get("current"): srcs.append("open-meteo")
    if cn.get("current"): srcs.append("cn-weather")
    if wt.get("current"): srcs.append("wttr.in")
    if qw.get("current"): srcs.append("qweather")
    out["sources"] = srcs
    # 当前:温度全源平均,湿度 OM+wttr+qw 平均,描述 qw 优先(精确到县)>cn>om>wttr
    temps = [x for x in (om.get("current", {}).get("temp"), cn.get("current", {}).get("temp"),
                         wt.get("current", {}).get("temp"), qw.get("current", {}).get("temp")) if x]
    if temps:
        out["current"]["temp"] = str(round(sum(temps) / len(temps)))
    hums = [x for x in (om.get("current", {}).get("humidity"), wt.get("current", {}).get("humidity"),
                        qw.get("current", {}).get("humidity")) if x is not None]
    if hums:
        out["current"]["humidity"] = str(round(sum(hums) / len(hums)))
    out["current"]["desc"] = (qw.get("current", {}).get("desc")
                              or cn.get("current", {}).get("desc")
                              or om.get("current", {}).get("desc")
                              or wt.get("current", {}).get("desc") or "")
    out["current"]["feels"] = om.get("current", {}).get("feels", "")
    out["current"]["wind"] = om.get("current", {}).get("wind", "")
    out["current"]["pressure"] = om.get("current", {}).get("pressure", "")
    out["sunrise"] = om.get("sunrise", "")
    out["sunset"] = om.get("sunset", "")
    # hourly: OM 为主,与 QWeather 同小时聚合(温度平均,描述 qw 优先),qw 独有小时追加
    qh = {x["hour"]: x for x in qw.get("hourly", [])}
    hours = list(om.get("hourly", []))
    omh = {x["hour"] for x in hours}
    for h, q in qh.items():
        if h not in omh:
            hours.append(q)
    for x in hours:
        q = qh.get(x["hour"])
        if q:
            x = {**x,
                 "temp": str(round((int(x["temp"]) + int(q["temp"])) / 2)),
                 "desc": q["desc"] or x["desc"]}
        out["hourly"].append(x)
    # 7 天:全源逐日平均(前 3 天 OM+CN+wttr+qw,之后 OM+CN+qw),描述 qw 优先
    for date, od in (om.get("daily") or {}).items():
        cd = (cn.get("daily") or {}).get(date, {})
        wd = (wt.get("daily") or {}).get(date, {})
        qd = (qw.get("daily") or {}).get(date, {})
        mx = [x for x in (od.get("max"), cd.get("max"), wd.get("max"), qd.get("max")) if x]
        mn = [x for x in (od.get("min"), cd.get("min"), wd.get("min"), qd.get("min")) if x]
        out["daily"].append({
            "date": date,
            "max": str(round(sum(mx) / len(mx))) if mx else "",
            "min": str(round(sum(mn) / len(mn))) if mn else "",
            "desc": qd.get("desc") or cd.get("desc") or od.get("desc", ""),
            "uv": od.get("uv", ""),
            "precip": od.get("precip", ""),
        })
    # CN 有而 OM 缺的日期也补上(仅当 OM 失败时)
    if not out["daily"]:
        for date, cd in (cn.get("daily") or {}).items():
            if date >= time.strftime("%Y%m%d"):
                out["daily"].append({
                    "date": date, "max": str(cd.get("max", "")), "min": str(cd.get("min", "")),
                    "desc": cd.get("desc", ""),
                })
                if len(out["daily"]) >= 7:
                    break
    out["ts"] = time.strftime("%m-%d %H:%M")
    _weather_cache["ts"] = time.time()
    _weather_cache["data"] = out
    return out


@app.get("/api/weather")
def weather():
    return get_weather()


# ---------- 布局(卡片排布,后端存储 → 各设备访问一致) ----------

LAYOUT_FILE = os.environ.get("LAYOUT_FILE", "/data/layout.json")


@app.get("/api/layout/order")
def layout_order():
    """返回卡片排布(通用卡列表 + 隐藏设备)。兼容旧格式 {"order": [did...]}。"""
    try:
        with open(LAYOUT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"list": [], "hidden": []}


class OrderRequest(BaseModel):
    card_list: list | None = Field(default=None, alias="list")  # 字段名不能叫 list(遮蔽内置类型)
    hidden: list | None = None
    order: list | None = None  # 兼容旧格式


@app.post("/api/layout/order")
def layout_order_save(req: OrderRequest):
    try:
        os.makedirs(os.path.dirname(LAYOUT_FILE), exist_ok=True)
        data = {}
        if req.card_list is not None:
            data["list"] = req.card_list
        if req.hidden is not None:
            data["hidden"] = req.hidden
        if req.order is not None and "list" not in data:
            data["order"] = req.order  # 旧格式原样存
        with open(LAYOUT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


# 信息卡配置(网格底部显示哪些卡,所有设备一致)

CARDS_FILE = os.environ.get("CARDS_FILE", "/data/cards.json")
DEFAULT_CARDS = {"info": True, "minis": ["fest", "moon", "air", "uv", "press", "weekend", "devices", "offline", "tempdiff", "today", "sunset", "pm25"]}


@app.get("/api/layout/cards")
def layout_cards():
    try:
        with open(CARDS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"cards": DEFAULT_CARDS}


class CardsRequest(BaseModel):
    cards: dict


@app.post("/api/layout/cards")
def layout_cards_save(req: CardsRequest):
    try:
        os.makedirs(os.path.dirname(CARDS_FILE), exist_ok=True)
        with open(CARDS_FILE, "w", encoding="utf-8") as f:
            json.dump({"cards": req.cards}, f, ensure_ascii=False)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, detail=str(e))


@app.get("/")
def index():
    resp = FileResponse(os.path.join(BASE_DIR, "index.html"))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


@app.get("/static/js/{name}")
def static_js(name: str):
    """拆模块后的 JS 文件(2026-08-07):/static/js/*.js → /docker/homehub/static/js/"""
    from fastapi import HTTPException as _HE
    from pathlib import Path as _P
    fpath = _P(BASE_DIR) / "static" / "js" / name
    if not fpath.is_file() or fpath.suffix != ".js":
        raise _HE(404)
    resp = FileResponse(fpath)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8123)
