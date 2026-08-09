"""Capability document construction on Live's main thread."""

from __future__ import absolute_import, unicode_literals

import hashlib

from .messages import PROTOCOL_VERSION
from .protocol import DEFAULT_MAX_FRAME_BYTES

REMOTE_SCRIPT_VERSION = "0.2.0"


def build_capability_document(application, song, registry, max_batch_items=128):
    live_version = application.get_version_string()
    project_source = getattr(song, "file_path", "") or getattr(
        song, "name", "untitled"
    )
    project_source = str(project_source)
    project_id = hashlib.sha256(project_source.encode("utf-8")).hexdigest()[:24]
    capabilities = {name: True for name in registry.metadata()}
    tracks = list(song.tracks)
    arrangement_support = {
        "arrangement.create_midi_clip": any(
            hasattr(track, "arrangement_clips")
            and hasattr(track, "create_midi_clip")
            and hasattr(track, "delete_clip")
            for track in tracks
        ),
        "arrangement.inspect": not tracks
        or any(hasattr(track, "arrangement_clips") for track in tracks),
        "arrangement.delete_clip": any(
            hasattr(track, "arrangement_clips")
            and hasattr(track, "delete_clip")
            for track in tracks
        ),
    }
    for name, supported in arrangement_support.items():
        if name in capabilities:
            capabilities[name] = supported
    return {
        "selectedProtocolVersion": PROTOCOL_VERSION,
        "liveVersion": live_version,
        "remoteScriptVersion": REMOTE_SCRIPT_VERSION,
        "projectId": project_id,
        "capabilities": capabilities,
        "limits": {
            "maxFrameBytes": DEFAULT_MAX_FRAME_BYTES,
            "maxBatchItems": max_batch_items,
        },
    }
