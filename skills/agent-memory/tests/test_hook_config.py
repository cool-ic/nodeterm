import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hook_config", SKILL / "scripts/hook_config.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(os.name == "posix", "POSIX hook generator")
class HookConfigTests(unittest.TestCase):
    def test_generated_commands_work_after_copy_to_quoted_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "project with 'quotes' and $literal"
            shutil.copytree(SKILL / "assets/project", root)
            original = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            for client in ("codex", "qoder"):
                output = module.config(root, client)
                groups = output["hooks"]["SessionStart"]
                event = json.dumps({"cwd": str(root), "hook_event_name": "SessionStart", "source": "compact"})
                for group in groups:
                    handler = group["hooks"][0]
                    result = subprocess.run(handler["command"], shell=True, input=event, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if "load_memory.py" in handler["command"]:
                        context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
                        self.assertIn("PROJECT_MEMORY_V1", context)
                        self.assertIn("工作记忆.md", context)
                        self.assertNotIn((root / "工作记忆.md").read_text(), context)
                    else:
                        self.assertEqual(result.stdout, "")
                    if client == "qoder":
                        self.assertNotIn("additionalContextLimit", handler)
            self.assertEqual(original, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_incomplete_project_is_rejected_without_creating_files(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                module.config(folder, "codex")
            self.assertEqual(list(Path(folder).iterdir()), [])
