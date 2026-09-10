"""The frozen executable's entry point.

Kept separate from the package so PyInstaller has a single script to analyse,
and so the role dispatch itself stays importable and testable from a checkout.
"""

import multiprocessing
import sys

from hozayt.__main__ import main

if __name__ == "__main__":
    # A frozen program that ever spawns a process needs this before anything
    # else, or the child re-runs the whole program instead of its target.
    multiprocessing.freeze_support()
    sys.exit(main())
