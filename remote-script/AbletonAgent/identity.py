"""Live Set and Live Project identity derived from the current LOM Song."""

from __future__ import absolute_import, unicode_literals

import hashlib
import os
import uuid


MAX_IDENTITY_DIAGNOSTICS = 4
MAX_IDENTITY_DIAGNOSTIC_MESSAGE_LENGTH = 256
_UNSAVED_IDENTITIES = []


def _lom_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def _hash_identity(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:24]


def _unsaved_live_set_id(song):
    for known_song, live_set_id in _UNSAVED_IDENTITIES:
        if known_song is song:
            return live_set_id
    live_set_id = uuid.uuid4().hex[:24]
    _UNSAVED_IDENTITIES.append((song, live_set_id))
    if len(_UNSAVED_IDENTITIES) > 8:
        del _UNSAVED_IDENTITIES[0]
    return live_set_id


def _nearest_live_project(file_path):
    directory = os.path.dirname(os.path.abspath(file_path))
    while True:
        if os.path.isdir(os.path.join(directory, "Ableton Project Info")):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return None


def _diagnostic(code, message):
    return {
        "code": code,
        "message": str(message)[:MAX_IDENTITY_DIAGNOSTIC_MESSAGE_LENGTH],
    }


def build_live_identity(song):
    file_path = _lom_getattr(song, "file_path", "") or ""
    saved = bool(file_path)
    name = _lom_getattr(song, "name", "untitled")
    identity = {
        "liveSetId": (
            _hash_identity(os.path.abspath(file_path))
            if saved
            else _unsaved_live_set_id(song)
        ),
        "liveSetName": str(name or "Untitled"),
        "saved": saved,
        "diagnostics": [],
    }
    if saved:
        live_project_path = _nearest_live_project(file_path)
        if live_project_path is None:
            identity["diagnostics"].append(
                _diagnostic(
                    "live_project_not_found",
                    "Saved Live Set has no ancestor containing "
                    "'Ableton Project Info'",
                )
            )
        else:
            identity["liveProjectId"] = _hash_identity(live_project_path)
            identity["liveProjectName"] = (
                os.path.basename(live_project_path) or live_project_path
            )[:128]
    identity["diagnostics"] = identity["diagnostics"][
        :MAX_IDENTITY_DIAGNOSTICS
    ]
    return identity
