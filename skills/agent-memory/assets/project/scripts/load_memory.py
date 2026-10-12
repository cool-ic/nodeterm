#!/usr/bin/env python3
"""Inject the charter, a memory map and an event-specific recovery reminder."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from check_memory import DEFAULT_REGISTRY, check


START_SOURCES = {"startup", "resume", "compact", "clear", "new"}


def memory_map(registry, root):
    data = json.loads(Path(registry).read_text(encoding="utf-8"))
    children, purposes = {}, {}
    for document in data["documents"]:
        name = document["path"]
        purpose = document.get("purpose", "用途未登记，请按任务核对")
        if not isinstance(purpose, str):
            raise ValueError("purpose 必须是字符串：" + name)
        purposes[name] = " ".join(purpose.split())
        children.setdefault(document["parent"], []).append(name)
    lines = ["登记入口：memory.json。下列为当前已登记文档的路径、用途及父子关系："]
    pending = [(root, 0)]
    while pending:
        name, depth = pending.pop()
        lines.append("{}- {} — {}{}".format("  " * depth, name, purposes[name],
                                            "（纲领正文已注入）" if name == root else "（按需读取）"))
        pending.extend((child, depth + 1) for child in reversed(children.get(name, [])))
    lines.append("地图只反映已登记的 memory，不代表未保存的工作状态已被恢复。")
    return "\n".join(lines)


def reminder(source):
    notices = {
        "compact": "你刚经历了一次 compact（上下文压缩），压缩摘要可能遗漏此前的决定、边界或工作状态。",
        "resume": "你正在恢复已有会话，可能缺少先前的上下文细节。",
        "clear": "会话上下文刚被清空，需要重新确认当前目标与必要记忆。",
        "startup": "这是会话启动时的恢复材料，请先建立当前工作的必要认识。",
        "new": "这是新会话的恢复材料，请先建立当前工作的必要认识。",
    }
    if source not in notices:
        raise ValueError("未知的恢复事件：" + str(source))
    return (notices[source] + "\n继续工作前，核对当前目标与最新用户要求，按下方 memory 地图主动回顾相关文档。"
            "只读取当前任务需要的节点；纲领已注入，无需重复读取或通读整库。"
            "如果所需事实已遗忘且没有记录，明确说明缺口，不编造进度、不把旧计划当作新授权。")


def render(registry=DEFAULT_REGISTRY, source="compact"):
    registry = Path(registry).absolute()
    if registry.is_symlink():
        raise ValueError("memory.json 不能是符号链接")
    name, _ = check(registry, require_registered=False)
    charter = registry.parent / name
    if charter.is_symlink():
        raise ValueError("恢复来源不能是符号链接：" + name)
    with charter.open(encoding="utf-8") as f:
        content = f.read()
    if not content.strip():
        raise ValueError("恢复来源为空：" + name)
    body = ("## 恢复与遗忘提醒\n{}\n\n## Memory 地图\n{}\n\n"
            "## 纲领信息（来源：{}，当前完整正文）\n"
            "方法论、例子与实际实现状态须区分；新的用户指令优先。\n\n{}"
            ).format(reminder(source), memory_map(registry, name), name, content)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    result = "[PROJECT_MEMORY_V1 sha256:{}]\n{}\n[/PROJECT_MEMORY_V1]".format(digest, body)
    return result


def handle_hook(payload, registry=DEFAULT_REGISTRY):
    if not isinstance(payload, dict):
        raise ValueError("hook 输入必须是 JSON 对象")
    if payload.get("hook_event_name") != "SessionStart":
        return None
    if payload.get("source", "startup") not in START_SOURCES:
        return None
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    if Path(cwd).resolve() != Path(registry).absolute().parent.resolve():
        return None
    try:
        content = render(registry, source=payload.get("source", "startup"))
    except (OSError, ValueError, RuntimeError) as exc:
        warning = "[memory:恢复失败] {}。本次未加载恢复正文；请修复来源，备用入口见 AGENTS.md。".format(str(exc)[:1000])
        return {"systemMessage": warning, "hookSpecificOutput": {
            "hookEventName": "SessionStart", "additionalContext": warning}}
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": content}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registry", nargs="?", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--hook", action="store_true")
    parser.add_argument("--source", choices=sorted(START_SOURCES), default="compact", help="Recovery event for manual preview")
    args = parser.parse_args()
    try:
        if args.hook:
            raw = sys.stdin.buffer.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("hook 输入超出容量")
            result = handle_hook(json.loads(raw), args.registry)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False))
        else:
            print(render(args.registry, source=args.source))
    except (OSError, ValueError, RuntimeError) as exc:
        print("memory 恢复失败：{}".format(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
