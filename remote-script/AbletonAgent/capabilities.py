"""Capability document construction on Live's main thread."""

from __future__ import absolute_import, unicode_literals

import hashlib

try:
    from Live.Clip import MidiNoteSpecification
except ImportError:  # pragma: no cover - available only inside Live
    MidiNoteSpecification = None

from .protocol import DEFAULT_MAX_FRAME_BYTES
from .version import PROTOCOL_VERSION, REMOTE_SCRIPT_VERSION


def _lom_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def _lom_hasattr(value, name):
    return _lom_getattr(value, name) is not None


def build_capability_document(
    application,
    song,
    registry,
    max_batch_items=128,
    note_editing_supported=None,
):
    live_version = application.get_version_string()
    project_source = _lom_getattr(song, "file_path", "") or _lom_getattr(
        song, "name", "untitled"
    )
    project_source = str(project_source)
    project_id = hashlib.sha256(project_source.encode("utf-8")).hexdigest()[:24]
    capabilities = {name: True for name in registry.metadata()}
    if note_editing_supported is None:
        note_editing_supported = MidiNoteSpecification is not None
    tracks = list(song.tracks)
    arrangement_support = {
        "arrangement.create_midi_clip": any(
            _lom_hasattr(track, "arrangement_clips")
            and _lom_hasattr(track, "create_midi_clip")
            and _lom_hasattr(track, "delete_clip")
            for track in tracks
        ),
        "arrangement.inspect": not tracks
        or any(_lom_hasattr(track, "arrangement_clips") for track in tracks),
        "arrangement.inspect_notes": not tracks
        or any(_lom_hasattr(track, "arrangement_clips") for track in tracks),
        "arrangement.delete_clip": any(
            _lom_hasattr(track, "arrangement_clips")
            and _lom_hasattr(track, "delete_clip")
            for track in tracks
        ),
        "arrangement.replace_notes": note_editing_supported
        and (
            not tracks
            or any(
                _lom_hasattr(track, "arrangement_clips") for track in tracks
            )
        ),
        "arrangement.duplicate_clip": any(
            _lom_hasattr(track, "arrangement_clips")
            and _lom_hasattr(track, "duplicate_clip_to_arrangement")
            and _lom_hasattr(track, "delete_clip")
            for track in tracks
        ),
        "arrangement.set_clip_properties": not tracks
        or any(_lom_hasattr(track, "arrangement_clips") for track in tracks),
    }
    for name, supported in arrangement_support.items():
        if name in capabilities:
            capabilities[name] = supported
    session_clip_support = {
        "clips.launch": any(
            _lom_hasattr(track, "playing_slot_index")
            and any(
                _lom_hasattr(slot, "fire")
                for slot in _lom_getattr(track, "clip_slots", [])
            )
            for track in tracks
        ),
        "clips.duplicate": any(
            any(
                _lom_hasattr(slot, "duplicate_clip_to")
                for slot in _lom_getattr(track, "clip_slots", [])
            )
            and any(
                _lom_hasattr(slot, "delete_clip")
                for slot in _lom_getattr(track, "clip_slots", [])
            )
            for track in tracks
        ),
        "clips.delete": any(
            any(
                _lom_hasattr(slot, "delete_clip")
                for slot in _lom_getattr(track, "clip_slots", [])
            )
            for track in tracks
        ),
        "clips.set_properties": not tracks
        or any(
            bool(_lom_getattr(track, "clip_slots", [])) for track in tracks
        ),
    }
    for name, supported in session_clip_support.items():
        if name in capabilities:
            capabilities[name] = supported
    if "clips.replace_notes" in capabilities:
        capabilities["clips.replace_notes"] = note_editing_supported
    transport_support = {
        "transport.inspect_arrangement": all(
            _lom_hasattr(song, attribute)
            for attribute in ("loop", "loop_start", "loop_length", "cue_points")
        ),
        "transport.set_arrangement_loop": all(
            _lom_hasattr(song, attribute)
            for attribute in ("loop", "loop_start", "loop_length")
        ),
        "transport.create_cue_point": all(
            _lom_hasattr(song, attribute)
            for attribute in (
                "cue_points",
                "current_song_time",
                "set_or_delete_cue",
            )
        ),
        "transport.delete_cue_point": all(
            _lom_hasattr(song, attribute)
            for attribute in (
                "cue_points",
                "current_song_time",
                "set_or_delete_cue",
            )
        ),
    }
    for name, supported in transport_support.items():
        if name in capabilities:
            capabilities[name] = supported
    rack_api_supported = True
    drum_rack_api_supported = True
    drum_pad_chain_api_supported = True
    device_support = {
        "devices.inspect": not tracks
        or any(_lom_hasattr(track, "devices") for track in tracks),
        "devices.inspect_parameters": not tracks
        or any(_lom_hasattr(track, "devices") for track in tracks),
        "devices.inspect_rack_chains": rack_api_supported,
        "devices.inspect_rack_chain_devices": rack_api_supported,
        "devices.inspect_drum_rack_pads": drum_rack_api_supported,
        "devices.inspect_drum_pad_chains": drum_pad_chain_api_supported,
        "devices.inspect_drum_pad_chain_devices":
            drum_pad_chain_api_supported,
        "devices.set_enabled": not tracks
        or any(_lom_hasattr(track, "devices") for track in tracks),
        "devices.set_parameter": not tracks
        or any(_lom_hasattr(track, "devices") for track in tracks),
    }
    for name, supported in device_support.items():
        if name in capabilities:
            capabilities[name] = supported
    browser = _lom_getattr(application, "browser")
    browser_roots = (
        "sounds",
        "drums",
        "instruments",
        "audio_effects",
        "midi_effects",
        "max_for_live",
        "plugins",
        "clips",
        "samples",
        "packs",
        "user_library",
        "current_project",
    )
    browser_inspection_supported = browser is not None and any(
        _lom_getattr(browser, root) is not None for root in browser_roots
    )
    browser_load_supported = (
        browser_inspection_supported
        and _lom_hasattr(browser, "load_item")
        and _lom_getattr(song, "view") is not None
        and _lom_hasattr(song.view, "selected_track")
        and any(
            _lom_getattr(browser, root) is not None
            for root in ("instruments", "audio_effects", "midi_effects")
        )
    )
    browser_support = {
        "browser.inspect_roots": browser_inspection_supported,
        "browser.inspect_children": browser_inspection_supported,
        "browser.search": browser_inspection_supported,
        "browser.load_item": browser_load_supported,
    }
    for name, supported in browser_support.items():
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
