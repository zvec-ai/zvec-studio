"""Version metadata for zvec-studio."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("zvec-studio")
except PackageNotFoundError:
    # Running from source without pip install (e.g. dev mode).
    __version__ = "0.0.0.dev0"
