"""Protocol envelope validation and response construction."""

from __future__ import absolute_import, unicode_literals

from .version import PROTOCOL_VERSION

try:
    STRING_TYPES = (basestring,)
except NameError:
    STRING_TYPES = (str,)


def validate_request(message):
    if not isinstance(message, dict):
        return "Request must be an object"
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        return "Unsupported protocol version"
    if message.get("kind") != "request":
        return "Message kind must be request"
    if not isinstance(message.get("requestId"), STRING_TYPES):
        return "requestId must be a string"
    if (
        not isinstance(message.get("command"), STRING_TYPES)
        or not message["command"]
    ):
        return "command must be a non-empty string"
    if not isinstance(message.get("params"), dict):
        return "params must be an object"
    return None


def select_protocol_version(supported_versions, available_versions=None):
    available = set(available_versions or (PROTOCOL_VERSION,))
    compatible = set(
        version
        for version in supported_versions
        if isinstance(version, int) and version in available
    )
    return max(compatible) if compatible else None


def success(request, result, warnings=None, project_revision=None):
    message = {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request.get("requestId", "00000000-0000-0000-0000-000000000000"),
        "ok": True,
        "result": result,
        "warnings": warnings or [],
    }
    if project_revision is not None:
        message["projectRevision"] = project_revision
    return message


def event(name, sequence, payload, project_revision=None):
    message = {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "event",
        "event": name,
        "sequence": sequence,
        "payload": payload,
    }
    if project_revision is not None:
        message["projectRevision"] = project_revision
    return message


def failure(request, code, message, retryable=False, details=None):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "requestId": request.get("requestId", "00000000-0000-0000-0000-000000000000"),
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "details": details or {},
        },
    }
