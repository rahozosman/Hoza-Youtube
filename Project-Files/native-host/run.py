"""Run the production roles from a checkout, without building anything.

    python native-host/run.py --verify
    python native-host/run.py --supervisor
    python native-host/run.py chrome-extension://<id>/

The packaged build enters exactly the same code through `HozaYT.exe`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hozayt.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
