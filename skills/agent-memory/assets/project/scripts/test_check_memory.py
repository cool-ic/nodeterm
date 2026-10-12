"""Check alert delivery and scope without touching real documents or CLI trust."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import check_memory as m


class MemoryCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.registry = self.base / "memory.json"
        self.data = {"scan": {"include": ["*.md"], "exclude": ["AGENTS.md"]},
                     "max_loaded_chars": 4500,
                     "documents": [{"path": "纲领.md", "parent": None, "max_chars": 4000}]}
        (self.base / "纲领.md").write_text("foundation", encoding="utf-8")
        self.save()

    def save(self):
        self.registry.write_text(json.dumps(self.data), encoding="utf-8")

    def event(self, event="PostToolUse", **patch):
        return dict({"cwd": str(self.base), "hook_event_name": event,
                     "tool_name": "Bash", "tool_input": {"command": "arbitrary command"}}, **patch)

    def add(self, path, parent):
        (self.base / path).write_text("content", encoding="utf-8")
        self.data["documents"].append({"path": path, "parent": parent, "max_chars": 4000})
        self.save()

    def test_valid_tree_and_healthy_hooks_are_silent(self):
        self.add("child.md", "纲领.md")
        self.assertEqual(m.check(self.registry), ("纲领.md", 2))
        for event in m.HOOK_EVENTS:
            self.assertIsNone(m.handle_hook(self.event(event), self.registry))

    def test_unregistered_file_alerts_without_modifying_it(self):
        path = self.base / "orphan.md"
        path.write_text("do not delete", encoding="utf-8")
        before = self.registry.read_bytes()
        for event in m.HOOK_EVENTS:
            alert = m.handle_hook(self.event(event), self.registry)
            self.assertIn("orphan.md", alert["hookSpecificOutput"]["additionalContext"])
            self.assertEqual(alert["hookSpecificOutput"]["hookEventName"], event)
        self.assertEqual(path.read_text(), "do not delete")
        self.assertEqual(self.registry.read_bytes(), before)

    def test_removed_document_alerts(self):
        (self.base / "纲领.md").unlink()
        alert = m.handle_hook(self.event(), self.registry)
        self.assertIn("不存在", alert["systemMessage"])

    def test_disconnected_cycle_alerts(self):
        self.add("a.md", "b.md")
        self.add("b.md", "a.md")
        self.assertIn("循环", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_missing_parent_alerts(self):
        self.add("a.md", "missing.md")
        self.assertIn("父节点未登记", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_multiple_roots_and_duplicates_alert(self):
        self.add("a.md", None)
        self.assertIn("根节点", m.handle_hook(self.event(), self.registry)["systemMessage"])
        self.data["documents"][1] = self.data["documents"][0].copy()
        self.save()
        self.assertIn("重复登记", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_archive_project_and_bootstrap_are_out_of_scan_scope(self):
        (self.base / "AGENTS.md").write_text("bootstrap")
        for folder in ("old_doc", "managed_jobs"):
            (self.base / folder).mkdir()
            (self.base / folder / "history.md").write_text("do not load")
        self.assertIsNone(m.handle_hook(self.event(), self.registry))

    def test_scan_scope_can_include_a_new_directory(self):
        (self.base / "memory").mkdir()
        (self.base / "memory" / "orphan.md").write_text("new")
        self.data["scan"]["include"].append("memory/*.md")
        self.save()
        self.assertIn("memory/orphan.md", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_other_sessions_and_events_do_not_inherit_manager_alerts(self):
        (self.base / "orphan.md").write_text("new")
        for patch in ({"cwd": str(self.base / "managed_jobs")}, {"cwd": str(self.base.parent)},
                      {"cwd": "relative"}, {"cwd": None}, {"hook_event_name": "Stop"}):
            self.assertIsNone(m.handle_hook(self.event(**patch), self.registry))

    def test_invalid_registry_is_visible(self):
        self.registry.write_text("bad JSON")
        self.assertIn("检查未通过", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_scan_scope_must_be_explicit_and_local(self):
        for scan in (None, {"include": [], "exclude": []}, {"include": ["../*.md"], "exclude": []}):
            self.data["scan"] = scan
            self.save()
            self.assertIn("检查未通过", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_cli_delivers_json_alarm_but_does_not_block(self):
        (self.base / "orphan.md").write_text("new")
        result = subprocess.run([sys.executable, "-B", str(Path(m.__file__)), str(self.registry), "--hook"],
                                input=json.dumps(self.event()), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("orphan.md", json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("decision", json.loads(result.stdout))

    def test_capacity_alerts_on_every_configured_event_and_clears_after_refining(self):
        source = self.base / "纲领.md"
        source.write_text("字" * 4001, encoding="utf-8")
        before = source.read_bytes()
        for event in m.HOOK_EVENTS:
            alert = m.handle_hook(self.event(event), self.registry)
            self.assertIn("[memory:防止膨胀]", alert["systemMessage"])
            self.assertIn("4001 字符，预算 4000", alert["systemMessage"])
            self.assertNotIn("decision", alert)
        self.assertEqual(source.read_bytes(), before)
        source.write_text("已精简", encoding="utf-8")
        self.assertIsNone(m.handle_hook(self.event(), self.registry))

    def test_each_document_and_actual_recovery_output_have_independent_budgets(self):
        self.add("child.md", "纲领.md")
        self.data["documents"][1]["max_chars"] = 3
        self.save()
        self.assertIn("child.md", m.handle_hook(self.event(), self.registry)["systemMessage"])
        self.data["documents"][1]["max_chars"] = 4000
        self.data["max_loaded_chars"] = 20
        self.save()
        self.assertIn("单次恢复输出", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_invalid_capacity_budget_is_visible(self):
        for limit in (None, 0, -1, True, "4000"):
            self.data["documents"][0]["max_chars"] = limit
            self.save()
            self.assertIn("容量检查未完成", m.handle_hook(self.event(), self.registry)["systemMessage"])

    def test_unregistered_reminder_is_quiet_until_findings_or_session_change(self):
        import maintain_memory
        path = self.base / "draft.md"
        path.write_text("temporary draft")
        event = self.event(session_id="first-session")
        with patch.object(maintain_memory.tempfile, "gettempdir", return_value=str(self.base)):
            first = m.handle_hook(event, self.registry)
            text = first["hookSpecificOutput"]["additionalContext"]
            for guidance in ("临时产物", "重复内容", "独立长期价值", "未登记不等于垃圾"):
                self.assertIn(guidance, text)
            self.assertNotIn("permissionDecision", first["hookSpecificOutput"])
            self.assertIsNone(m.handle_hook(event, self.registry))
            path.write_text("draft revised")
            self.assertIsNone(m.handle_hook(event, self.registry))
            self.assertIsNotNone(m.handle_hook(self.event("SessionStart", session_id="first-session"), self.registry))
            self.assertIsNotNone(m.handle_hook(self.event(session_id="second-session"), self.registry))
            path.unlink()
            self.assertIsNone(m.handle_hook(event, self.registry))
            path.write_text("new draft")
            self.assertIsNotNone(m.handle_hook(event, self.registry))

    def test_links_resolve_from_source_and_decode_paths(self):
        folder = self.base / "nested"
        folder.mkdir()
        self.add("nested/child.md", "纲领.md")
        (folder / "a b(1).txt").write_text("target")
        (folder / "child.md").write_text(
            '[root](../纲领.md#anything) [space](<a b(1).txt> "title") '
            '[encoded](a%20b(1).txt) [gone](../gone.md#part)')
        self.assertEqual(m.broken_local_links(self.registry), ["nested/child.md → ../gone.md#part"])

    def test_links_ignore_code_comments_remote_and_unregistered_sources(self):
        (self.base / "纲领.md").write_text(
            '[web](https://example.invalid/x) [mail](mailto:a@b) [anchor](#missing)\n'
            '[network](//example.invalid/x)\n`[code](missing1.md)`\n'
            '```md\n[example](missing2.md)\n```\n'
            '~~~\n[example](missing3.md)\n~~~\n'
            '    [code](missing4.md)\n<!-- [hidden](missing5.md) -->\n'
            '[ref][label]\n[label]: missing6.md\n')
        (self.base / "AGENTS.md").write_text('[out of scope](missing7.md)')
        self.assertEqual(m.broken_local_links(self.registry), [])

    def test_link_hook_deduplicates_and_recovery_still_loads(self):
        import maintain_memory
        from load_memory import render
        source = self.base / "纲领.md"
        source.write_text('[gone](gone.txt)')
        event = self.event(session_id="links-session")
        with patch.object(maintain_memory.tempfile, "gettempdir", return_value=str(self.base)):
            alert = m.handle_hook(event, self.registry)
            self.assertIn("断链提醒", alert["systemMessage"])
            self.assertNotIn("permissionDecision", alert["hookSpecificOutput"])
            self.assertIn('[gone](gone.txt)', render(self.registry))
            self.assertIsNone(m.handle_hook(event, self.registry))
            self.assertIn("断链提醒", m.handle_hook(self.event("SessionStart", session_id="links-session"), self.registry)["systemMessage"])
            (self.base / "gone.txt").write_text("real content")
            self.assertIsNone(m.handle_hook(event, self.registry))
            (self.base / "gone.txt").unlink()
            self.assertIn("断链提醒", m.handle_hook(event, self.registry)["systemMessage"])
        self.assertEqual(source.read_text(), '[gone](gone.txt)')

    def test_link_cli_reports_nonzero_and_hook_is_advisory(self):
        (self.base / "纲领.md").write_text('[broken](missing.txt)')
        command = [sys.executable, "-B", str(Path(m.__file__)), str(self.registry)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("断链报警", result.stderr)
        result = subprocess.run(command + ["--hook"], input=json.dumps(self.event()), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("断链提醒", json.loads(result.stdout)["systemMessage"])


if __name__ == "__main__":
    unittest.main()
