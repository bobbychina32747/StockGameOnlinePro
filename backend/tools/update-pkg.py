# -*- coding: utf-8 -*-
"""更新 package.json：加 build 脚本"""
import io
import json

p = 'package.json'
s = io.open(p, encoding='utf-8').read()
d = json.loads(s)
d['scripts']['build'] = 'rm -rf dist && tsc -p tsconfig.json'
io.open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(d, ensure_ascii=False, indent=2))
print('scripts:', json.dumps(d['scripts'], ensure_ascii=False))
