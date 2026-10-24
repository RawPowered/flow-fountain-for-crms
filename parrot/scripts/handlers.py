"""Small reference handlers and the stable handler signature used by PARROT."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, Dict


def system_echo(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    return {"received": inputs, "mode": context.get("mode"), "source": context.get("source")}


def normalize_text(inputs: Dict[str, Any], _context: Dict[str, Any]) -> Dict[str, Any]:
    text = str(inputs.get("text", ""))[:16000]
    whitespace = re.sub(r"\s+", " ", text).strip()
    mode = str(inputs.get("case", "preserve")).lower()
    if mode == "lower":
        whitespace = whitespace.lower()
    elif mode == "upper":
        whitespace = whitespace.upper()
    elif mode not in {"preserve", "title"}:
        raise ValueError("Unsupported case mode")
    elif mode == "title":
        whitespace = whitespace.title()
    return {"text": whitespace, "characters": len(whitespace), "words": len(whitespace.split())}


def summarize_records(inputs: Dict[str, Any], _context: Dict[str, Any]) -> Dict[str, Any]:
    records = inputs.get("records", [])
    if not isinstance(records, list):
        raise ValueError("records must be an array")
    if len(records) > 5000:
        raise ValueError("records exceeds the handler limit")
    group_by = str(inputs.get("groupBy", "")).strip()[:128]
    usable = [record for record in records if isinstance(record, dict)]
    result: Dict[str, Any] = {"total": len(records), "objectRecords": len(usable)}
    if group_by:
        counts = Counter(str(record.get(group_by, "Unknown"))[:191] or "Unknown" for record in usable)
        result["groupBy"] = group_by
        result["groups"] = [
            {"value": value, "count": count}
            for value, count in counts.most_common(100)
        ]
    return result
