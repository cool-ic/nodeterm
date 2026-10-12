"""Occasional maintenance prompts, called by the existing PostToolUse hook."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time


RETENTION_SECONDS = 30 * 24 * 60 * 60
MAX_SESSIONS = 128
RECENT_CALLS = 200


def runtime_state_path(registry):
    project = hashlib.sha256(str(Path(registry).absolute().parent.resolve()).encode()).hexdigest()[:16]
    folder = Path(tempfile.gettempdir()) / ("project-memory-" + project)
    folder.mkdir(mode=0o700, exist_ok=True)
    return folder / "maintenance.sqlite3"


def orphan_reminder_due(payload, registry, paths, category="orphan"):
    """Notify on changed findings or session recovery, not every tool call."""
    table = {"orphan": "orphan_alerts", "links": "link_alerts"}[category]
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return bool(paths)  # No reliable session key: do not silently suppress.
    session = hashlib.sha256(session.encode()).hexdigest()
    signature = hashlib.sha256(json.dumps(paths, ensure_ascii=False).encode()).hexdigest()
    state = runtime_state_path(registry)
    if not paths and not state.exists():
        return False
    now = time.time()
    with closing(sqlite3.connect(str(state), timeout=2)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(f"CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, signature TEXT NOT NULL, last_seen REAL NOT NULL)")
        db.execute(f"DELETE FROM {table} WHERE last_seen < ?", (now - RETENTION_SECONDS,))
        row = db.execute(f"SELECT signature FROM {table} WHERE id = ?", (session,)).fetchone()
        due = bool(paths) and (payload.get("hook_event_name") == "SessionStart" or row is None or row[0] != signature)
        db.execute(f"INSERT OR REPLACE INTO {table} VALUES (?, ?, ?)", (session, signature, now))
        db.execute(f"DELETE FROM {table} WHERE id NOT IN (SELECT id FROM {table} ORDER BY last_seen DESC LIMIT ?)", (MAX_SESSIONS,))
    return due


def section(text, name):
    start, end = "<!-- {}:start -->".format(name), "<!-- {}:end -->".format(name)
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError("维护正文标记缺失或重复：" + name)
    left, right = text.index(start) + len(start), text.index(end)
    if right <= left or not text[left:right].strip():
        raise ValueError("维护正文区段为空或顺序错误：" + name)
    return text[left:right].strip()


def prompt(registry, interval, transcript_path=None):
    # Extract complete guidance from the canonical source. Facts stay in their
    # own sources: expose a lookup path, never copy raw conversation/credentials.
    from check_memory import check, unregistered_documents, broken_local_links
    registry = Path(registry).absolute()
    if registry.is_symlink():
        raise ValueError("memory.json 不能是符号链接")
    root, _ = check(registry, require_registered=False)
    source = registry.parent / root
    if source.is_symlink():
        raise ValueError("维护正文来源不能是符号链接")
    text = source.read_text(encoding="utf-8")
    if not text.strip():
        raise ValueError("维护正文来源为空")
    parts = {key: section(text, "maintenance-" + key)
             for key in ("purpose", "criteria", "boundaries", "procedure")}
    transcript = None
    if isinstance(transcript_path, str) and transcript_path and len(transcript_path) <= 4096:
        try:
            candidate = Path(transcript_path)
            if candidate.is_absolute() and candidate.is_file():
                transcript = str(candidate)
        except (OSError, ValueError):
            pass
    evidence = [
        "以当前任务、最新用户指令和仍可见的工作记录为准，先核对用户决定、进展、失败经验及事实变化。",
        "当前文档树与预算：{}；只定向读取相关节点。".format(registry),
        "当前机制实现状态与权限边界：{}；方法论中的设想不等于已实现。".format(registry.parent / "AGENTS.md"),
    ]
    if transcript:
        evidence.append("当前会话记录入口：{}。只回查与当前维护有关的片段，不全文加载或复制敏感内容。".format(json.dumps(transcript, ensure_ascii=False)))
    else:
        evidence.append("hook 未提供可用的当前会话记录入口。若当前上下文和获准的 memory 中也找不到事实，请明确说明信息缺口，不编造。")
    evidence.append("本提醒提供维护规程与回查入口，没有自动提炼或保存近期事实；历史材料须通过已登记入口按需查找，不是当前任务或授权来源。")
    unregistered = unregistered_documents(registry)
    if unregistered:
        evidence.append("当前待判断归属的文档（共 {} 份）：{}。判断临时产物、可合并记录或独立长期 memory；不要机械删除或登记。".format(
            len(unregistered), ", ".join(repr(name) for name in unregistered[:20])))
    links = broken_local_links(registry)
    if links:
        evidence.append("当前待修复本地断链（共 {} 处）：{}。核对原意后修正引用，不创建占位文件消除报警。".format(
            len(links), "；".join(links[:20])))
    return ("[memory:维护内容] 本会话又完成了 {} 次工具调用，请在当前工作允许的时机做一次维护审查。"
            "正文来源：{}。\n\n"
            "## 1. 维护目的\n{}\n\n"
            "## 2. 判断标准与操作边界\n{}\n\n{}\n\n"
            "## 3. 本次事实回查入口\n{}\n\n"
            "## 4. 完整维护流程\n{}"
            ).format(interval, source, parts["purpose"], parts["criteria"],
                     parts["boundaries"], "\n".join("- " + item for item in evidence), parts["procedure"])


def maybe_remind(payload, registry, state_path=None):
    if payload.get("hook_event_name") != "PostToolUse":
        return None
    registry = Path(registry).absolute()
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    if Path(cwd).resolve() != registry.parent.resolve():
        return None
    config = json.loads(registry.read_text(encoding="utf-8")).get("maintenance", {})
    if not isinstance(config, dict):
        raise ValueError("maintenance 必须是对象")
    interval = config.get("every_tool_calls", 0)
    if type(interval) is not int or interval < 0:
        raise ValueError("every_tool_calls 必须是非负整数，0 表示关闭")
    if not interval:
        return None
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        raise ValueError("维护计数缺少 session_id")
    session = hashlib.sha256(session.encode()).hexdigest()
    call_id = payload.get("tool_use_id") or payload.get("tool_call_id")
    call_id = hashlib.sha256(call_id.encode()).hexdigest() if isinstance(call_id, str) and call_id else None
    if state_path is None:
        state_path = runtime_state_path(registry)
    now = time.time()
    with closing(sqlite3.connect(str(state_path), timeout=2)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, calls INTEGER NOT NULL, recent TEXT NOT NULL, last_seen REAL NOT NULL)")
        db.execute("DELETE FROM sessions WHERE last_seen < ?", (now - RETENTION_SECONDS,))
        row = db.execute("SELECT calls, recent FROM sessions WHERE id = ?", (session,)).fetchone()
        count, recent = (row[0], json.loads(row[1])) if row else (0, [])
        if call_id and call_id in recent:
            return None
        count += 1
        if call_id:
            recent = (recent + [call_id])[-RECENT_CALLS:]
        message = prompt(registry, interval, payload.get("transcript_path")) if count >= interval else None
        if message:
            count = 0
        db.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)", (session, count, json.dumps(recent), now))
        db.execute("DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY last_seen DESC LIMIT ?)", (MAX_SESSIONS,))
    return message
