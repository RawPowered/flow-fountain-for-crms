"""Restricted, capability-based runtime for trusted PARROT Studio source."""

from __future__ import annotations

import ast
import hashlib
import ipaddress
import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Set


ALLOWED_CAPABILITIES = frozenset({"network.http", "network.dns"})
BLOCKED_NODES = (
    ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal, ast.ClassDef,
    ast.AsyncFunctionDef, ast.Await, ast.Yield, ast.YieldFrom,
    ast.With, ast.AsyncWith,
)
BLOCKED_CALLS = frozenset({
    "eval", "exec", "compile", "open", "input", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "hasattr", "__import__", "breakpoint",
    "help", "dir", "type", "object", "super", "memoryview",
})
HELPER_CAPABILITIES = {"http_get": "network.http", "dns_lookup": "network.dns"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, code, msg, headers, newurl
        return None


class ManagedSourceError(Exception):
    def __init__(self, message: str, code: str = "PARROT_SOURCE_INVALID") -> None:
        super().__init__(message)
        self.code = code


def source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def normalize_capabilities(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    return sorted({str(value).strip().lower() for value in values if str(value).strip() in ALLOWED_CAPABILITIES})


def validate_source(source: Any, capabilities: Any = None, maximum_bytes: int = 65536) -> Dict[str, Any]:
    text = source if isinstance(source, str) else ""
    caps = normalize_capabilities(capabilities)
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    encoded = text.encode("utf-8")
    if not text.strip():
        errors.append(_issue("PARROT_SOURCE_REQUIRED", "Python source is required"))
    if len(encoded) > maximum_bytes:
        errors.append(_issue("PARROT_SOURCE_TOO_LARGE", f"Python source exceeds {maximum_bytes} bytes"))
    try:
        tree = ast.parse(text or "pass", filename="<parrot-studio>", mode="exec")
    except SyntaxError as error:
        errors.append(_issue("PARROT_SOURCE_SYNTAX", error.msg, error.lineno, error.offset))
        tree = None
    run_functions: List[ast.FunctionDef] = []
    used_helpers: Set[str] = set()
    if tree is not None:
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                if node.name == "run":
                    run_functions.append(node)
                if node.decorator_list:
                    errors.append(_issue("PARROT_SOURCE_DECORATOR_DENIED", "Decorators are not allowed", node.lineno))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                if not _constant_assignment(node):
                    errors.append(_issue("PARROT_SOURCE_TOP_LEVEL_DENIED", "Top-level assignments must use literal constants", getattr(node, "lineno", None)))
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue
            else:
                errors.append(_issue("PARROT_SOURCE_TOP_LEVEL_DENIED", "Only function definitions and literal constants are allowed at module scope", getattr(node, "lineno", None)))
        for node in ast.walk(tree):
            if isinstance(node, BLOCKED_NODES):
                errors.append(_issue("PARROT_SOURCE_NODE_DENIED", f"{type(node).__name__} is not allowed", getattr(node, "lineno", None)))
            if isinstance(node, ast.Attribute) and str(node.attr).startswith("_"):
                errors.append(_issue("PARROT_SOURCE_PRIVATE_ACCESS", "Private and dunder attributes are not allowed", getattr(node, "lineno", None)))
            if isinstance(node, ast.Name) and str(node.id).startswith("__"):
                errors.append(_issue("PARROT_SOURCE_PRIVATE_ACCESS", "Dunder names are not allowed", getattr(node, "lineno", None)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                name = node.func.id
                if name in BLOCKED_CALLS:
                    errors.append(_issue("PARROT_SOURCE_CALL_DENIED", f"{name}() is not allowed", getattr(node, "lineno", None)))
                if name in HELPER_CAPABILITIES:
                    used_helpers.add(name)
                    required = HELPER_CAPABILITIES[name]
                    if required not in caps:
                        errors.append(_issue("PARROT_SOURCE_CAPABILITY_REQUIRED", f"{name}() requires capability {required}", getattr(node, "lineno", None)))
            if isinstance(node, ast.FunctionDef) and _has_executable_signature(node):
                errors.append(_issue(
                    "PARROT_SOURCE_SIGNATURE_DENIED",
                    "Function defaults and annotations are not allowed",
                    getattr(node, "lineno", None),
                ))
        if len(run_functions) != 1:
            errors.append(_issue("PARROT_SOURCE_ENTRYPOINT", "Define exactly one run(inputs, context) function"))
        elif not _valid_run_signature(run_functions[0]):
            errors.append(_issue("PARROT_SOURCE_ENTRYPOINT", "run must accept exactly inputs and context", run_functions[0].lineno))
    if not used_helpers:
        warnings.append(_issue("PARROT_SOURCE_TRANSFORM_ONLY", "This version uses transformation-only capabilities"))
    return {
        "valid": not errors,
        "sha256": source_hash(text),
        "bytes": len(encoded),
        "lines": len(text.splitlines()),
        "entrypoint": "run",
        "capabilities": caps,
        "helpers": sorted(used_helpers),
        "errors": _dedupe(errors),
        "warnings": warnings,
    }


def execute_source(source: str, inputs: Dict[str, Any], context: Dict[str, Any], capabilities: Any, timeout_ms: int) -> Any:
    validation = validate_source(source, capabilities)
    if not validation["valid"]:
        first = validation["errors"][0]
        raise ManagedSourceError(first["message"], first["code"])
    caps = set(validation["capabilities"])
    namespace: Dict[str, Any] = {
        "__builtins__": _safe_builtins(),
        "json_encode": lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False),
        "json_decode": json.loads,
        "sha256": lambda value: hashlib.sha256(str(value).encode("utf-8")).hexdigest(),
        "url_parse": _url_parse,
        "dns_lookup": lambda host: _dns_lookup(host, caps),
        "http_get": lambda url, timeout=5: _http_get(url, timeout, caps),
    }
    code = compile(source, "<parrot-studio>", "exec", dont_inherit=True, optimize=1)
    exec(code, namespace, namespace)
    runner = namespace.get("run")
    if not callable(runner):
        raise ManagedSourceError("run(inputs, context) was not created", "PARROT_SOURCE_ENTRYPOINT")
    return _run_with_deadline(runner, inputs, context, timeout_ms)


def _run_with_deadline(runner: Any, inputs: Dict[str, Any], context: Dict[str, Any], timeout_ms: int) -> Any:
    deadline = time.monotonic() + max(0.1, min(float(timeout_ms) / 1000.0, 30.0))
    previous = sys.gettrace()

    def tracer(frame: Any, event: str, arg: Any) -> Any:
        del frame, event, arg
        if time.monotonic() > deadline:
            raise ManagedSourceError("Managed script exceeded its runtime limit", "PARROT_SCRIPT_TIMEOUT")
        return tracer

    sys.settrace(tracer)
    try:
        return runner(inputs, context)
    finally:
        sys.settrace(previous)


def _safe_builtins() -> Dict[str, Any]:
    return {
        "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
        "enumerate": enumerate, "float": float, "int": int, "len": len,
        "list": list, "max": max, "min": min, "range": _safe_range,
        "reversed": reversed, "round": round, "set": set, "sorted": sorted,
        "str": str, "sum": sum, "tuple": tuple, "zip": zip,
        "Exception": Exception, "ValueError": ValueError, "KeyError": KeyError,
    }


def _safe_range(*values: int) -> range:
    result = range(*values)
    if len(result) > 100000:
        raise ManagedSourceError("range() is limited to 100000 items", "PARROT_SOURCE_RESOURCE_LIMIT")
    return result


def _url_parse(value: Any) -> Dict[str, Any]:
    parsed = urllib.parse.urlsplit(str(value))
    return {"scheme": parsed.scheme, "host": parsed.hostname, "port": parsed.port, "path": parsed.path, "query": parsed.query}


def _dns_lookup(host: Any, capabilities: Set[str]) -> List[str]:
    if "network.dns" not in capabilities:
        raise ManagedSourceError("dns_lookup requires network.dns", "PARROT_SOURCE_CAPABILITY_REQUIRED")
    clean = _allowed_host(host)
    addresses = _public_addresses(clean)
    return sorted(addresses)


def _http_get(url: Any, timeout: Any, capabilities: Set[str]) -> Dict[str, Any]:
    if "network.http" not in capabilities:
        raise ManagedSourceError("http_get requires network.http", "PARROT_SOURCE_CAPABILITY_REQUIRED")
    parsed = urllib.parse.urlsplit(str(url))
    allow_http = os.environ.get("PARROT_RECON_ALLOW_HTTP", "false").lower() == "true"
    if parsed.scheme not in ({"https", "http"} if allow_http else {"https"}) or not parsed.hostname:
        raise ManagedSourceError("http_get requires an allowed HTTPS URL", "PARROT_RECON_URL_DENIED")
    if parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        raise ManagedSourceError("URL credentials and nonstandard ports are not allowed", "PARROT_RECON_URL_DENIED")
    _public_addresses(_allowed_host(parsed.hostname))
    request = urllib.request.Request(str(url), headers={"Accept": "application/json,text/plain,text/html", "User-Agent": "Workbench-PARROT/1.0"}, method="GET")
    seconds = max(0.5, min(float(timeout), 10.0))
    try:
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=seconds) as response:
            maximum = min(max(int(os.environ.get("PARROT_RECON_MAX_BYTES", "262144")), 1024), 1048576)
            body = response.read(maximum + 1)
            if len(body) > maximum:
                raise ManagedSourceError("Recon response exceeded its byte limit", "PARROT_RECON_RESPONSE_TOO_LARGE")
            headers = {key.lower(): value[:1000] for key, value in response.headers.items() if key.lower() in {"content-type", "content-length", "etag", "last-modified", "server"}}
            return {"status": int(response.status), "url": response.geturl(), "headers": headers, "body": body.decode("utf-8", errors="replace")}
    except ManagedSourceError:
        raise
    except Exception as error:
        raise ManagedSourceError(f"Recon request failed: {type(error).__name__}", "PARROT_RECON_REQUEST_FAILED") from error


def _allowed_host(value: Any) -> str:
    host = str(value or "").strip().lower().rstrip(".")
    patterns = [item.strip().lower().rstrip(".") for item in os.environ.get("PARROT_RECON_ALLOWED_HOSTS", "").split(",") if item.strip()]
    allowed = any(host == pattern or (pattern.startswith("*.") and host.endswith(pattern[1:]) and host != pattern[2:]) for pattern in patterns)
    if not host or not allowed:
        raise ManagedSourceError("Host is not in PARROT_RECON_ALLOWED_HOSTS", "PARROT_RECON_HOST_DENIED")
    return host


def _public_addresses(host: str) -> Set[str]:
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise ManagedSourceError("Host could not be resolved", "PARROT_RECON_DNS_FAILED") from error
    if not addresses:
        raise ManagedSourceError("Host did not resolve", "PARROT_RECON_DNS_FAILED")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if not address.is_global:
            raise ManagedSourceError("Private, local, and reserved addresses are denied", "PARROT_RECON_ADDRESS_DENIED")
    return addresses


def _valid_run_signature(node: ast.FunctionDef) -> bool:
    args = node.args
    return not args.vararg and not args.kwarg and not args.kwonlyargs and len(args.args) == 2 and [item.arg for item in args.args] == ["inputs", "context"]


def _has_executable_signature(node: ast.FunctionDef) -> bool:
    args = node.args
    positional = [*getattr(args, "posonlyargs", []), *args.args, *args.kwonlyargs]
    return bool(
        args.defaults or any(value is not None for value in args.kw_defaults)
        or node.returns is not None or any(item.annotation is not None for item in positional)
        or (args.vararg is not None and args.vararg.annotation is not None)
        or (args.kwarg is not None and args.kwarg.annotation is not None)
    )


def _constant_assignment(node: Any) -> bool:
    value = node.value
    try:
        ast.literal_eval(value)
        return True
    except Exception:
        return False


def _issue(code: str, message: str, line: Any = None, column: Any = None) -> Dict[str, Any]:
    return {"code": code, "message": message, "line": line, "column": column}


def _dedupe(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    seen = set()
    for item in items:
        key = (item["code"], item["message"], item.get("line"))
        if key not in seen:
            seen.add(key)
            output.append(item)
    return output[:100]


__all__ = ["ManagedSourceError", "validate_source", "execute_source", "source_hash", "normalize_capabilities"]
