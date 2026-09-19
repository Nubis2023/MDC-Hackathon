"""OS-held project voice lock shared by standalone and console-managed clients."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path


class VoiceLockError(RuntimeError):
    """The project voice lock could not be opened or acquired."""


class VoiceSessionBusy(VoiceLockError):
    """Another process already holds this project's voice session lock."""


def _lock(file):
    if os.name == "nt":
        import msvcrt
        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(file):
    if os.name == "nt":
        import msvcrt
        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(file.fileno(), fcntl.LOCK_UN)


@contextmanager
def acquire_voice_lock(project_dir=None):
    """Hold one project's voice session exclusively until this context exits.

    Raises VoiceSessionBusy immediately when another process owns the lock;
    raises VoiceLockError for other lock I/O failures. The handle is closed on
    every exit, including exceptions during audio initialization. Process exit
    also releases the OS lock; stale file contents cannot block a later client.
    Keep runtime/voice.lock in place: unlinking it can create two lock domains.
    """
    project = Path(project_dir) if project_dir is not None else Path(__file__).resolve().parents[1]
    file = None
    acquired = False
    try:
        try:
            runtime = project / "runtime"
            runtime.mkdir(parents=True, exist_ok=True)
            file = (runtime / "voice.lock").open("a+b")
            # Windows byte-range locking needs a byte; do not truncate a live file.
            if os.fstat(file.fileno()).st_size == 0:
                file.write(b"\0")
                file.flush()
            _lock(file)
            acquired = True
        except OSError as exc:
            if file is not None and exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise VoiceSessionBusy("Another ShopSwarm voice session is already running for this project.") from None
            raise VoiceLockError("Could not acquire the local ShopSwarm voice session lock.") from None
        yield
    finally:
        if file is not None:
            try:
                if acquired: _unlock(file)
            finally:
                file.close()
