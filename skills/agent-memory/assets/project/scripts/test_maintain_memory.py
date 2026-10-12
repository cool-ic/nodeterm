"""Verify low-frequency prompts, session isolation and bounded runtime state."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import check_memory
import maintain_memory as m


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.registry = self.base / "memory.json"
        self.state = self.base / "state.sqlite3"
        self.source = self.base / "纲领.md"
        self.parts = {
            "purpose": "减少遗忘和返工；允许无需更新。",
            "criteria": "level0 程序约束；level1 注入；level2 文档。实时性、真被用、信噪比。",
            "boundaries": "唯一正文、容量预算、新文档审批；例子不是任务。",
            "procedure": "回看事实、列出候选、分类、选择 level、更新合并删除、检查使用入口、报告结果。",
        }
        self.write_source()
        self.data = {"scan": {"include": ["*.md"], "exclude": []}, "max_loaded_chars": 4500,
                     "maintenance": {"every_tool_calls": 50},
                     "documents": [{"path": "纲领.md", "parent": None, "max_chars": 4000}]}
        self.save()

    def save(self):
        self.registry.write_text(json.dumps(self.data), encoding="utf-8")

    def write_source(self):
        self.source.write_text("\n".join(
            "<!-- maintenance-{}:start -->\n{}\n<!-- maintenance-{}:end -->".format(key, value, key)
            for key, value in self.parts.items()) + "\n# 具体实践\nUNRELATED_IMPLEMENTATION_DETAILS", encoding="utf-8")

    def event(self, call, session="test-session", event="PostToolUse"):
        return {"cwd": str(self.base), "hook_event_name": event, "session_id": session, "tool_use_id": str(call)}

    def remind(self, event):
        return m.maybe_remind(event, self.registry, self.state)

    def test_fiftieth_call_reminds_then_waits_another_fifty(self):
        for i in range(1, 50):
            self.assertIsNone(self.remind(self.event(i)))
        message = self.remind(self.event(50))
        for part in self.parts.values():
            self.assertEqual(message.count(part), 1)
        self.assertNotIn("UNRELATED_IMPLEMENTATION_DETAILS", message)
        for i in range(51, 100):
            self.assertIsNone(self.remind(self.event(i)))
        self.assertIn(self.parts["procedure"], self.remind(self.event(100)))

    def test_resume_does_not_reset_count_and_other_sessions_are_independent(self):
        self.data["maintenance"]["every_tool_calls"] = 2
        self.save()
        self.assertIsNone(self.remind(self.event(1)))
        self.assertIsNone(self.remind(self.event(1, session="other")))
        self.assertIsNone(self.remind(self.event(2, event="SessionStart")))
        self.assertIsNotNone(self.remind(self.event(2)))

    def test_concurrent_duplicate_events_do_not_accelerate_reminders(self):
        self.data["maintenance"]["every_tool_calls"] = 2
        self.save()
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.remind(self.event(1)), range(12)))
        self.assertTrue(all(result is None for result in results))
        self.assertIsNotNone(self.remind(self.event(2)))

    def test_latest_prompt_is_read_when_due(self):
        self.data["maintenance"]["every_tool_calls"] = 2
        self.save()
        self.remind(self.event(1))
        self.parts["criteria"] = "新核心定义：完整保留"
        self.write_source()
        self.assertIn(self.parts["criteria"], self.remind(self.event(2)))

    def test_bad_prompt_does_not_consume_due_reminder(self):
        self.data["maintenance"]["every_tool_calls"] = 1
        self.save()
        original = self.source.read_text()
        self.source.write_text("")
        with self.assertRaisesRegex(ValueError, "为空"):
            self.remind(self.event(1))
        self.source.write_text(original)
        self.assertIsNotNone(self.remind(self.event(1)))

    def test_over_budget_methodology_is_still_injected_in_full(self):
        content = "完整核心与基石\n" + "经验不能脱离level定义。" * 500 + "\n最后的维护要求"
        self.parts["criteria"] = content
        self.write_source()
        self.data["maintenance"]["every_tool_calls"] = 1
        self.save()
        self.assertEqual(self.remind(self.event(1)).count(content), 1)

    def test_fact_lookup_exposes_path_without_copying_transcript_contents(self):
        self.data["maintenance"]["every_tool_calls"] = 1
        self.save()
        transcript = self.base / "session.jsonl"
        transcript.write_text("PRIVATE_RAW_TRANSCRIPT_CONTENT")
        event = self.event(1)
        event["transcript_path"] = str(transcript)
        message = self.remind(event)
        self.assertIn(str(transcript), message)
        self.assertNotIn("PRIVATE_RAW_TRANSCRIPT_CONTENT", message)
        self.assertIn(str(self.registry), message)

    def test_absent_fact_source_is_disclosed_not_invented(self):
        for path in (None, "relative.jsonl", str(self.base / "missing.jsonl")):
            message = m.prompt(self.registry, 50, path)
            self.assertIn("未提供可用的当前会话记录入口", message)
            self.assertIn("信息缺口，不编造", message)

    def test_due_maintenance_resurfaces_deduplicated_broken_links(self):
        self.source.write_text(self.source.read_text() + '\n[entry](missing.txt)')
        self.data["maintenance"]["every_tool_calls"] = 2
        self.save()
        with patch.object(m, "runtime_state_path", return_value=self.state):
            first = check_memory.handle_hook(self.event(1), self.registry)
            self.assertIn("断链提醒", first["systemMessage"])
            second = check_memory.handle_hook(self.event(2), self.registry)
            self.assertNotIn("断链提醒", second.get("systemMessage", ""))
            self.assertIn("当前待修复本地断链", second["hookSpecificOutput"]["additionalContext"])
            self.assertIn("missing.txt", second["hookSpecificOutput"]["additionalContext"])

    def test_missing_guidance_does_not_silently_fall_back_to_partial_prompt(self):
        self.source.write_text(self.source.read_text().replace("maintenance-criteria:start", "missing:start"))
        with self.assertRaisesRegex(ValueError, "标记"):
            m.prompt(self.registry, 50)

    def test_disabled_and_foreign_sessions_create_no_state(self):
        event = self.event(1)
        event["cwd"] = str(self.base / "child")
        self.assertIsNone(self.remind(event))
        self.data["maintenance"]["every_tool_calls"] = 0
        self.save()
        self.assertIsNone(self.remind(self.event(1)))
        self.assertFalse(self.state.exists())

    def test_capacity_alarm_and_maintenance_prompt_can_coexist(self):
        self.data["maintenance"]["every_tool_calls"] = 1
        self.data["documents"][0]["max_chars"] = 1
        self.save()
        before = self.source.read_bytes()
        with patch.object(m.tempfile, "gettempdir", return_value=str(self.base)):
            result = check_memory.handle_hook(self.event(1), self.registry)
        context = result["hookSpecificOutput"]["additionalContext"]
        self.assertIn("[memory:防止膨胀]", context)
        self.assertIn("[memory:维护内容]", context)
        self.assertEqual(self.source.read_bytes(), before)

    def test_missing_session_reports_visible_failure(self):
        event = self.event(1)
        del event["session_id"]
        result = check_memory.handle_hook(event, self.registry)
        self.assertIn("维护提醒失败", result["systemMessage"])
        self.assertFalse(self.state.exists())

    def test_old_sessions_are_removed_and_record_count_is_bounded(self):
        self.remind(self.event(1))
        with sqlite3.connect(self.state) as db:
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", ("stale", 1, "[]", 0))
            db.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?)",
                           [(str(i), 1, "[]", time.time() - 5) for i in range(150)])
        self.remind(self.event(2))
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sessions WHERE id='stale'").fetchone()[0], 0)
            self.assertLessEqual(db.execute("SELECT count(*) FROM sessions").fetchone()[0], m.MAX_SESSIONS)

    def test_unregistered_drafts_do_not_stop_periodic_maintenance(self):
        self.data["maintenance"]["every_tool_calls"] = 2
        self.save()
        (self.base / "draft.md").write_text("not a reason to stop work")
        with patch.object(m.tempfile, "gettempdir", return_value=str(self.base)):
            first = check_memory.handle_hook(self.event(1), self.registry)
            self.assertIn("文档归位提醒", first["hookSpecificOutput"]["additionalContext"])
            second = check_memory.handle_hook(self.event(2), self.registry)
        context = second["hookSpecificOutput"]["additionalContext"]
        self.assertIn("[memory:维护内容]", context)
        self.assertIn("draft.md", context)
        self.assertIn("待判断归属", context)


if __name__ == "__main__":
    unittest.main()
