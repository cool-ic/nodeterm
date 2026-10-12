"""Verify full, fresh and scoped recovery without starting model sessions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import load_memory as m


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.registry = self.base / "memory.json"
        self.source = self.base / "纲领.md"
        self.source.write_text("核心方法论\n" + "完整原文。" * 300, encoding="utf-8")
        self.registry.write_text(json.dumps({
            "scan": {"include": ["*.md"], "exclude": ["AGENTS.md"]},
            "documents": [{"path": "纲领.md", "parent": None}]}), encoding="utf-8")

    def event(self, source="startup", **patch):
        return dict({"cwd": str(self.base), "hook_event_name": "SessionStart", "source": source}, **patch)

    def context(self, event):
        return m.handle_hook(event, self.registry)["hookSpecificOutput"]["additionalContext"]

    def test_every_recovery_event_contains_the_full_current_source(self):
        for source in m.START_SOURCES:
            context = self.context(self.event(source))
            self.assertEqual(context.count(self.source.read_text()), 1)

    def test_compaction_rereads_changed_source(self):
        before = self.context(self.event())
        self.source.write_text("新约定，不读取旧摘要", encoding="utf-8")
        after = self.context(self.event("compact"))
        self.assertNotEqual(before, after)
        self.assertIn("新约定，不读取旧摘要", after)
        self.assertNotIn("完整原文", after)

    def test_only_compact_claims_a_compaction_just_occurred(self):
        compact = self.context(self.event("compact"))
        self.assertIn("你刚经历了一次 compact", compact)
        self.assertIn("主动回顾相关文档", compact)
        for source in m.START_SOURCES - {"compact"}:
            self.assertNotIn("你刚经历了一次 compact", self.context(self.event(source)))
        self.assertIn("恢复已有会话", self.context(self.event("resume")))

    def test_map_is_current_and_shows_paths_purposes_and_parent_relationships(self):
        data = json.loads(self.registry.read_text())
        data["documents"][0]["purpose"] = "当前方法论"
        for name, parent, purpose in (("state.md", "纲领.md", "当前任务状态"),
                                      ("details.md", "state.md", "按需查询的任务细节")):
            (self.base / name).write_text("DETAIL_BODY_NOT_AUTO_LOADED", encoding="utf-8")
            data["documents"].append({"path": name, "parent": parent, "purpose": purpose})
        self.registry.write_text(json.dumps(data))
        before = self.context(self.event("compact"))
        self.assertIn("- 纲领.md — 当前方法论（纲领正文已注入）", before)
        self.assertIn("  - state.md — 当前任务状态（按需读取）", before)
        self.assertIn("    - details.md — 按需查询的任务细节（按需读取）", before)
        self.assertNotIn("DETAIL_BODY_NOT_AUTO_LOADED", before)
        data["documents"][1]["purpose"] = "更新后的当前任务状态"
        self.registry.write_text(json.dumps(data))
        after = self.context(self.event("compact"))
        self.assertIn("更新后的当前任务状态", after)
        self.assertNotEqual(before, after)

    def test_tool_events_and_other_sessions_do_not_receive_recovery(self):
        for patch in ({"hook_event_name": "PostToolUse"}, {"cwd": str(self.base / "child")},
                      {"cwd": str(self.base.parent)}, {"cwd": None}, {"cwd": "relative"}, {"source": "unknown"}):
            self.assertIsNone(m.handle_hook(self.event(**patch), self.registry))

    def test_missing_and_empty_sources_fail_visibly(self):
        for content in ("", None):
            if content is None:
                self.source.unlink()
            else:
                self.source.write_text(content, encoding="utf-8")
            output = m.handle_hook(self.event("compact"), self.registry)
            self.assertIn("恢复失败", output["systemMessage"])
            self.assertNotIn("[PROJECT_MEMORY_V1", output["hookSpecificOutput"]["additionalContext"])

    def test_over_budget_source_warns_in_checker_but_still_loads_in_full(self):
        import check_memory
        data = json.loads(self.registry.read_text())
        data["documents"][0]["max_chars"] = 4000
        data["max_loaded_chars"] = 4500
        self.registry.write_text(json.dumps(data))
        content = "字" * 6000
        self.source.write_text(content, encoding="utf-8")
        alert = check_memory.handle_hook(self.event("compact"), self.registry)
        self.assertIn("[memory:防止膨胀]", alert["systemMessage"])
        result = m.handle_hook(self.event("compact"), self.registry)
        self.assertNotIn("systemMessage", result)
        self.assertIn(content, result["hookSpecificOutput"]["additionalContext"])

    def test_other_registered_memories_and_archives_are_not_auto_loaded(self):
        child = self.base / "child.md"
        child.write_text("CHILD_NOT_AUTO_LOADED")
        data = json.loads(self.registry.read_text())
        data["documents"].append({"path": "child.md", "parent": "纲领.md"})
        self.registry.write_text(json.dumps(data))
        (self.base / "old_doc").mkdir()
        (self.base / "old_doc" / "credentials.md").write_text("ARCHIVE_NOT_AUTO_LOADED")
        context = self.context(self.event())
        self.assertNotIn("CHILD_NOT_AUTO_LOADED", context)
        self.assertNotIn("ARCHIVE_NOT_AUTO_LOADED", context)

    def test_symlinked_source_and_registry_are_rejected(self):
        original = self.source.read_bytes()
        hidden = self.base / ".other"
        hidden.write_bytes(original)
        self.source.unlink()
        self.source.symlink_to(hidden)
        self.assertIn("符号链接", m.handle_hook(self.event(), self.registry)["systemMessage"])
        self.source.unlink()
        self.source.write_bytes(original)
        moved = self.base / ".registry"
        self.registry.rename(moved)
        self.registry.symlink_to(moved)
        self.assertIn("符号链接", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_cli_hook_output_contains_full_text(self):
        result = subprocess.run([sys.executable, "-B", str(Path(m.__file__)), str(self.registry), "--hook"],
                                input=json.dumps(self.event("compact")), capture_output=True, text=True, check=True)
        output = json.loads(result.stdout)
        self.assertIn(self.source.read_text(), output["hookSpecificOutput"]["additionalContext"])

    def test_unregistered_draft_does_not_block_recovery_or_get_auto_loaded(self):
        (self.base / "draft.md").write_text("UNREGISTERED_DRAFT_BODY")
        output = m.handle_hook(self.event("compact"), self.registry)
        self.assertNotIn("systemMessage", output)
        context = output["hookSpecificOutput"]["additionalContext"]
        self.assertIn(self.source.read_text(), context)
        self.assertNotIn("UNREGISTERED_DRAFT_BODY", context)


if __name__ == "__main__":
    unittest.main()
