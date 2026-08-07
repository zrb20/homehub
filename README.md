# HomeHub 家庭监控屏

家庭设备监控面板（1920×1080 全屏监控屏），单页面展示：

- **米家设备**：空调 / 净化器 / 热水器 / 加湿器 / 传感器 / 摄像机等，卡片化控制（模式切换、温度调节、风速滑条、开关）
- **网络设备**：爱快（iKuai）在线终端实时速率 + 连接数，离线设备用 zr_monitor 静态副本兜底
- **室外天气**：Open-Meteo + 中国天气网 + wttr.in + 和风天气 **4 源聚合**（30 分钟缓存）
- **摄像头实时画面**：WebCodecs 硬件解码（VA-API），HomeHub WS 分发（1 路拉流、多端广播）

## 架构

```
[米家设备]───┐
             ├─→ miloco 后端(设备/控制/摄像头流) ─→ HomeHub FastAPI(8123) ─→ 监控屏页面
[爱快路由]───┘         ↑                                    │
                  HomeHub 容器内嵌(127.0.0.1:1810)           └─→ WS 广播摄像头流
```

- **后端**：FastAPI + uvicorn（`app.py`，单文件 ~900 行）
- **前端**：单页 `index.html` + `static/js/`（拆模块 7 个文件，零依赖原生 JS）
- **摄像头页**：`miloco-watch.html`（WebCodecs 硬解 + MSE 软解兜底）
- **miloco**：小米私有中间件，负责米家设备 HTTP API 和摄像头 P2P 拉流。HomeHub v2 起**内嵌在容器里**，容器完全自给自足

## 目录结构

```
homehub/
├── app.py              # FastAPI 后端(米家/网络/天气/摄像头/布局)
├── index.html          # 监控屏主页面(CSS + body)
├── miloco-watch.html   # 摄像头播放页(iframe 内嵌)
├── hls.min.js          # MSE 软解兜底库
├── Dockerfile          # v2 容器化构建(内嵌 miloco)
├── entry.sh            # 容器入口(并行启动 miloco + homehub)
├── supervisord.conf    # 双进程托管配置(备选入口)
├── fix-apt-sources.py  # 构建时换国内 apt 源脚本
└── static/js/          # 前端拆模块 JS
    ├── core.js         # api/枚举翻译/propVal/specOf/esc
    ├── controls.js     # sendControl/控件渲染/乐观更新
    ├── layout.js       # 卡片排序/拖拽/管理
    ├── cards.js        # 卡片渲染(空调/设备/网络等)
    ├── render.js       # renderMijia/数据加载/农历/天气/网络
    ├── camera.js       # 摄像头 iframe 常驻逻辑
    └── main.js         # tick/init 启动
```

## 依赖说明

| 依赖 | 用途 | 获取方式 |
|---|---|---|
| Python ≥ 3.11 | 后端运行 | 系统包 |
| fastapi / uvicorn / requests / websockets / pydantic | 后端库 | `pip install` |
| **miloco**（小米私有包） | 米家设备 + 摄像头 | 无法从 PyPI 安装，见下方说明 |
| 爱快路由器 | 网络设备数据源 | 内网设备（默认 `http://192.168.203.1`） |
| 和风天气 Key | 天气第 4 源（可选） | QWeather 控制台 |

### miloco 说明

miloco 是小米出品的家庭智能中间件，**不在公开 PyPI 上**。HomeHub v2 的 Dockerfile 通过 `COPY site-packages/` 把 miloco 运行环境直接铺进镜像（从已安装 miloco 的机器导出，约 627MB）。如果你从零构建，需要先在一台装有 miloco 的机器上导出：

```bash
# 在已安装 miloco 的机器上(uv tool 安装路径示例)
mkdir -p site-packages
cd /path/to/miloco/venv/lib/python3.11/site-packages
tar cf - --exclude='__pycache__' --exclude='*.pyc' . | (cd /path/to/project/site-packages && tar xf -)
```

miloco 还需要数据目录（`miloco-data/`：`config.json` + `miloco.db` + `miot_cache`），其中 `miloco.db` 存小米账号 OAuth token——**从运行中的 miloco 实例复制**，或参考 [miloco 官方文档](https://github.com/XiaoMi/miloco) 初始化。

---

## 部署方式一：Docker（推荐，完全独立）

### 前提

- 已导出 `site-packages/`（miloco 运行环境）和 `miloco-data/`（miloco 数据）
- 内网可达爱快路由器和米家设备

### 1. 准备构建上下文

```bash
# 项目根目录下
mkdir -p site-packages miloco-data
# 把 miloco 运行环境铺进 site-packages/(见上方"miloco 说明")
# 把 miloco 数据(config.json + miloco.db + miot_cache)放进 miloco-data/
```

### 2. 构建镜像

```bash
docker build -t homehub .
```

### 3. 启动容器

```bash
docker run -d --name homehub --restart unless-stopped \
  --network host \
  -e TZ=Asia/Shanghai \
  -e MILOCO_BASE_URL=http://127.0.0.1:1810 \
  -e MILOCO_TOKEN=<miloco服务token> \
  -e ZR_DEVICE_INFO=/data/device_info.json \
  -e QWEATHER_HOST=<和风私有Host> \
  -e QWEATHER_KEY=<和风Key> \
  -e IKUAI_URL=http://192.168.203.1 \
  -e IKUAI_USER=admin \
  -e IKUAI_PASS=<爱快密码> \
  -v /path/to/data:/data \
  -v /path/to/miloco-data:/miloco-data \
  homehub
```

> **⚠️ 必须 `--network host`**：docker bridge 网络下 miloco 无法与摄像头完成 PPCS 握手（`lan_reachable: false`），host 网络才能直连局域网设备。

### 4. 访问

```
http://<宿主机IP>:8123
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | — | 时区，必须 `Asia/Shanghai`（容器默认 UTC 会差 8h） |
| `MILOCO_BASE_URL` | `http://127.0.0.1:1810` | miloco 地址（容器内嵌时用默认值） |
| `MILOCO_TOKEN` | — | miloco 服务 token（`miloco-data/config.json` 的 `server.token`） |
| `ZR_DEVICE_INFO` | — | 离线网络设备静态副本路径 |
| `QWEATHER_HOST` / `QWEATHER_KEY` | — | 和风天气私有 Host / Key（可选，第 4 源） |
| `IKUAI_URL` / `IKUAI_USER` / `IKUAI_PASS` | `http://192.168.203.1` / `admin` / — | 爱快登录凭据 |
| `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_CITY_ID` | `30.722` / `116.311` / `101220601` | 天气坐标与城市 |

### 数据卷

| 挂载 | 内容 |
|---|---|
| `.../data` | 布局配置（`layout.json` / `cards.json` / `device_info.json`） |
| `.../miloco-data` | miloco 数据（config + db + miot_cache） |

---

## 部署方式二：无 Docker（直接跑）

不装 Docker、直接把后端跑在宿主机上。需要自己另起一个 miloco 后端（HomeHub 通过 HTTP 连它）。

### 1. 安装依赖

```bash
# Debian/Ubuntu
sudo apt install python3 python3-pip
pip install fastapi uvicorn requests websockets pydantic
```

### 2. 准备 miloco 后端

HomeHub 依赖 miloco 的 HTTP API（`/api/miot/*`）。单独部署 miloco（参考官方文档或你的现有安装）：

```bash
# 示例:miloco 后端跑在 127.0.0.1:1810
export MILOCO_HOME=/path/to/miloco-data
python -m miloco.main
```

### 3. 启动 HomeHub

```bash
cd homehub
export MILOCO_BASE_URL=http://127.0.0.1:1810   # miloco 地址(可跨机)
export MILOCO_TOKEN=<miloco服务token>
export TZ=Asia/Shanghai
export ZR_DEVICE_INFO=/path/to/device_info.json  # 可选
export QWEATHER_HOST=<host>  # 可选
export QWEATHER_KEY=<key>    # 可选
export IKUAI_URL=http://192.168.203.1  # 可选,默认值即可
export IKUAI_PASS=<爱快密码>

python -m uvicorn app:app --host 0.0.0.0 --port 8123
```

### 4. 访问

```
http://<主机IP>:8123
```

### 无 Docker 与 Docker 的区别

| | Docker (v2) | 无 Docker |
|---|---|---|
| miloco | 容器内嵌（127.0.0.1:1810） | 单独进程（可跨机） |
| 摄像头 | host 网络直连局域网 | 取决于 miloco 所在机网络 |
| 静态文件 | 镜像内 `/app/static/` | 项目目录 `static/` |
| 数据卷 | `.../data` + `.../miloco-data` | 环境变量指定 |

---

## 功能清单

### 设备卡片
- 空调：模式（制冷/除湿/送风/制热）、温度 ±0.5° 步进、风速滑条（0-8 档）、新风开关+风速（0-5 档）、扫风/节能
- 净化器/热水器：电源开关、模式、功率/电压
- 加湿器：目标湿度、模式
- 传感器：温湿度、AQI、CO₂ 大数字
- 摄像机：实时画面（硬解）、夜视/录制/移动侦测控制

### 监控屏布局
- 1920×1080 全屏无滚动，9×6 网格
- 24h 温度折线图（SVG，每点标注温度）+ 7 天预报
- 信息大卡：日期/时钟/农历/天气/日出日落
- 12 种 mini 卡：节日倒计时/月相/气压/紫外线/周末等
- 卡片可拖拽排序、隐藏，排布存后端（所有设备一致）

### 技术特性
- **局部刷新**：数据更新逐卡局部替换，不重建整个网格（时钟/摄像头不闪）
- **乐观更新**：控制点击立即反馈，0.8s 未确认回退真实值
- **卡片解耦**：单卡渲染异常只丢自己，不拖垮整个面板
- **摄像头自动重连**：WS 断开指数退避重连
- **后端 single-flight**：缓存过期时并发请求共享一次刷新
- **天气 4 源并行**：取数并发，单源失败自动降级

## 常见问题

**Q: 摄像头画面不出来？**
- 检查容器是否 `--network host`（bridge 网络无法 PPCS 握手）
- 检查 miloco 数据卷里摄像头是否在 scope（`GET /api/miot/scope/cameras`，需 `lan_reachable: true`）
- 老摄像头帧批间隔 45-60s，首次出画面等一会

**Q: 时钟差 8 小时？**
- 容器必须 `-e TZ=Asia/Shanghai`；前端时钟也强制 `Asia/Shanghai` 时区，双保险

**Q: 天气显示不全？**
- 4 源各自独立 try/catch，任何源失败自动降级；和风源需配置 `QWEATHER_HOST/KEY`

**Q: 监控屏 Chrome 不自动刷新？**
- 容器重建后浏览器页面不会自动 reload，需要手动刷新（摄像头 WS 会自动重连画面）

## 安全说明

- 内网家庭项目，`MILOCO_TOKEN` / 爱快密码等凭据通过环境变量注入，**不要硬编码进代码**
- miloco 数据卷含小米账号 OAuth token，注意访问权限
- 前端所有外部数据（设备名/网络设备名/连接详情）已过 `esc()` 转义防 XSS

## 许可证

内部项目，私有使用。
