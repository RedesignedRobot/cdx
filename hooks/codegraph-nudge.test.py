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


def user(text, uuid="turn"):
    return {"uuid": uuid, "message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def call(name, args, cwd=None):
    return {"cwd": cwd, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "call", "name": name, "input": args}]}}


def result(error=False):
    return {"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call", "is_error": error}]}}


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
                self.assertEqual(hook.decision({"cwd": repo, "tool_input": {"command": command}},
                                               [user("Find handler")]), (False, None))

    def test_completed_explore_matches_exact_tool_and_root(self):
        valid = [("mcp__codegraph__codegraph_explore", {"query": "handler"}), ("mcp__codegraph__codegraph_explore", {"projectPath": str(self.repo)}), ("Bash", {"command": f"cd {self.repo} && codegraph explore handler"})]
        invalid = [("mcp__other__codegraph_explore", {"projectPath": str(self.repo)}), ("mcp__codegraph__codegraph_explore", {"projectPath": str(self.other)}), ("Bash", {"command": f"cd {self.other} && codegraph explore handler"}), ("Bash", {"command": "echo codegraph explore"})]
        for name, args in valid + invalid:
            records = [user("Find handler"), call(name, args, str(self.repo)), result()]
            with self.subTest(name=name, args=args):
                self.assertEqual(hook.completed_explore(records, str(self.repo), self.repo.resolve()), ("turn", (name, args) in valid))
                self.assertEqual(hook.completed_explore(records[:-1], str(self.repo), self.repo.resolve()), ("turn", False))
                self.assertEqual(hook.completed_explore(records[:-1] + [result(True)], str(self.repo), self.repo.resolve()), ("turn", False))
        self.assertEqual(hook.completed_explore([user("Find"), call(*valid[0], cwd=str(self.repo)), result(), user("Next", "next")], str(self.repo), self.repo.resolve()), ("next", False))
        self.assertEqual(hook.completed_explore([user("Find"), call("mcp__codegraph__codegraph_explore", {"query": "handler"}, str(self.other)), result()], str(self.repo), self.repo.resolve()), ("turn", False))

    def test_bounded_transcript_fails_open_without_turn(self):
        path = self.base / "history.jsonl"
        path.write_text(json.dumps(user("old")) + "\n" + (json.dumps(result()) + "\n") * 10000)
        records = hook.read_transcript(path)
        self.assertLess(len(records), 10000)
        payload = {"cwd": str(self.repo), "tool_input": {"command": "rg handleRequest src"}}
        self.assertEqual(hook.decision(payload, records), (False, None))
        for cwd, command in ((str(self.base / "missing"), "rg handleRequest src"),
                             (str(self.repo), "cd missing && rg handleRequest src")):
            with self.subTest(cwd=cwd, command=command):
                self.assertIsNone(hook.search_root_for(command, cwd))
                self.assertEqual(hook.decision({"cwd": cwd, "tool_input": {"command": command}}, [user("Find handler")]), (False, None))
        missing_uuid = user("Find handler")
        del missing_uuid["uuid"]
        self.assertEqual(hook.decision(payload, [missing_uuid]), (False, None))
        self.assertEqual(hook.decision(payload, [result(), missing_uuid]), (False, None))
        mixed_result = {"message": {"role": "user", "content": result()["message"]["content"] + [{"type": "text", "text": "tool output"}]}}
        self.assertEqual(hook.decision(payload, [user("Find handler"), mixed_result]), (True, "turn"))

    def test_main_denies_once_per_turn_with_mocked_io(self):
        path = self.base / "history.jsonl"
        path.write_text(json.dumps(user("Find handler")) + "\n")
        payload = {"cwd": str(self.repo), "tool_input": {"command": "rg handleRequest src"}, "transcript_path": str(path), "session_id": "session"}
        def run():
            output = io.StringIO()
            with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(sys, "stdout", output), patch.object(hook.tempfile, "gettempdir", return_value=str(self.base)):
                hook.main()
            return output.getvalue()
        self.assertEqual(json.loads(run())["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(run(), "")
        path.write_text(path.read_text() + json.dumps(user("Next", "next")) + "\n")
        self.assertEqual(json.loads(run())["hookSpecificOutput"]["permissionDecision"], "deny")

if __name__ == "__main__":
    unittest.main()
