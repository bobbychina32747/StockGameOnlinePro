#!/usr/bin/env python3
"""
Tree Structure Generator (Multi‑root aware, 交互式版)

用法：
    直接运行脚本，按提示输入结构文件路径和目标生成目录即可。
    所有 tree 结构中的注释（# // -- ;）都会被自动忽略。
"""

import os
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

# ---------- 核心解析逻辑 ----------
LINE_PATTERN = re.compile(
    r'^((?:│   |    )*)'          # 缩进
    r'(?:├── |└── )?'            # 条目符号
    r'(.+)$'                     # 路径（可能带注释）
)

COMMENT_PATTERNS = [
    re.compile(r'\s*#.*$'),
    re.compile(r'\s*//.*$'),
    re.compile(r'\s*--.*$'),
    re.compile(r'\s*;.*$'),
]

def clean_comment(raw_path: str) -> str:
    path = raw_path
    for pat in COMMENT_PATTERNS:
        path = pat.sub('', path)
    return path.strip()

def parse_line(line: str) -> Optional[Tuple[int, str, bool]]:
    line = line.rstrip('\n')
    if re.fullmatch(r'[│\s]*', line):
        return None
    match = LINE_PATTERN.match(line)
    if not match:
        return None
    indent_part = match.group(1)
    raw_name = match.group(2)
    depth = len(indent_part) // 4
    name = clean_comment(raw_name)
    if not name:
        return None
    is_dir = name.endswith('/')
    if is_dir:
        name = name.rstrip('/')
    return depth, name, is_dir

def generate_from_text(text: str, base_dir: str) -> None:
    lines = text.splitlines()
    base_path = Path(base_dir).resolve()
    stack: List[Path] = []

    for line in lines:
        parsed = parse_line(line)
        if parsed is None:
            continue
        depth, name, is_dir = parsed
        if depth == 0:
            current = base_path / name
            if is_dir:
                os.makedirs(current, exist_ok=True)
                print(f"[ROOT DIR]  {current}")
                stack = [current]
            else:
                os.makedirs(current.parent, exist_ok=True)
                current.touch(exist_ok=True)
                print(f"[ROOT FILE] {current}")
            continue

        while len(stack) > depth:
            stack.pop()
        if len(stack) < depth:
            print(f"错误：找不到深度 {depth-1} 的父目录，跳过 {name}")
            continue
        parent = stack[-1]
        full_path = parent / name
        if is_dir:
            os.makedirs(full_path, exist_ok=True)
            print(f"[DIR]  {full_path}")
            stack.append(full_path)
        else:
            os.makedirs(full_path.parent, exist_ok=True)
            full_path.touch(exist_ok=True)
            print(f"[FILE] {full_path}")

# ---------- 交互式主程序 ----------
def main():
    print("=" * 50)
    print("🌲 Tree Structure Generator")
    print("=" * 50)

    # 1. 结构文件路径
    while True:
        struct_path = input("[生成器] 请输入结构文件路径: ").strip().strip('"')
        if not struct_path:
            print("[生成器] 路径不能为空，请重新输入。")
            continue
        if not os.path.isfile(struct_path):
            print(f"[生成器] 文件不存在: {struct_path}")
            continue
        break

    # 2. 目标生成路径
    while True:
        target_dir = input("[生成器] 请输入目标生成路径: ").strip().strip('"')
        if not target_dir:
            print("[生成器] 路径不能为空，请重新输入。")
            continue
        # 目标目录可以不存在，我们会自动创建
        break

    # 3. 读取结构文件
    try:
        with open(struct_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"[生成器] 读取文件失败: {e}")
        sys.exit(1)

    print("[生成器] 正在生成...")
    generate_from_text(content, target_dir)
    print("\n✅ 结构生成完毕。")

if __name__ == '__main__':
    main()