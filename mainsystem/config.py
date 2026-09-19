import os
from pathlib import Path


def load_env(path: str = ".env") -> None:
    """Load plain KEY=value entries; never execute a shell or override the environment."""
    file = Path(path)
    if not file.exists():
        return
    for line in file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not key.strip().replace("_", "").isalnum():
            raise ValueError("Invalid .env entry")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)
