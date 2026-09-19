"""One explicitly started local voice process, with sanitized lifecycle reporting."""
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path


STATUS_PREFIX = "SHOPSWARM_VOICE "
MESSAGES = {
    "configured": "ElevenLabs configured. Start voice to use this laptop's microphone and speakers.",
    "unconfigured": "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env, then restart the console.",
    "starting": "Connecting to ElevenLabs and opening the laptop microphone…",
    "connected": "Connected to ElevenLabs. The laptop microphone is active.",
    "stopping": "Closing the voice session and microphone…",
    "stopped": "Voice stopped. The laptop microphone is off.",
    "start_failed": "Voice could not start. Check the project virtual environment and voice dependencies.",
    "session_failed": "Voice connection failed. Check ElevenLabs access, network, and the laptop audio devices, then retry.",
    "startup_timeout": "Voice did not connect within 30 seconds. Check network and audio devices, then retry.",
    "stop_failed": "Could not confirm voice stopped. Close the console process before starting again.",
}


def emit_status(state):
    """Only fixed status names cross into the browser; SDK output is never exposed."""
    print(STATUS_PREFIX + json.dumps({"state": state}), flush=True)


def terminate_process_tree(process):
    """Windows venv Python is a launcher: force-stop its exact owned tree."""
    if process.poll() is not None:
        return False  # A vanished launcher PID could have been reused.
    try:
        result = subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW, timeout=3, check=False)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class VoiceSession:
    def __init__(self, project_dir=None, process_factory=None, startup_timeout=30):
        self.project_dir = Path(project_dir or Path(__file__).resolve().parents[1])
        self._popen = process_factory or subprocess.Popen
        self._startup_timeout = startup_timeout
        self._lock = threading.RLock()
        self._operation_lock = threading.Lock()
        self._process = None
        self._process_done = threading.Event()
        self._process_done.set()
        self._timer = None
        self._stop_requested = False
        self._state = "configured" if self.configured else "unconfigured"
        self._message = MESSAGES[self._state]

    @property
    def configured(self):
        return bool(os.getenv("ELEVENLABS_API_KEY") and os.getenv("ELEVENLABS_AGENT_ID"))

    def _set(self, state, message_code=None):
        self._state = state
        self._message = MESSAGES[message_code or state]

    def snapshot(self):
        with self._lock:
            return {"state": self._state, "configured": self.configured,
                    "running": self._process is not None and not self._process_done.is_set(),
                    "message": self._message}

    def start(self):
        with self._operation_lock, self._lock:
            if self._process is not None and not self._process_done.is_set():
                return self.snapshot()
            if not self.configured:
                self._set("unconfigured")
                return self.snapshot()
            python = self.project_dir / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            if not python.exists():
                self._set("error", "start_failed")
                return self.snapshot()
            kwargs = dict(cwd=str(self.project_dir), stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", bufsize=1)
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = subprocess.SW_HIDE
                kwargs["startupinfo"] = startup
            self._set("starting")
            self._stop_requested = False
            try:
                process = self._popen([str(python), "-u", "-m", "shopswarm", "voice"], **kwargs)
            except Exception:
                self._set("error", "start_failed")
                return self.snapshot()
            self._process = process
            self._process_done.clear()
            self._timer = threading.Timer(self._startup_timeout, self._timeout, args=(process,))
            self._timer.daemon = True
            self._timer.start()
            threading.Thread(target=self._monitor, args=(process,), daemon=True).start()
            return self.snapshot()

    def _consume(self, process, line):
        if not line.startswith(STATUS_PREFIX):
            return
        try:
            state = json.loads(line[len(STATUS_PREFIX):]).get("state")
        except (ValueError, AttributeError):
            return
        with self._lock:
            if process is not self._process or self._stop_requested or self._state == "error":
                return
            if state == "connected" and self._state == "starting":
                self._set("connected")
                self._timer.cancel()
            elif state == "error":
                self._set("error", "session_failed")
            # A stopped event is not proof of process/audio cleanup. Wait for exit.

    def _monitor(self, process):
        pipe_closed = False
        try:
            for line in process.stdout:
                self._consume(process, line)
            pipe_closed = True
            returncode = process.wait()
        except Exception:
            returncode = -1
        finally:
            for pipe in (process.stdout, process.stdin):
                try: pipe.close()
                except (OSError, ValueError, AttributeError): pass
        with self._lock:
            if process is not self._process:
                return
            # Launcher exit alone does not prove its audio child has exited.
            if pipe_closed and process.poll() is not None:
                self._process_done.set()
            self._timer.cancel()
            if self._state != "error":
                if self._process_done.is_set() and (self._stop_requested or (returncode == 0 and self._state == "connected")):
                    self._set("stopped")
                else:
                    self._set("error", "session_failed")

    def _timeout(self, process):
        with self._lock:
            if process is not self._process or self._state != "starting":
                return
        self.stop(error_code="startup_timeout", expected_process=process)

    def _wait_exit(self, process, timeout):
        deadline = time.monotonic() + timeout
        try:
            process.wait(timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return self._process_done.wait(max(0, deadline - time.monotonic()))

    def stop(self, error_code=None, expected_process=None):
        with self._operation_lock:
            with self._lock:
                if expected_process is not None and (expected_process is not self._process or self._state != "starting"):
                    return self.snapshot()
                process = self._process
                self._stop_requested = True
                if self._timer: self._timer.cancel()
                if error_code: self._set("error", error_code)
                elif process is not None and not self._process_done.is_set(): self._set("stopping")
            if process is not None and not self._process_done.is_set():
                try:
                    process.stdin.write("stop\n")
                    process.stdin.flush()
                except (OSError, ValueError):
                    pass
                if not self._wait_exit(process, 3):
                    try:
                        if process.poll() is None:
                            process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
                    except OSError: pass
                    if not self._wait_exit(process, 2):
                        if os.name == "nt":
                            # Never kill just the launcher: that can orphan the microphone.
                            terminate_process_tree(process)
                            self._wait_exit(process, 2)
                        else:
                            try:
                                process.terminate()
                                if not self._wait_exit(process, 2):
                                    process.kill()
                                    self._wait_exit(process, 1)
                            except OSError: pass
            with self._lock:
                if process is not None and not self._process_done.is_set():
                    self._set("error", "stop_failed")
                elif not error_code:
                    self._set("stopped")
                return self.snapshot()

    def close(self):
        return self.stop()
