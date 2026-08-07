FROM docker.m.daocloud.io/library/python:3.11-slim

WORKDIR /app

# 时区
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# miloco 运行环境(小米私有包,无法 pip 安装,直接铺 site-packages)
COPY site-packages/ /usr/local/lib/python3.11/site-packages/

# HomeHub 依赖(requests 是 homehub app.py 用,miloco 环境没有;阿里云 pip 源快)
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple requests

# HomeHub 代码
COPY app.py index.html miloco-watch.html hls.min.js /app/
COPY static/ /app/static/

# miloco 数据(默认打包一份;运行时挂载卷覆盖)
COPY miloco-data/ /miloco-data/

# 入口脚本(并行启动 miloco + homehub)
COPY entry.sh /usr/local/bin/homehub-entry
RUN chmod +x /usr/local/bin/homehub-entry

EXPOSE 8123
CMD ["/usr/local/bin/homehub-entry"]
