"""Live Set identity derived from the current LOM Song."""

from __future__ import absolute_import, unicode_literals

import hashlib


def _lom_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def build_project_identity(song):
    file_path = _lom_getattr(song, "file_path", "") or ""
    saved = bool(file_path)
    name = _lom_getattr(song, "name", "untitled")
    identity_source = file_path if saved else name
    identity_source = str(identity_source)
    project_name = str(name or "Untitled")
    return {
        "projectId": hashlib.sha256(
            identity_source.encode("utf-8")
        ).hexdigest()[:24],
        "projectName": project_name,
        "saved": saved,
    }
