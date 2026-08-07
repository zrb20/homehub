#!/usr/bin/env python3
"""改 apt 源为阿里云镜像(deb822 格式;清华 403,阿里云通)"""
import pathlib

p = pathlib.Path('/etc/apt/sources.list.d/debian.sources')
if p.exists():
    s = p.read_text()
    s = s.replace('deb.debian.org', 'mirrors.aliyun.com')
    p.write_text(s)
print('apt sources -> aliyun')
