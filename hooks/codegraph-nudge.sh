#!/usr/bin/env python3
"""Conservative Codegraph-first PreToolUse hook for Bash searches.

Blocks one semantic source search per turn in an indexed repo. Never blocks when
codegraph is not installed, the repo is unindexed, or an explore already ran this
turn, including one that failed or hit its 60 s deadline."""

import hashlib
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
from pathlib import Path


SOURCE_DIRS = {"src", "lib", "app", "apps", "packages", "hooks", "components", "server", "client", "test", "tests"}
SOURCE_EXTS = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".rb", ".php"}
NON_CODE_EXTS = {".md", ".json", ".jsonl", ".yaml", ".yml", ".log", ".txt", ".lock", ".html", ".css", ".svg", ".csv"}
SEMANTIC_WORDS = re.compile(r"\b(function|class|interface|type|enum|struct|def|import|export|return|implements|extends)\b|[A-Za-z_][A-Za-z_0-9]*\s*\(")
SYMBOL = re.compile(r"^[A-Za-z_$][A-Za-z_$0-9]*$")
VALUE_OPTIONS = {"-e", "--regexp", "-g", "--glob", "-t", "--type", "-f", "--file", "--exclude", "--include", "--exclude-dir"}
FILTER_OPTIONS = {"-g", "--glob", "-t", "--type", "--include"}
# cdx runs codegraph as `perl -e 'alarm 60; exec @ARGV' codegraph explore ...`.
DEADLINE = re.compile(r"""\bperl -e (['"])alarm \d+; ?exec @ARGV\1 """)
EXPLORE = "perl -e 'alarm 60; exec @ARGV' codegraph explore"


def obscured_shell_syntax(command):
    quote = None
    escaped = False
    for char in command:
        if escaped:
            if char in ";&|\n()<>{}":
                return True
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif char == quote:
            quote = None
        elif quote is None and char in "'\"":
            quote = char
        elif quote is not None and char in ";&|\n()<>{}":
            return True
    return False


def shell_segments(command):
    command = DEADLINE.sub("", command)
    if "<<" in command or "$" in command or "`" in command or obscured_shell_syntax(command):
        return []
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|\n()<>{}")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        parts = list(lexer)
    except ValueError:
        return []
    if any(part and all(c in "()<>{}" for c in part) for part in parts):
        return []
    if any(part in {"[[", "]]"} for part in parts):
        return []
    segments, current = [], []
    for part in parts:
        if not current and part in {"if", "then", "elif", "else", "fi", "for", "while", "until", "case", "esac", "do", "done", "select", "function"}:
            return []
        if part and all(c in ";&|\n" for c in part):
            if current:
                segments.append(current)
                current = []
        else:
            current.append(part)
    if current:
        segments.append(current)
    return segments


def indexed_root(directory):
    try:
        path = Path(directory).resolve(strict=True)
        for parent in (path, *path.parents):
            if (parent / ".codegraph").is_dir():
                return parent
            if (parent / ".git").exists():
                break
    except (OSError, ValueError):
        pass
    return None


def search_root_for(command, cwd):
    """Return the indexed root of a semantic search before its exploration."""
    try:
        directory = Path(cwd).resolve(strict=True)
    except (OSError, ValueError):
        return None
    explored = set()
    for segment in shell_segments(command):
        executable = os.path.basename(segment[0])
        if executable == "cd" and len(segment) == 2 and not re.search(r"[$*?`{}]", segment[1]):
            try:
                directory = (directory / os.path.expanduser(segment[1])).resolve(strict=True)
            except (OSError, ValueError):
                return None
            continue
        root = indexed_root(directory)
        if executable == "codegraph" and len(segment) > 1 and segment[1] == "explore" and root:
            explored.add(root)
        if executable in {"rg", "grep", "find"} and root not in explored and semantic_search(segment, directory, root):
            return root
    return None


def command_search(command, cwd):
    return search_root_for(command, cwd) is not None


def option_value(args, index):
    arg = args[index]
    if arg in VALUE_OPTIONS:
        return (arg, args[index + 1], 1) if index + 1 < len(args) else (arg, None, 0)
    if arg.startswith("--"):
        option, separator, value = arg.partition("=")
        if separator and option in VALUE_OPTIONS:
            return option, value, 0
    elif len(arg) > 2 and arg[:2] in {"-e", "-g", "-t", "-f"}:
        return arg[:2], arg[2:], 0
    return None, None, 0


def semantic_search(args, directory=None, root=None):
    executable = os.path.basename(args[0])
    if executable == "find":
        return False  # find's ordinary predicates enumerate paths or check existence.
    if any(arg in {"-F", "--fixed-strings", "--files", "-l", "--files-with-matches", "-L", "--files-without-match", "-q", "--quiet", "--no-ignore-vcs"} for arg in args[1:]):
        return False
    patterns, targets, source_filter, non_code_filter = [], [], False, False
    i = 1
    options_done = False
    while i < len(args):
        arg = args[i]
        option, value, consumed = option_value(args, i) if not options_done else (None, None, 0)
        if arg == "--":
            options_done = True
        elif option is not None:
            if value is None:
                return False
            if option in {"-e", "--regexp"}:
                patterns.append(value)
            elif option in FILTER_OPTIONS:
                source_filter |= value in {"ts", "js", "py", "go", "rs"} or any(value.endswith(ext) for ext in SOURCE_EXTS)
                non_code_filter |= value in {"json", "md", "log", "txt", "yaml", "yml", "css", "html", "svg", "csv"} or any(value.endswith(ext) for ext in NON_CODE_EXTS)
            i += consumed
        elif not options_done and arg.startswith("-"):
            if arg.startswith("-") and not arg.startswith("--") and any(c in arg[1:] for c in "FqlL"):
                return False
            if arg.startswith("--") and "=" not in arg and arg not in {"--hidden", "--no-ignore", "--line-number", "--recursive", "--ignore-case", "--case-sensitive", "--smart-case", "--word-regexp", "--pcre2"}:
                return False
        elif not patterns:
            patterns.append(arg)
        else:
            targets.append(arg)
        i += 1
    if not patterns or non_code_filter:
        return False
    if not targets and executable == "rg":
        targets = ["."]  # ripgrep searches the current directory by default.
    if not targets:
        return False
    # A mixed or unknown target set is ambiguous. Explicit non-code targets win.
    for target in targets:
        if directory is not None:
            try:
                actual = (directory / target).resolve(strict=True)
            except (OSError, ValueError):
                return False
            if indexed_root(actual) != root:
                return False
        suffix = Path(target).suffix.lower()
        if suffix in NON_CODE_EXTS or "log" in Path(target).parts:
            return False
        parts = set(Path(target).parts)
        if suffix not in SOURCE_EXTS and not (parts & SOURCE_DIRS) and not (target == "." or source_filter):
            return False
    for pattern in patterns:
        if SEMANTIC_WORDS.search(pattern):
            return True
        if SYMBOL.fullmatch(pattern) and (any(c.isupper() for c in pattern[1:]) or "_" in pattern):
            return True
    return False


def actual_user(content):
    if isinstance(content, str):
        return bool(content.strip())
    return (isinstance(content, list)
            and not any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content)
            and any(isinstance(block, dict) and block.get("type") == "text" and str(block.get("text", "")).strip() for block in content))


def completed_explore(records, cwd, search_root):
    """Return (last real turn marker, explore finished in that turn, failed or not)."""
    turn = None
    after = []
    for record in records:
        message = record.get("message", {})
        if not isinstance(message, dict):
            continue
        role = message.get("role", record.get("type"))
        if role == "user" and actual_user(message.get("content")):
            uuid = record.get("uuid")
            if not isinstance(uuid, str) or not uuid.strip():
                return None, False
            turn = uuid
            after = []
        elif turn is not None:
            after.append((role, message.get("content"), record.get("cwd")))
    if turn is None:
        return None, False
    calls = {}
    for role, content, record_cwd in after:
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if role == "assistant" and block.get("type") == "tool_use":
                name = block.get("name", "")
                tool_input = block.get("input", {})
                if not isinstance(tool_input, dict):
                    continue
                base = tool_input.get("cwd", record_cwd)
                if not isinstance(base, str):
                    base = None
                if name == "mcp__codegraph__codegraph_explore":
                    project = tool_input.get("projectPath", base)
                    if not isinstance(project, str) or (not isinstance(base, str) and not Path(project).is_absolute()):
                        continue
                    same_root = indexed_root(Path(base or "/") / project) == search_root
                elif name == "Bash":
                    command = tool_input.get("command")
                    same_root = isinstance(command, str) and explore_in_command(command, base or "/", search_root)
                else:
                    same_root = False
                if same_root:
                    calls[block.get("id")] = True
            elif role == "user" and block.get("type") == "tool_result":
                if block.get("tool_use_id") in calls:
                    return turn, True
    return turn, False


def explore_in_command(command, cwd, search_root):
    try:
        directory = Path(cwd).resolve(strict=True)
    except (OSError, ValueError):
        return False
    for segment in shell_segments(command):
        if os.path.basename(segment[0]) == "cd" and len(segment) == 2:
            try:
                directory = (directory / os.path.expanduser(segment[1])).resolve(strict=True)
            except (OSError, ValueError):
                return False
        elif os.path.basename(segment[0]) == "codegraph" and len(segment) > 1 and segment[1] == "explore" and indexed_root(directory) == search_root:
            return True
    return False


def read_transcript(path):
    try:
        with open(path, "rb") as stream:
            stream.seek(0, os.SEEK_END)
            offset = max(0, stream.tell() - 262144)
            stream.seek(offset)
            data = stream.read(262144)
        if offset:
            data = data.partition(b"\n")[2]
        records = [json.loads(line) for line in data.splitlines() if line.strip()]
        if not all(isinstance(record, dict) for record in records):
            return None
        return records
    except (OSError, UnicodeError, ValueError):
        return None


def first_denial(session, transcript, turn):
    """Atomic per-turn marker. If it cannot be stored, allow the tool."""
    key = hashlib.sha256(json.dumps([session, transcript, turn]).encode()).hexdigest()
    directory = Path(tempfile.gettempdir()) / f"codegraph-nudge-{os.getuid()}"
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.stat().st_mode & 0o077:
            return False
        fd = os.open(directory / key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        return True
    except OSError:
        return False


def decision(payload, records):
    if not isinstance(payload, dict) or records is None:
        return False, None
    command = payload.get("tool_input", {}).get("command") if isinstance(payload.get("tool_input"), dict) else None
    cwd = payload.get("cwd")
    if not isinstance(command, str) or not isinstance(cwd, str) or shutil.which("codegraph") is None:
        return False, None
    search_root = search_root_for(command, cwd)
    if search_root is None:
        return False, None
    turn, explored = completed_explore(records, cwd, search_root)
    if turn is None or explored:
        return False, turn
    return True, turn


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, UnicodeError):
        return
    if not isinstance(payload, dict):
        return
    transcript = payload.get("transcript_path")
    session = payload.get("session_id")
    if not isinstance(transcript, str) or not transcript or not isinstance(session, str) or not session:
        return
    should_block, turn = decision(payload, read_transcript(transcript))
    if should_block and first_denial(session, transcript, turn):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"Owner Codegraph-first rule: run `{EXPLORE} '<question>'` before a semantic source search in this indexed repo. If it times out or fails, this search is allowed on retry; so is a literal sweep, a log or non-code search, or a file listing."}}))


if __name__ == "__main__":
    main()
