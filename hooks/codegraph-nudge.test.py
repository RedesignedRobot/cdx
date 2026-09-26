"""Pure tests for the standalone Codegraph head hook."""
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).with_name("codegraph-nudge.sh")


def load(path):
    spec = importlib.util.spec_from_loader("codegraph_nudge", SourceFileLoader("codegraph_nudge", str(path)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = load(SOURCE)


class HookRules(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.repo = self.base / "repo"
        self.other = self.base / "other"
        for root in (self.repo, self.other):
            (root / ".codegraph").mkdir(parents=True)
            (root / "src").mkdir()
            (root / "src" / "handler.ts").touch()
        which = patch.object(hook.shutil, "which", return_value="/usr/local/bin/codegraph")
        which.start()
        self.addCleanup(which.stop)

    def test_targets_flags_and_order(self):
        repo = str(self.repo)
        self.assertTrue(hook.command_search(f"rg handleRequest {self.repo / 'src/handler.ts'}", repo))
        self.assertFalse(hook.command_search(f"rg handleRequest {self.other / 'src/handler.ts'}", repo))
        self.assertFalse(hook.command_search("rg handleRequest missing.ts", repo))
        nested = self.repo / "vendor"
        (nested / ".git").mkdir(parents=True)
        (nested / "src").mkdir()
        (nested / "src/handler.ts").touch()
        self.assertFalse(hook.command_search("rg handleRequest vendor/src/handler.ts", repo))
        for command in ("rg -Fn handleRequest src", "rg -Fq handleRequest src", "rg -ql handleRequest src", "rg --type json handleRequest src", "rg -t json handleRequest src", "rg --files src"):
            with self.subTest(command=command):
                self.assertFalse(hook.command_search(command, repo))
        self.assertFalse(hook.command_search("codegraph explore handler && rg handleRequest src", repo))
        self.assertTrue(hook.command_search("rg handleRequest src && codegraph explore handler", repo))

    def test_attached_filter_values_match_split_forms(self):
        repo = str(self.repo)
        for option, attached, value in (
            ("-g", "-g'*.json'", "*.json"), ("-t", "-tjson", "json"),
            ("--glob", "--glob=*.json", "*.json"), ("--type", "--type=json", "json"),
            ("--include", "--include=*.md", "*.md"),
            ("-g", "-g*.ts", "*.ts"), ("-t", "-tts", "ts"),
            ("--glob", "--glob=*.ts", "*.ts"), ("--type", "--type=ts", "ts"),
            ("--include", "--include=*.ts", "*.ts"),
            ("-f", "-fpatterns.txt", "patterns.txt"),
            ("--file", "--file=patterns.txt", "patterns.txt"),
            ("--exclude", "--exclude=*.json", "*.json"),
            ("--exclude-dir", "--exclude-dir=vendor", "vendor"),
            ("-e", "-ehandleRequest", "handleRequest"),
            ("--regexp", "--regexp=handleRequest", "handleRequest"),
        ):
            with self.subTest(attached=attached):
                suffix = " src" if option in {"-e", "--regexp"} else " handleRequest src"
                self.assertEqual(hook.command_search(f"rg {attached}{suffix}", repo),
                                 hook.command_search(f"rg {option} {value}{suffix}", repo))
        for command in ("rg -g'*.json' X .", "rg -tjson X .",
                        "rg --glob=*.json X .", "rg --type=json X .",
                        "rg --include=*.md X ."):
            with self.subTest(command=command):
                self.assertFalse(hook.command_search(command, repo))
                self.assertFalse(hook.command_search(command.replace(" X .", " handleRequest ."), repo))

    def test_unsafe_shell_structures_fail_open(self):
        repo = str(self.repo)
        commands = (
            "cat <<EOF\nrg handleRequest src\nEOF",
            "cat <<< 'rg handleRequest src'",
            "rg handleRequest src # <<",
            "echo $(rg handleRequest src)",
            "echo `rg handleRequest src`",
            'cd "$TARGET"; rg handleRequest src',
            "rg $PATTERN src",
            "(rg handleRequest src)",
            "{ rg handleRequest src; }",
            "if false; then\nrg handleRequest src\nfi",
            "[[ false ]] && rg handleRequest src",
            "echo ';' rg handleRequest src",
            "echo \\; rg handleRequest src",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(hook.command_search(command, repo))
                self.assertFalse(hook.should_nudge({"cwd": repo, "tool_input": {"command": command}}))

    def test_deadline_wrapper_and_missing_binary(self):
        repo = str(self.repo)
        self.assertFalse(hook.command_search(f"{hook.EXPLORE} handler && rg handleRequest src", repo))
        self.assertTrue(hook.command_search(f"rg handleRequest src && {hook.EXPLORE} handler", repo))
        payload = {"cwd": repo, "tool_input": {"command": "rg handleRequest src"}}
        self.assertTrue(hook.should_nudge(payload))
        with patch.object(hook.shutil, "which", return_value=None):
            self.assertFalse(hook.should_nudge(payload))

    def test_missing_directories_stay_silent(self):
        for cwd, command in ((str(self.base / "missing"), "rg handleRequest src"),
                             (str(self.repo), "cd missing && rg handleRequest src")):
            with self.subTest(cwd=cwd, command=command):
                self.assertIsNone(hook.search_root_for(command, cwd))
                self.assertFalse(hook.should_nudge({"cwd": cwd, "tool_input": {"command": command}}))

    def test_main_nudges_once_per_session_without_blocking(self):
        def run(command, session="session"):
            payload = {"cwd": str(self.repo), "tool_input": {"command": command}, "session_id": session}
            output = io.StringIO()
            with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(sys, "stdout", output), patch.object(hook.tempfile, "gettempdir", return_value=str(self.base)):
                hook.main()
            return output.getvalue()
        self.assertEqual(run("rg -F handleRequest src"), "")
        nudge = json.loads(run("rg handleRequest src"))["hookSpecificOutput"]
        self.assertEqual(nudge, {"hookEventName": "PreToolUse", "additionalContext": hook.NUDGE})
        self.assertIn(hook.EXPLORE, hook.NUDGE)
        self.assertLess(len(hook.NUDGE.split()), 50)
        self.assertEqual(run("rg handleRequest src"), "")
        self.assertEqual(run("rg parseConfig src"), "")
        self.assertIn("additionalContext", run("rg handleRequest src", "other"))
        self.assertEqual(run("rg handleRequest src", ""), "")

if __name__ == "__main__":
    unittest.main()
