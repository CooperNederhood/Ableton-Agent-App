"""Capability document construction on Live's main thread."""

from __future__ import absolute_import, unicode_literals

try:
    from Live.Clip import MidiNoteSpecification
except ImportError:  # pragma: no cover - available only inside Live
    MidiNoteSpecification = None

try:
    from Live.Clip import Clip as LiveClip
except ImportError:  # pragma: no cover - available only inside Live
    LiveClip = None

try:
    from Live.Song import CuePoint as LiveCuePoint
except ImportError:  # pragma: no cover - available only inside Live
    LiveCuePoint = None

from .protocol import DEFAULT_MAX_FRAME_BYTES
from .identity import build_project_identity
from .version import PROTOCOL_VERSION, REMOTE_SCRIPT_VERSION


def _lom_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def _lom_hasattr(value, name):
    return _lom_getattr(value, name) is not None


def _lom_callable(value, name):
    return callable(_lom_getattr(value, name))


def _lom_exposes(value, name):
    marker = object()
    return _lom_getattr(value, name, marker) is not marker


def build_capability_document(
    application,
    song,
    registry,
    max_batch_items=128,
    note_editing_supported=None,
):
    live_version = application.get_version_string()
    project_identity = build_project_identity(song)
    capabilities = {name: True for name in registry.metadata()}
    for grouped_command in (
        "scenes.inspect",
        "scenes.mutate",
        "tracks.inspect",
        "tracks.mutate",
        "mixer_routing.inspect",
        "mixer_routing.mutate",
        "transport.inspect",
        "transport.mutate",
        "midi_notes.inspect",
        "midi_notes.mutate",
        "audio_clips.inspect",
        "audio_clips.mutate",
    ):
        capabilities.pop(grouped_command, None)
    tracks = list(song.tracks)
    capabilities.update({
        "events.parameter.value_changed": any(
            any(
                any(
                    _lom_hasattr(parameter, "add_value_listener")
                    for parameter in _lom_getattr(device, "parameters", [])
                )
                for device in _lom_getattr(track, "devices", [])
            )
            for track in tracks
        ),
        "events.track.playing_clip_changed": any(
            _lom_hasattr(track, "add_playing_slot_index_listener")
            for track in tracks
        ),
        "events.track.triggered_clip_changed": any(
            _lom_hasattr(track, "add_fired_slot_index_listener")
            for track in tracks
        ),
        "events.track.recording_state_changed": any(
            _lom_hasattr(track, "add_playing_slot_index_listener")
            for track in tracks
        ),
    })
    if note_editing_supported is None:
        note_editing_supported = MidiNoteSpecification is not None
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
    cue_points = list(_lom_getattr(song, "cue_points", []) or [])
    cue_point_api = LiveCuePoint
    if cue_point_api is None and cue_points:
        cue_point_api = cue_points[0]
    cue_name_supported = _lom_exposes(cue_point_api, "name")
    cue_time_supported = _lom_exposes(cue_point_api, "time")
    cue_jump_supported = _lom_callable(cue_point_api, "jump") or (
        cue_time_supported and _lom_exposes(song, "current_song_time")
    )
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
    racks = [
        device
        for track in tracks
        for device in _lom_getattr(track, "devices", [])
        if bool(_lom_getattr(device, "can_have_chains", False))
    ]
    chains = [
        chain
        for rack in racks
        for chain in _lom_getattr(rack, "chains", [])
    ]
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
        "devices.find_position": _lom_callable(
            song, "find_device_position"
        ),
        "devices.inspect_chain_mixer": not chains
        or any(
            _lom_hasattr(chain, "mute")
            and _lom_hasattr(chain, "solo")
            and _lom_getattr(chain, "mixer_device") is not None
            for chain in chains
        ),
        "devices.move": _lom_callable(song, "find_device_position")
        and _lom_callable(song, "move_device"),
        "devices.set_chain_properties": not chains
        or any(
            all(_lom_exposes(chain, attribute) for attribute in (
                "name",
                "color",
                "color_index",
            ))
            for chain in chains
        ),
        "devices.set_chain_mixer": not chains
        or any(
            _lom_hasattr(chain, "mute")
            and _lom_hasattr(chain, "solo")
            and _lom_getattr(chain, "mixer_device") is not None
            for chain in chains
        ),
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
    return_tracks = list(_lom_getattr(song, "return_tracks", []) or [])
    master_track = _lom_getattr(song, "master_track")
    all_tracks = tracks + return_tracks + (
        [master_track] if master_track is not None else []
    )
    scenes = list(_lom_getattr(song, "scenes", []) or [])
    scene_support = {
        "scenes.list": _lom_exposes(song, "scenes"),
        "scenes.get": bool(scenes),
        "scenes.create": _lom_callable(song, "create_scene"),
        "scenes.duplicate": bool(scenes)
        and _lom_callable(song, "duplicate_scene"),
        "scenes.rename": any(_lom_exposes(scene, "name") for scene in scenes),
        "scenes.set_color": any(
            _lom_exposes(scene, "color_index") for scene in scenes
        ),
        "scenes.set_tempo_time_signature": any(
            all(
                _lom_exposes(scene, attribute)
                for attribute in (
                    "tempo",
                    "tempo_enabled",
                    "time_signature_numerator",
                    "time_signature_denominator",
                    "time_signature_enabled",
                )
            )
            for scene in scenes
        ),
        "scenes.fire": any(
            _lom_callable(scene, "fire")
            and _lom_exposes(scene, "is_triggered")
            for scene in scenes
        ),
        "scenes.delete": bool(scenes)
        and _lom_callable(song, "delete_scene"),
    }
    track_support = {
        "tracks.list": _lom_exposes(song, "tracks"),
        "tracks.get": bool(all_tracks),
        "tracks.create_return": _lom_callable(song, "create_return_track"),
        "tracks.duplicate": bool(tracks)
        and _lom_callable(song, "duplicate_track"),
        "tracks.set_color": any(
            _lom_exposes(track, "color_index") for track in all_tracks
        ),
        "tracks.set_monitoring": any(
            _lom_exposes(track, "current_monitoring_state")
            for track in tracks
        ),
        "tracks.set_fold": any(
            bool(_lom_getattr(track, "is_foldable", False))
            and _lom_exposes(track, "fold_state")
            for track in tracks
        ),
        "tracks.stop_clips": any(
            _lom_callable(track, "stop_all_clips")
            and _lom_exposes(track, "playing_slot_index")
            for track in tracks
        ),
        "tracks.back_to_arrangement": any(
            _lom_exposes(track, "back_to_arranger") for track in tracks
        ),
        "tracks.delete": _lom_callable(song, "delete_track")
        and _lom_callable(song, "delete_return_track"),
    }
    mixer_devices = [
        _lom_getattr(track, "mixer_device") for track in all_tracks
    ]
    mixer_devices = [mixer for mixer in mixer_devices if mixer is not None]
    routing_pairs = (
        ("input-type", "available_input_routing_types", "input_routing_type"),
        (
            "input-channel",
            "available_input_routing_channels",
            "input_routing_channel",
        ),
        (
            "output-type",
            "available_output_routing_types",
            "output_routing_type",
        ),
        (
            "output-channel",
            "available_output_routing_channels",
            "output_routing_channel",
        ),
    )
    routing_supported = any(
        all(
            _lom_exposes(track, attribute)
            for pair in routing_pairs
            for attribute in pair[1:]
        )
        for track in all_tracks
    )
    mixer_support = {
        "mixer_routing.inspect": any(
            all(
                _lom_exposes(mixer, attribute)
                for attribute in ("volume", "panning", "sends")
            )
            for mixer in mixer_devices
        ),
        "mixer_routing.meters": any(
            any(
                _lom_exposes(track, attribute)
                for attribute in (
                    "input_meter_left",
                    "input_meter_right",
                    "output_meter_left",
                    "output_meter_right",
                )
            )
            for track in all_tracks
        ),
        "mixer_routing.set_volume": any(
            _lom_exposes(mixer, "volume") for mixer in mixer_devices
        ),
        "mixer_routing.set_pan": any(
            _lom_exposes(mixer, "panning") for mixer in mixer_devices
        ),
        "mixer_routing.set_send": any(
            bool(_lom_getattr(mixer, "sends", ())) for mixer in mixer_devices
        ),
        "mixer_routing.set_activator": any(
            _lom_exposes(track, "mute") for track in all_tracks
        ),
        "mixer_routing.set_crossfade_assignment": any(
            _lom_exposes(mixer, "crossfade_assign")
            for mixer in mixer_devices
        ),
        "mixer_routing.set_master_crossfader": (
            master_track is not None
            and _lom_exposes(
                _lom_getattr(master_track, "mixer_device"), "crossfader"
            )
        ),
        "mixer_routing.set_cue_volume": (
            master_track is not None
            and _lom_exposes(
                _lom_getattr(master_track, "mixer_device"), "cue_volume"
            )
        ),
        "mixer_routing.routing_options": routing_supported,
        "mixer_routing.set_routing": routing_supported,
    }
    transport_state_attributes = (
        "current_song_time",
        "is_playing",
        "tempo",
        "signature_numerator",
        "signature_denominator",
        "metronome",
        "clip_trigger_quantization",
        "midi_recording_quantization",
    )
    transport_get = all(
        _lom_exposes(song, attribute)
        for attribute in transport_state_attributes
    ) and _lom_exposes(song, "cue_points")
    transport_support = {
        "transport.get": transport_get,
        "transport.seek": transport_get
        and _lom_exposes(song, "current_song_time"),
        "transport.jump": transport_get and _lom_callable(song, "jump_by"),
        "transport.set_time_signature": transport_get and all(
            _lom_exposes(song, attribute)
            for attribute in ("signature_numerator", "signature_denominator")
        ),
        "transport.set_metronome": transport_get
        and _lom_exposes(song, "metronome"),
        "transport.set_launch_quantization": transport_get and _lom_exposes(
            song, "clip_trigger_quantization"
        ),
        "transport.set_record_quantization": transport_get and _lom_exposes(
            song, "midi_recording_quantization"
        ),
        "transport.set_link": transport_get and _lom_exposes(
            song, "is_ableton_link_enabled"
        ),
        "transport.rename_cue": transport_get and cue_name_supported,
        "transport.jump_to_cue": transport_get and cue_jump_supported,
        "transport.back_to_arrangement": transport_get and _lom_exposes(
            song, "back_to_arranger"
        ),
    }
    clips = []
    for track in tracks:
        for slot in list(_lom_getattr(track, "clip_slots", []) or []):
            if bool(_lom_getattr(slot, "has_clip", False)):
                clips.append(_lom_getattr(slot, "clip"))
        clips.extend(
            list(_lom_getattr(track, "arrangement_clips", []) or [])
        )
    clip_api = LiveClip
    clip_apis = [clip_api] if clip_api is not None else clips

    def clip_api_callable(name):
        return any(_lom_callable(api, name) for api in clip_apis)

    def clip_api_exposes(name):
        return any(_lom_exposes(api, name) for api in clip_apis)

    midi_query = clip_api_callable("get_all_notes_extended")
    midi_support = {
        "midi_notes.query": midi_query,
        "midi_notes.add": note_editing_supported
        and clip_api_callable("add_new_notes"),
        "midi_notes.update": note_editing_supported
        and clip_api_callable("apply_note_modifications"),
        "midi_notes.remove": clip_api_callable("remove_notes_by_id"),
        "midi_notes.duplicate": note_editing_supported
        and clip_api_callable("add_new_notes"),
        "midi_notes.quantize": note_editing_supported
        and clip_api_callable("apply_note_modifications"),
    }
    audio_support = {
        "audio_clips.inspect": all(
            clip_api_exposes(attribute)
            for attribute in ("is_midi_clip", "name", "length")
        ),
        "audio_clips.set_gain": clip_api_exposes("gain"),
        "audio_clips.set_pitch": (
            clip_api_exposes("pitch_coarse")
            and clip_api_exposes("pitch_fine")
        ),
        "audio_clips.set_warp": clip_api_exposes("warping"),
        "audio_clips.set_warp_mode": clip_api_exposes("warp_mode"),
        "audio_clips.set_markers": all(
            clip_api_exposes(attribute)
            for attribute in (
                "start_marker",
                "end_marker",
                "loop_start",
                "loop_end",
                "looping",
            )
        ),
        "audio_clips.set_ram_mode": clip_api_exposes("ram_mode"),
        "audio_clips.warp_markers": clip_api_exposes("warp_markers"),
    }
    for support in (
        scene_support,
        track_support,
        mixer_support,
        transport_support,
        midi_support,
        audio_support,
    ):
        capabilities.update(support)
    document = {
        "selectedProtocolVersion": PROTOCOL_VERSION,
        "liveVersion": live_version,
        "remoteScriptVersion": REMOTE_SCRIPT_VERSION,
        "capabilities": capabilities,
        "limits": {
            "maxFrameBytes": DEFAULT_MAX_FRAME_BYTES,
            "maxBatchItems": max_batch_items,
        },
    }
    document.update(project_identity)
    return document
