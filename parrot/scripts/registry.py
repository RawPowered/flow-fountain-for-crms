"""Allowlisted PARROT script registry.

Add reviewed handlers here. PARROT never imports a module or function name supplied
by a request.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .handlers import normalize_text, summarize_records, system_echo


_SCRIPTS: Dict[str, Dict[str, Any]] = {
    "system.echo": {
        "id": "system.echo",
        "version": "1.0.0",
        "name": "Echo diagnostic",
        "description": "Returns sanitized inputs for authenticated bridge verification.",
        "owner": "Data Architecture",
        "sources": ["hawk", "eagle", "owl", "admin"],
        "modes": ["dry_run"],
        "timeoutMs": 1000,
        "dataSensitivity": "internal",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "outputSchema": {"type": "object"},
        "handler": system_echo,
    },
    "text.normalize": {
        "id": "text.normalize",
        "version": "1.0.0",
        "name": "Normalize text",
        "description": "Collapses whitespace and applies an optional case transform.",
        "owner": "Data Architecture",
        "sources": ["hawk", "eagle", "owl", "admin"],
        "modes": ["dry_run", "live"],
        "timeoutMs": 1000,
        "dataSensitivity": "internal",
        "inputSchema": {
            "type": "object",
            "required": ["text"],
            "properties": {
                "text": {"type": "string", "maxLength": 16000},
                "case": {"type": "string", "enum": ["preserve", "lower", "upper", "title"]},
            },
        },
        "outputSchema": {"type": "object"},
        "handler": normalize_text,
    },
    "records.summarize": {
        "id": "records.summarize",
        "version": "1.0.0",
        "name": "Summarize records",
        "description": "Counts supplied records and optionally groups them by one field.",
        "owner": "Data Architecture",
        "sources": ["hawk", "eagle", "owl", "admin"],
        "modes": ["dry_run", "live"],
        "timeoutMs": 5000,
        "dataSensitivity": "internal",
        "inputSchema": {
            "type": "object",
            "required": ["records"],
            "properties": {
                "records": {"type": "array", "maxItems": 5000},
                "groupBy": {"type": "string", "maxLength": 128},
            },
        },
        "outputSchema": {"type": "object"},
        "handler": summarize_records,
    },
}


def get_script(script_id: str) -> Optional[Dict[str, Any]]:
    return _SCRIPTS.get(script_id)


def public_catalog():
    return [
        {key: value for key, value in script.items() if key != "handler"}
        for script in sorted(_SCRIPTS.values(), key=lambda item: item["id"])
    ]
