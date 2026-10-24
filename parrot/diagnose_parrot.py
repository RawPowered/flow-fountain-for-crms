"""Secret-safe PARROT startup diagnostic for cPanel's Run Script control."""

import io
import json
import os
import sys
import traceback


APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)


def main():
    report = {
        "pythonVersion": sys.version.split()[0],
        "pythonExecutable": sys.executable,
        "workingDirectory": os.getcwd(),
        "applicationRoot": APP_ROOT,
        "diagnosticFile": os.path.abspath(__file__),
        "requiredFiles": {
            name: os.path.exists(os.path.join(APP_ROOT, name))
            for name in (
                "parrot_app.py",
                "scripts/__init__.py",
                "scripts/handlers.py",
                "scripts/registry.py",
            )
        },
        "tokenConfigured": bool(os.environ.get("PARROT_SERVICE_TOKEN", "").strip()),
    }
    try:
        from parrot_app import application

        response = {"status": None, "headers": {}}

        def start_response(status, headers):
            response["status"] = status
            response["headers"] = {str(key).lower(): str(value) for key, value in headers}

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
        report.update({
            "ok": str(response["status"] or "").startswith("200"),
            "wsgiStatus": response["status"],
            "contentType": response["headers"].get("content-type"),
            "body": parsed_body,
        })
    except Exception as error:
        report.update({
            "ok": False,
            "errorType": type(error).__name__,
            "error": str(error),
            "traceback": traceback.format_exc().splitlines()[-20:],
        })
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
