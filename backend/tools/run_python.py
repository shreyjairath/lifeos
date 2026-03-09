"""Execute a Python snippet in a subprocess."""
import subprocess
import sys


def run_python(code: str) -> dict:
    """Run code using the current venv Python and return {stdout, stderr, returncode}."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "Timeout: execution exceeded 10 seconds", "returncode": -1}
