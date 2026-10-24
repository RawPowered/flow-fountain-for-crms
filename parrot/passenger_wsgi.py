"""Namecheap Passenger entry point for PARROT."""

import json
import io
import os
import sys
import traceback


# Passenger does not consistently start with the application root as the
# process working directory. Resolve imports relative to this file instead.
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

try:
    from parrot_app import application
except Exception:
    # Preserve the traceback in Namecheap's application log while still
    # returning the PARROT JSON contract to the Node control plane.
    traceback.print_exc()

    def application(_environ, start_response):
        body = json.dumps({
            "ok": False,
            "service": "parrot",
            "ready": False,
            "error": "PARROT failed to load; inspect the Python application log",
            "code": "PARROT_STARTUP_FAILED",
        }, separators=(",", ":")).encode("utf-8")
        start_response("500 Internal Server Error", [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ])
        return [body]


def _self_test():
    """Print a secret-safe startup report for cPanel's Run Script control."""
    response = {"status": None, "headers": {}}

    def start_response(status, headers):
        response["status"] = status
        response["headers"] = {str(key).lower(): str(value) for key, value in headers}

    try:
        body = b"".join(application({
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/healthz",
            "CONTENT_LENGTH": "0",
            "wsgi.input": io.BytesIO(b""),
        }, start_response))
        try:
            parsed_body = json.loads(body.decode("utf-8"))
        except Exception:
            parsed_body = body.decode("utf-8", errors="replace")[:500]
        report = {
            "ok": str(response["status"] or "").startswith("200"),
            "pythonVersion": sys.version.split()[0],
            "pythonExecutable": sys.executable,
            "workingDirectory": os.getcwd(),
            "applicationRoot": APP_ROOT,
            "startupFile": os.path.abspath(__file__),
            "requiredFiles": {
                name: os.path.exists(os.path.join(APP_ROOT, name))
                for name in (
                    "passenger_wsgi.py",
                    "parrot_app.py",
                    "scripts/__init__.py",
                    "scripts/handlers.py",
                    "scripts/registry.py",
                )
            },
            "tokenConfigured": bool(os.environ.get("PARROT_SERVICE_TOKEN", "").strip()),
            "wsgiStatus": response["status"],
            "contentType": response["headers"].get("content-type"),
            "body": parsed_body,
        }
    except Exception as error:
        report = {
            "ok": False,
            "pythonVersion": sys.version.split()[0],
            "applicationRoot": APP_ROOT,
            "startupFile": os.path.abspath(__file__),
            "errorType": type(error).__name__,
            "error": str(error),
            "traceback": traceback.format_exc().splitlines()[-20:],
        }
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _self_test()

__all__ = ["application"]
