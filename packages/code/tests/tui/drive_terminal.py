"""Drive the public TUI demo in a real PTY and retain complete ANSI frames."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

output = pathlib.Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
master, slave = pty.openpty()
size = (100, 32)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", size[1], size[0], 0, 0))
env = dict(os.environ, TERM="xterm-256color")
env.pop("NO_COLOR", None)
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
raw = bytearray()
frames = []

def read(timeout=0.05):
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            raw.extend(data)
        return bool(data)
    return False

def wait_for(text, since=0):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        read()
        plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw[since:].decode("utf-8", errors="replace"))
        if text in plain:
            return
        if child.poll() is not None:
            raise RuntimeError(f"TUI exited while waiting for {text!r}: {plain[-2000:]}")
    raise RuntimeError(f"Timed out waiting for {text!r}")

def snapshot(name):
    while read(0.1):
        pass
    file = f"{name}.ansi"
    (output / file).write_bytes(raw)
    frames.append({"name": name, "file": file, "columns": size[0], "rows": size[1]})

def send(text):
    start = len(raw)
    os.write(master, text.encode())
    return start

try:
    wait_for("Scripted model")
    snapshot("pty-01-ready")
    start = send("stream\r")
    wait_for("held open", start)
    snapshot("pty-02-streaming")
    wait_for("Scripted model", start)
    start = send("edit\r")
    wait_for("Edit file", start)
    snapshot("pty-03-edit")
    start = send("\x1b[B\r")
    wait_for("Your decision was recorded", start)
    snapshot("pty-04-approved")
    start = send("long\r")
    wait_for("Line 80", start)
    snapshot("pty-05-long")
    send("\x1b[5~")
    snapshot("pty-06-scrolled")
    send("\x03")
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        read(0.1)
    child.wait(timeout=1)
    if child.returncode != 0:
        raise RuntimeError(f"TUI exited with {child.returncode}")
    (output / "frames.json").write_text(json.dumps(frames))
finally:
    (output / "session.ansi").write_bytes(raw)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    os.close(master)
