"""PARROT: a small authenticated WSGI bridge for registered Python handlers."""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import io
import json
import os
import re
import time
import uuid
from typing import Any, Callable, Dict, Iterable, Tuple

from scripts.registry import get_script, public_catalog
from scripts.managed_runtime import ManagedSourceError, execute_source, source_hash, validate_source


CONTRACT_VERSION = "parrot.v1"
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,64}$")
SCRIPT_ID_RE = re.compile(r"^[a-z][a-z0-9_.-]{1,95}$")
SOURCE_VALUES = frozenset({"hawk", "eagle", "owl", "admin"})
MODE_VALUES = frozenset({"dry_run", "live"})
SECRET_KEY_RE = re.compile(
    r"authorization|cookie|password|secret|token|credential|api[_-]?key", re.IGNORECASE
)


class ParrotError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "PARROT_REQUEST_INVALID") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _integer_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


def _settings() -> Dict[str, Any]:
    allowed = {
        item.strip().lower()
        for item in os.environ.get("PARROT_ALLOWED_SOURCES", "hawk,eagle,owl,admin").split(",")
        if item.strip().lower() in SOURCE_VALUES
    }
    return {
        "token": os.environ.get("PARROT_SERVICE_TOKEN", "").strip(),
        "allowed_sources": allowed,
        "max_input_bytes": _integer_env("PARROT_MAX_INPUT_BYTES", 131072, 1024, 1048576),
        "max_output_bytes": _integer_env("PARROT_MAX_OUTPUT_BYTES", 65536, 1024, 262144),
        "max_source_bytes": _integer_env("PARROT_MAX_SOURCE_BYTES", 65536, 1024, 131072),
        "default_timeout_ms": _integer_env("PARROT_DEFAULT_TIMEOUT_MS", 5000, 100, 30000),
        "max_timeout_ms": _integer_env("PARROT_MAX_TIMEOUT_MS", 15000, 100, 30000),
    }


def _request_id(environ: Dict[str, Any]) -> str:
    supplied = str(environ.get("HTTP_X_REQUEST_ID", "")).strip()
    return supplied if REQUEST_ID_RE.fullmatch(supplied) else str(uuid.uuid4())


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _respond(start_response: Callable, status: int, payload: Dict[str, Any], request_id: str) -> Iterable[bytes]:
    body = _json_bytes(payload)
    labels = {
        200: "OK",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        411: "Length Required",
        413: "Payload Too Large",
        422: "Unprocessable Entity",
        500: "Internal Server Error",
        503: "Service Unavailable",
    }
    start_response(
        f"{status} {labels.get(status, 'Error')}",
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Request-Id", request_id),
        ],
    )
    return [body]


def _authorized(environ: Dict[str, Any], token: str) -> bool:
    if not token:
        raise ParrotError("PARROT is not configured", 503, "PARROT_NOT_CONFIGURED")
    header = str(environ.get("HTTP_AUTHORIZATION", ""))
    supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
    return bool(supplied) and hmac.compare_digest(supplied.encode(), token.encode())


def _read_json(environ: Dict[str, Any], maximum: int) -> Dict[str, Any]:
    raw_length = str(environ.get("CONTENT_LENGTH", "")).strip()
    if not raw_length:
        raise ParrotError("Content-Length is required", 411, "PARROT_LENGTH_REQUIRED")
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise ParrotError("Content-Length is invalid", 400, "PARROT_LENGTH_INVALID") from exc
    if length < 0 or length > maximum:
        raise ParrotError("Request body is too large", 413, "PARROT_INPUT_TOO_LARGE")
    raw = environ["wsgi.input"].read(length)
    if len(raw) != length:
        raise ParrotError("Request body is incomplete", 400, "PARROT_BODY_INCOMPLETE")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ParrotError("Request body must be valid JSON", 400, "PARROT_JSON_INVALID") from exc
    if not isinstance(value, dict):
        raise ParrotError("Request body must be a JSON object", 400, "PARROT_BODY_INVALID")
    return value


def _safe_data(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[depth-limited]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:16000]
    if isinstance(value, (list, tuple)):
        return [_safe_data(item, depth + 1) for item in value[:200]]
    if isinstance(value, dict):
        output: Dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 200:
                break
            clean_key = str(key)[:191]
            output[clean_key] = "[redacted]" if SECRET_KEY_RE.search(clean_key) else _safe_data(item, depth + 1)
        return output
    return str(value)[:1000]


def _text(value: Any, maximum: int) -> str:
    return str(value or "").strip()[:maximum]


def _run(payload: Dict[str, Any], settings: Dict[str, Any], request_id: str) -> Tuple[int, Dict[str, Any]]:
    contract = _text(payload.get("contractVersion"), 32)
    if contract != CONTRACT_VERSION:
        raise ParrotError("Unsupported PARROT contract version", 400, "PARROT_CONTRACT_UNSUPPORTED")
    run_id = _text(payload.get("runId"), 64) or str(uuid.uuid4())
    source = _text(payload.get("source"), 16).lower()
    mode = _text(payload.get("mode"), 16).lower() or "dry_run"
    script_id = _text(payload.get("scriptId"), 96).lower()
    requested_version = _text(payload.get("scriptVersion"), 32) or None
    inputs = payload.get("inputs", {})
    context = payload.get("context", {})
    if source not in settings["allowed_sources"]:
        raise ParrotError("Source is not allowed", 403, "PARROT_SOURCE_DENIED")
    if mode not in MODE_VALUES:
        raise ParrotError("Mode must be dry_run or live", 400, "PARROT_MODE_INVALID")
    if not SCRIPT_ID_RE.fullmatch(script_id):
        raise ParrotError("Script ID is invalid", 400, "PARROT_SCRIPT_ID_INVALID")
    if not isinstance(inputs, dict) or not isinstance(context, dict):
        raise ParrotError("Inputs and context must be JSON objects", 400, "PARROT_INPUT_INVALID")
    source_package = payload.get("sourcePackage")
    managed = isinstance(source_package, dict)
    script = None if managed else get_script(script_id)
    if not managed and not script:
        raise ParrotError("Registered script was not found", 404, "PARROT_SCRIPT_NOT_FOUND")
    if managed:
        managed_source = source_package.get("source", "")
        validation = validate_source(managed_source, source_package.get("capabilities"), settings["max_source_bytes"])
        if not validation["valid"]:
            first = validation["errors"][0]
            raise ParrotError(first["message"], 422, first["code"])
        expected_hash = _text(source_package.get("sha256"), 64).lower()
        if not expected_hash or expected_hash != source_hash(managed_source):
            raise ParrotError("Managed source hash does not match", 409, "PARROT_SOURCE_HASH_MISMATCH")
        if mode == "live" and source_package.get("approved") is not True:
            raise ParrotError("Live managed source must be approved", 403, "PARROT_SOURCE_APPROVAL_REQUIRED")
        script_version = _text(source_package.get("version"), 32) or requested_version or expected_hash[:12]
    else:
        validation = None
        if requested_version and requested_version != script["version"]:
            raise ParrotError("Requested script version is unavailable", 404, "PARROT_SCRIPT_VERSION_NOT_FOUND")
        if source not in script["sources"] or mode not in script["modes"]:
            raise ParrotError("Script does not permit this source or mode", 403, "PARROT_SCRIPT_POLICY_DENIED")
        script_version = script["version"]
    requested_timeout = payload.get("limits", {}).get("timeoutMs") if isinstance(payload.get("limits"), dict) else None
    try:
        requested_timeout_ms = int(requested_timeout or (script or {}).get("timeoutMs") or settings["default_timeout_ms"])
    except (TypeError, ValueError):
        requested_timeout_ms = settings["default_timeout_ms"]
    timeout_ms = min(max(requested_timeout_ms, 100), settings["max_timeout_ms"], int((script or {}).get("timeoutMs", settings["max_timeout_ms"])))
    safe_inputs = _safe_data(inputs)
    safe_context = _safe_data(context)
    started = time.monotonic()
    captured_out, captured_err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_err):
            execution_context = {
                **safe_context,
                "requestId": request_id,
                "runId": run_id,
                "source": source,
                "mode": mode,
                "dryRun": mode == "dry_run",
            }
            output = execute_source(managed_source, safe_inputs, execution_context, validation["capabilities"], timeout_ms) if managed else script["handler"](safe_inputs, execution_context)
    except ParrotError:
        raise
    except ManagedSourceError as exc:
        raise ParrotError(str(exc), 422, exc.code) from exc
    except Exception as exc:
        raise ParrotError("Registered script execution failed", 422, "PARROT_SCRIPT_FAILED") from exc
    duration_ms = round((time.monotonic() - started) * 1000)
    if duration_ms > timeout_ms:
        raise ParrotError("Registered script exceeded its runtime limit", 422, "PARROT_SCRIPT_TIMEOUT")
    safe_output = _safe_data(output)
    output_bytes = len(_json_bytes(safe_output))
    if output_bytes > settings["max_output_bytes"]:
        raise ParrotError("Script output is too large", 413, "PARROT_OUTPUT_TOO_LARGE")
    captured_bytes = len(captured_out.getvalue().encode("utf-8")) + len(captured_err.getvalue().encode("utf-8"))
    return 200, {
        "ok": True,
        "contractVersion": CONTRACT_VERSION,
        "requestId": request_id,
        "runId": run_id,
        "status": "completed",
        "script": {"id": script_id, "version": script_version, "managed": managed},
        "output": safe_output,
        "metrics": {
            "durationMs": duration_ms,
            "outputBytes": output_bytes,
            "capturedLogBytes": captured_bytes,
        },
        "warnings": validation["warnings"] if managed else [],
    }


def application(environ: Dict[str, Any], start_response: Callable) -> Iterable[bytes]:
    request_id = _request_id(environ)
    settings = _settings()
    method = str(environ.get("REQUEST_METHOD", "GET")).upper()
    path = str(environ.get("PATH_INFO", "/")).rstrip("/") or "/"
    try:
        if path == "/healthz":
            if method != "GET":
                raise ParrotError("Method not allowed", 405, "PARROT_METHOD_NOT_ALLOWED")
            return _respond(start_response, 200, {
                "ok": True,
                "service": "parrot",
                "contractVersion": CONTRACT_VERSION,
                "ready": bool(settings["token"]),
            }, request_id)
        if path not in {"/v1/catalog", "/v1/runs", "/v1/source/validate"}:
            raise ParrotError("Not found", 404, "PARROT_NOT_FOUND")
        if not _authorized(environ, settings["token"]):
            raise ParrotError("Unauthorized", 401, "PARROT_UNAUTHORIZED")
        if path == "/v1/catalog":
            if method != "GET":
                raise ParrotError("Method not allowed", 405, "PARROT_METHOD_NOT_ALLOWED")
            return _respond(start_response, 200, {
                "ok": True,
                "contractVersion": CONTRACT_VERSION,
                "scripts": public_catalog(),
            }, request_id)
        if path == "/v1/source/validate":
            if method != "POST":
                raise ParrotError("Method not allowed", 405, "PARROT_METHOD_NOT_ALLOWED")
            payload = _read_json(environ, settings["max_input_bytes"])
            return _respond(start_response, 200, {
                "ok": True,
                "contractVersion": CONTRACT_VERSION,
                "requestId": request_id,
                "validation": validate_source(payload.get("source"), payload.get("capabilities"), settings["max_source_bytes"]),
            }, request_id)
        if method != "POST":
            raise ParrotError("Method not allowed", 405, "PARROT_METHOD_NOT_ALLOWED")
        payload = _read_json(environ, settings["max_input_bytes"])
        status, result = _run(payload, settings, request_id)
        return _respond(start_response, status, result, request_id)
    except ParrotError as error:
        return _respond(start_response, error.status, {
            "ok": False,
            "contractVersion": CONTRACT_VERSION,
            "requestId": request_id,
            "error": str(error),
            "code": error.code,
        }, request_id)
    except Exception:
        return _respond(start_response, 500, {
            "ok": False,
            "contractVersion": CONTRACT_VERSION,
            "requestId": request_id,
            "error": "PARROT encountered an internal error",
            "code": "PARROT_INTERNAL_ERROR",
        }, request_id)


__all__ = ["application", "CONTRACT_VERSION", "ParrotError"]
