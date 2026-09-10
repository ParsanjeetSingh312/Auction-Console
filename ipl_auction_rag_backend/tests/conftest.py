"""Pytest configuration: put the package root on sys.path."""
import sys
from pathlib import Path

package_root = str(Path(__file__).resolve().parent.parent)
if package_root not in sys.path:
    sys.path.insert(0, package_root)
