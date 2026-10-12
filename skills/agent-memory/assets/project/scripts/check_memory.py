#!/usr/bin/env python3
"""Check the memory tree and capacity budgets; report, never modify."""
import argparse
import json
import re
from pathlib import Path, PurePosixPath
import sys
import sqlite3
from urllib.parse import unquote, urlsplit


DEFAULT_REGISTRY = Path(__file__).resolve().parents[1] / "memory.json"
HOOK_EVENTS = {"SessionStart", "PostToolUse"}


def scan_documents(base, data):
    scan = data.get("scan")
    if not isinstance(scan, dict):
        raise ValueError("必须通过 scan 明确文档扫描范围")
    include, exclude = scan.get("include"), scan.get("exclude")
    if not isinstance(include, list) or not include:
        raise ValueError("scan.include 必须是非空数组")
    if not isinstance(exclude, list):
        raise ValueError("scan.exclude 必须是路径数组")
    for path in include + exclude:
        if not isinstance(path, str) or not path:
            raise ValueError("扫描范围必须是非空路径字符串")
        relative = PurePosixPath(path)
        if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != path:
            raise ValueError("扫描范围必须位于项目内：" + path)
    discovered = set()
    for pattern in include:
        for path in base.glob(pattern):
            name = path.relative_to(base).as_posix()
            if name not in exclude and (path.is_file() or path.is_symlink()):
                discovered.add(name)
    return discovered


def check(registry, *, require_registered=True):
    registry = Path(registry).resolve()
    base = registry.parent
    data = json.loads(registry.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("清单必须是 JSON 对象")
    discovered = scan_documents(base, data)
    documents = data.get("documents")
    if not isinstance(documents, list) or not documents:
        raise ValueError("documents 必须是非空数组")

    parents = {}
    for document in documents:
        if not isinstance(document, dict) or not {"path", "parent"} <= document.keys():
            raise ValueError("每个节点必须包含 path 和 parent")
        path = document["path"]
        if not isinstance(path, str) or not path:
            raise ValueError("path 必须是非空字符串")
        relative = PurePosixPath(path)
        if (relative.is_absolute() or ".." in relative.parts
                or relative.as_posix() != path or path == "."):
            raise ValueError("path 必须是规范的项目内相对路径：" + path)
        if path in parents:
            raise ValueError("重复登记：" + path)
        parent = document["parent"]
        if parent is not None and (not isinstance(parent, str) or not parent):
            raise ValueError("parent 必须是节点路径或 null：" + path)
        target = (base / path).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            raise ValueError("文件指向项目之外：" + path)
        if not target.is_file():
            raise ValueError("登记的文件不存在或不是文件：" + path)
        parents[path] = parent

    roots = [path for path, parent in parents.items() if parent is None]
    if len(roots) != 1:
        raise ValueError("必须恰有一个根节点，实际为 {} 个".format(len(roots)))
    for path, parent in parents.items():
        if parent is not None and parent not in parents:
            raise ValueError("父节点未登记：{} → {}".format(path, parent))
    for path in parents:
        seen = set()
        current = path
        while current is not None:
            if current in seen:
                raise ValueError("父节点关系存在循环：" + current)
            seen.add(current)
            current = parents[current]
    unregistered = sorted(discovered - parents.keys())
    if unregistered and require_registered:
        names = ", ".join(repr(name) for name in unregistered[:20])
        raise ValueError("发现 {} 份未登记的流浪文档：{}".format(len(unregistered), names))
    return roots[0], len(parents)


def unregistered_documents(registry):
    registry = Path(registry).resolve()
    data = json.loads(registry.read_text(encoding="utf-8"))
    return sorted(scan_documents(registry.parent, data) - {doc["path"] for doc in data["documents"]})


def inline_link_targets(text):
    """Read inline Markdown destinations, not code examples or reference links.

    This is deliberately not a full Markdown renderer. Support angle-wrapped
    paths, escaped punctuation, balanced parentheses and optional link titles.
    """
    lines, fence = [], None
    for line in text.splitlines(keepends=True):
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\r\n"))
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
            lines.append("\n")
        elif match:
            fence = match[1]
            lines.append("\n")
        elif line.startswith(("    ", "\t")):
            lines.append("\n")  # Indented code is outside the supported scope.
        else:
            lines.append(line)
    text = re.sub(r"<!--.*?-->", "", "".join(lines), flags=re.S)
    text = re.sub(r"(`+)(?!`)(.*?)\1(?!`)", "", text, flags=re.S)
    for match in re.finditer(r"(?<![!\\])\[(?:\\.|[^\]\\\n])*\]\(\s*", text):
        i, start = match.end(), match.end()
        if i < len(text) and text[i] == "<":
            end = text.find(">", i + 1)
            if end == -1:
                continue
            target, i = text[i + 1:end], end + 1
        else:
            depth = 0
            while i < len(text):
                char = text[i]
                if char == "\\" and i + 1 < len(text):
                    i += 2
                    continue
                if char.isspace() or (char == ")" and depth == 0):
                    break
                depth += (char == "(") - (char == ")")
                i += 1
            target = text[start:i]
        # Require a closing delimiter, optionally preceded by a Markdown title.
        if re.match(r'''\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))\s*)?\)''', text[i:]):
            yield re.sub(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])", r"\1", target)


def broken_local_links(registry):
    """Check existence only, from registered Markdown sources; never follow links."""
    registry = Path(registry).resolve()
    data = json.loads(registry.read_text(encoding="utf-8"))
    findings = set()
    for doc in data["documents"]:
        source = registry.parent / doc["path"]
        if source.suffix.lower() != ".md":
            continue
        for target in inline_link_targets(source.read_text(encoding="utf-8")):
            if not target or target.startswith(("#", "//")):
                continue
            if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
                continue  # No network, mailto, file:// or other URI checks.
            path = unquote(urlsplit(target).path)
            if path and not (source.parent / path).exists():
                findings.add("{} → {}".format(doc["path"], target))
    return sorted(findings)


def capacity_warnings(registry):
    """Called after tree validation. Budgets are advisory, not load gates."""
    registry = Path(registry).resolve()
    data = json.loads(registry.read_text(encoding="utf-8"))
    warnings = []
    for document in data["documents"]:
        name = document["path"]
        limit = document.get("max_chars")
        if type(limit) is not int or limit <= 0:
            raise ValueError("max_chars 必须是正整数：" + name)
        with (registry.parent / name).open(encoding="utf-8") as f:
            size = sum(len(chunk) for chunk in iter(lambda: f.read(8192), ""))
        if size > limit:
            warnings.append("{}：{} 字符，预算 {}".format(name, size, limit))
    total_limit = data.get("max_loaded_chars")
    if type(total_limit) is not int or total_limit <= 0:
        raise ValueError("max_loaded_chars 必须是正整数")
    # Use the real formatter, including its envelope. render() validates only
    # structure and never calls this capacity checker, so there is no recursion.
    from load_memory import render
    loaded_size = len(render(registry))
    if loaded_size > total_limit:
        warnings.append("单次恢复输出：{} 字符，预算 {}".format(loaded_size, total_limit))
    return warnings


def check_hook(payload, registry=DEFAULT_REGISTRY):
    if not isinstance(payload, dict):
        raise ValueError("hook 输入必须是 JSON 对象")
    event = payload.get("hook_event_name")
    if event not in HOOK_EVENTS:
        return None
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    # Only this project's session, not inherited hooks in child projects.
    if Path(cwd).resolve() != Path(registry).resolve().parent:
        return None
    try:
        check(registry, require_registered=False)
    except (OSError, ValueError, RuntimeError) as exc:
        message = ("[memory:结构异常] 检查未通过：{}。"
                   "请核对 memory.json 与相关文档，向用户说明后处理；"
                   "新文档登记仍需用户批准，不要为消除报警擅自登记或删除。"
                   "本检查仅报警，文件操作未被撤销。".format(exc))
        return {"systemMessage": message, "hookSpecificOutput": {
            "hookEventName": event, "additionalContext": message}}
    messages = []
    paths = unregistered_documents(registry)
    from maintain_memory import orphan_reminder_due
    try:
        due = orphan_reminder_due(payload, registry, paths)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        due = bool(paths)
        messages.append("[memory:提醒状态异常] {}；本次按实际检测结果提醒。".format(exc))
    if due:
        names = ", ".join(repr(name) for name in paths[:20])
        messages.append(
            "[memory:文档归位提醒] 当前范围内有 {} 份文档未登记：{}。"
            "请结合本次任务反省其用途：临时产物是否需要留在这里；重复内容能否合并到已有文档；"
            "确有独立长期价值的 memory，是否需要说明用途、父节点和预算并按约定审批登记。"
            "未登记不等于垃圾，不要为消除提醒自动删除或机械加入白名单；"
            "归属和用途不明时先确认。程序仅提醒，不阻止工作或加载。".format(len(paths), names))
    try:
        links = broken_local_links(registry)
        if orphan_reminder_due(payload, registry, links, category="links"):
            messages.append("[memory:断链提醒] {} 处本地链接目标不存在：{}。"
                            "请核对目标是否移动、删除或写错，修正引用；不要为消除报警创建空文件。"
                            "仅提醒，不阻止操作或恢复加载。".format(len(links), "；".join(links[:20])))
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        messages.append("[memory:断链检查异常] {}；请核对检查器，本次不能视为检查通过。".format(exc))
    try:
        warnings = capacity_warnings(registry)
    except (OSError, ValueError, RuntimeError) as exc:
        warnings = ["容量检查未完成：{}".format(exc)]
    if warnings:
        message = ("[memory:防止膨胀] {}。请精简相关 memory，保留必要信息；"
                   "不要为消除报警擅自提高预算。允许暂时超限，本检查仅报警，"
                   "不阻止写入或加载，也不截断、删除正文。".format("；".join(warnings[:20])))
        messages.append(message)
    if messages:
        message = "\n\n".join(messages)
        return {"systemMessage": message, "hookSpecificOutput": {
            "hookEventName": event, "additionalContext": message}}
    return None


def handle_hook(payload, registry=DEFAULT_REGISTRY):
    result = check_hook(payload, registry)
    # A malformed registry cannot supply maintenance guidance. Unregistered
    # files and capacity warnings remain advisory and never stop maintenance.
    if result and "[memory:结构异常]" in result.get("systemMessage", ""):
        return result
    from maintain_memory import maybe_remind
    try:
        reminder = maybe_remind(payload, registry)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        reminder = "[memory:维护提醒失败] {}。请修复触发机制，不能把它当作已完成维护。".format(exc)
        if result is None:
            result = {"systemMessage": reminder}
        else:
            result["systemMessage"] = result.get("systemMessage", "") + "\n" + reminder
    if reminder:
        if result is None:
            result = {}
        output = result.setdefault("hookSpecificOutput", {
            "hookEventName": payload["hook_event_name"], "additionalContext": ""})
        output["additionalContext"] = "\n\n".join(filter(None, [output["additionalContext"], reminder]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registry", nargs="?", type=Path,
                        default=DEFAULT_REGISTRY)
    parser.add_argument("--hook", action="store_true", help="Read a CLI hook event from stdin; silent when healthy")
    args = parser.parse_args()
    if args.hook:
        try:
            raw = sys.stdin.buffer.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("hook 输入超出容量")
            result = handle_hook(json.loads(raw), args.registry)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False))
        except (OSError, ValueError, RuntimeError) as exc:
            print("memory hook 执行失败：{}".format(exc), file=sys.stderr)
            return 1
        return 0
    try:
        root, count = check(args.registry)
        warnings = capacity_warnings(args.registry)
        links = broken_local_links(args.registry)
    except (OSError, ValueError, RuntimeError) as exc:
        print("memory 检查失败：{}".format(exc), file=sys.stderr)
        return 1
    if links:
        print("memory 断链报警：" + "；".join(links[:20]), file=sys.stderr)
    if warnings:
        print("memory 容量报警：" + "；".join(warnings), file=sys.stderr)
    if warnings or links:
        return 1
    print("memory 检查通过：{} 个节点，根节点 {}".format(count, root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
