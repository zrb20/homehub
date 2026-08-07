#!/bin/bash
# HomeHub 容器入口:并行启动 miloco + homehub,任一退出则整体退出(容器重启)
set -e

# 启动 miloco 后端(容器内 127.0.0.1:1810)
MILOCO_HOME=/miloco-data /usr/local/bin/python -m miloco.main &
MILOCO_PID=$!
echo "[entry] miloco started pid=$MILOCO_PID"

# 启动 HomeHub(8123)
cd /app
/usr/local/bin/python -m uvicorn app:app --host 0.0.0.0 --port 8123 &
HUB_PID=$!
echo "[entry] homehub started pid=$HUB_PID"

# 轮询:任一进程退出就整体退出(bash wait -n 也可,但保持兼容)
while kill -0 $MILOCO_PID 2>/dev/null && kill -0 $HUB_PID 2>/dev/null; do
  sleep 2
done

echo "[entry] one process exited, stopping all"
kill $MILOCO_PID $HUB_PID 2>/dev/null || true
wait 2>/dev/null || true
exit 0
