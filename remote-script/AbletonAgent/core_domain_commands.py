"""Live 11 core-domain operations with strict identity and postconditions."""

from __future__ import absolute_import, unicode_literals

import datetime
import math
import time
import uuid

try:
    from Live.Clip import MidiNoteSpecification
except ImportError:  # pragma: no cover - available only inside Live
    MidiNoteSpecification = None

from .errors import ProtocolFailure
from .executor import DeferredResult
from .system_commands import _safe_lom_getattr, _same_lom_object

MAX_BEATS = 1576800
MAX_COLOR_INDEX = 69
ROUTING_SNAPSHOT_SECONDS = 30.0
ROUTING_SNAPSHOT_LIMIT = 64


def _finite(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _integer(value, minimum=None, maximum=None):
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and (minimum is None or value >= minimum)
        and (maximum is None or value <= maximum)
    )


def _number(value, minimum=None, maximum=None, positive=False):
    return (
        _finite(value)
        and (minimum is None or value >= minimum)
        and (maximum is None or value <= maximum)
        and (not positive or value > 0)
    )


def _uuid(value):
    try:
        uuid.UUID(value)
        return isinstance(value, str)
    except (AttributeError, TypeError, ValueError):
        return False


def _name(value, required=False, maximum=128):
    return (
        isinstance(value, str)
        and len(value) <= maximum
        and (not required or bool(value.strip()))
    )


def _strict(value, required, optional=()):
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return set(required).issubset(keys) and keys.issubset(
        set(required) | set(optional)
    )


def _page(params):
    offset = params.get("offset", 0)
    limit = params.get("limit", 64)
    return (
        _integer(offset, 0)
        and _integer(limit, 1, 256)
    )


def _scene_target(value):
    return (
        _strict(
            value,
            ("index", "expectedReference", "expectedName"),
        )
        and _integer(value["index"], 0)
        and _uuid(value["expectedReference"])
        and _name(value["expectedName"])
    )


def _track_target(value, kinds=None):
    if not isinstance(value, dict) or value.get("kind") not in (
        "regular",
        "return",
        "master",
    ):
        return False
    if kinds is not None and value["kind"] not in kinds:
        return False
    if value["kind"] == "master":
        return (
            _strict(value, ("kind", "expectedReference", "expectedName"))
            and _uuid(value["expectedReference"])
            and _name(value["expectedName"])
        )
    return (
        _strict(
            value,
            ("kind", "index", "expectedReference", "expectedName"),
        )
        and _integer(value["index"], 0)
        and _uuid(value["expectedReference"])
        and _name(value["expectedName"])
    )


def _clip_target(value):
    if not isinstance(value, dict) or value.get("view") not in (
        "session",
        "arrangement",
    ):
        return False
    common = (
        _track_target(value.get("track"), ("regular",))
        and _uuid(value.get("expectedClipReference"))
        and _name(value.get("expectedClipName"))
    )
    if value["view"] == "session":
        return (
            common
            and _strict(
                value,
                (
                    "view",
                    "track",
                    "sceneIndex",
                    "expectedClipReference",
                    "expectedClipName",
                ),
            )
            and _integer(value["sceneIndex"], 0)
        )
    return (
        common
        and _strict(
            value,
            (
                "view",
                "track",
                "expectedClipReference",
                "expectedClipName",
                "expectedStartTime",
            ),
        )
        and _number(value["expectedStartTime"], 0, MAX_BEATS)
    )


def _note(value, with_id):
    required = [
        "pitch",
        "startTime",
        "duration",
        "velocity",
        "mute",
        "probability",
        "velocityDeviation",
        "releaseVelocity",
    ]
    if with_id:
        required.insert(0, "noteId")
    return (
        _strict(value, required)
        and (not with_id or _integer(value["noteId"], 0))
        and _integer(value["pitch"], 0, 127)
        and _number(value["startTime"], 0)
        and _number(value["duration"], positive=True)
        and _number(value["velocity"], 0, 127)
        and isinstance(value["mute"], bool)
        and _number(value["probability"], 0, 1)
        and _number(value["velocityDeviation"], -127, 127)
        and _number(value["releaseVelocity"], 0, 127)
    )


def _note_ids(value):
    return (
        isinstance(value, list)
        and 1 <= len(value) <= 2048
        and len(set(value)) == len(value)
        and all(_integer(note_id, 0) for note_id in value)
    )


def validate_scenes(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    valid = False
    if action == "list":
        valid = _strict(params, ("action",), ("offset", "limit")) and _page(params)
    elif action in ("get", "duplicate", "fire", "delete"):
        valid = _strict(params, ("action", "target")) and _scene_target(
            params.get("target")
        )
    elif action == "create":
        valid = (
            _strict(params, ("action", "index"), ("name",))
            and _integer(params.get("index"), -1)
            and (
                "name" not in params
                or _name(params["name"], required=True)
            )
        )
    elif action == "rename":
        valid = (
            _strict(params, ("action", "target", "name"))
            and _scene_target(params.get("target"))
            and _name(params.get("name"), required=True)
        )
    elif action == "set-color":
        valid = (
            _strict(params, ("action", "target", "colorIndex"))
            and _scene_target(params.get("target"))
            and _integer(params.get("colorIndex"), 0, MAX_COLOR_INDEX)
        )
    elif action == "set-tempo-time-signature":
        state = params.get("state")
        valid = (
            _strict(params, ("action", "target", "state"))
            and _scene_target(params.get("target"))
            and isinstance(state, dict)
            and (
                (
                    state.get("kind") == "tempo"
                    and _strict(state, ("kind", "tempo", "enabled"))
                    and _number(state.get("tempo"), 20, 999)
                    and isinstance(state.get("enabled"), bool)
                )
                or (
                    state.get("kind") == "time-signature"
                    and _strict(
                        state,
                        ("kind", "numerator", "denominator", "enabled"),
                    )
                    and _integer(state.get("numerator"), 1, 99)
                    and _integer(state.get("denominator"), 1, 16)
                    and isinstance(state.get("enabled"), bool)
                )
            )
        )
    if not valid:
        return "Invalid scene operation parameters"
    return None


def validate_tracks(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    valid = False
    if action == "list":
        valid = (
            _strict(params, ("action",), ("trackKind", "offset", "limit"))
            and params.get("trackKind", "all")
            in ("regular", "return", "master", "all")
            and _page(params)
        )
    elif action == "get":
        valid = _strict(params, ("action", "target")) and _track_target(
            params.get("target")
        )
    elif action == "create-return":
        valid = (
            _strict(params, ("action",), ("name",))
            and (
                "name" not in params
                or _name(params["name"], required=True)
            )
        )
    elif action == "duplicate":
        valid = _strict(params, ("action", "target")) and _track_target(
            params.get("target"), ("regular",)
        )
    elif action == "set-color":
        valid = (
            _strict(params, ("action", "target", "colorIndex"))
            and _track_target(params.get("target"))
            and _integer(params.get("colorIndex"), 0, MAX_COLOR_INDEX)
        )
    elif action == "set-monitoring":
        valid = (
            _strict(params, ("action", "target", "monitoringState"))
            and _track_target(params.get("target"), ("regular",))
            and _integer(params.get("monitoringState"), 0, 2)
        )
    elif action == "set-fold":
        valid = (
            _strict(params, ("action", "target", "folded"))
            and _track_target(params.get("target"), ("regular",))
            and isinstance(params.get("folded"), bool)
        )
    elif action == "stop-clips":
        valid = (
            _strict(params, ("action", "target"), ("quantized",))
            and _track_target(params.get("target"), ("regular",))
            and isinstance(params.get("quantized", True), bool)
        )
    elif action == "back-to-arrangement":
        valid = _strict(params, ("action", "target")) and _track_target(
            params.get("target"), ("regular",)
        )
    elif action == "delete":
        valid = _strict(params, ("action", "target")) and _track_target(
            params.get("target"), ("regular", "return")
        )
    if not valid:
        return "Invalid track operation parameters"
    return None


def validate_mixer(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    valid = False
    if action in ("inspect", "meters"):
        valid = _strict(params, ("action", "target")) and _track_target(
            params.get("target")
        )
    elif action in (
        "set-volume",
        "set-pan",
        "set-master-crossfader",
        "set-cue-volume",
    ):
        value = params.get("value")
        valid = (
            _strict(params, ("action", "value"))
            and _strict(
                value,
                (
                    "target",
                    "expectedParameterReference",
                    "expectedParameterName",
                    "normalizedValue",
                ),
            )
            and _track_target(value.get("target"))
            and _uuid(value.get("expectedParameterReference"))
            and _name(value.get("expectedParameterName"))
            and _number(value.get("normalizedValue"), 0, 1)
        )
    elif action == "set-send":
        valid = (
            _strict(
                params,
                (
                    "action",
                    "target",
                    "sendIndex",
                    "expectedParameterReference",
                    "expectedParameterName",
                    "normalizedValue",
                ),
            )
            and _track_target(params.get("target"))
            and _integer(params.get("sendIndex"), 0, 63)
            and _uuid(params.get("expectedParameterReference"))
            and _name(params.get("expectedParameterName"))
            and _number(params.get("normalizedValue"), 0, 1)
        )
    elif action == "set-activator":
        valid = (
            _strict(params, ("action", "target", "active"))
            and _track_target(params.get("target"))
            and isinstance(params.get("active"), bool)
        )
    elif action == "set-crossfade-assignment":
        valid = (
            _strict(params, ("action", "target", "assignment"))
            and _track_target(params.get("target"))
            and _integer(params.get("assignment"), 0, 2)
        )
    elif action == "routing-options":
        valid = (
            _strict(params, ("action", "target", "direction"))
            and _track_target(params.get("target"))
            and params.get("direction") in _ROUTING_PROPERTIES
        )
    elif action == "set-routing":
        valid = (
            _strict(
                params,
                (
                    "action",
                    "target",
                    "direction",
                    "snapshotId",
                    "optionToken",
                    "expectedDisplayName",
                ),
            )
            and _track_target(params.get("target"))
            and params.get("direction") in _ROUTING_PROPERTIES
            and _uuid(params.get("snapshotId"))
            and _uuid(params.get("optionToken"))
            and _name(params.get("expectedDisplayName"), maximum=256)
        )
    if not valid:
        return "Invalid mixer-routing operation parameters"
    return None


def _cue_target(value):
    return (
        _strict(
            value,
            ("expectedReference", "expectedName", "expectedTime"),
        )
        and _uuid(value["expectedReference"])
        and _name(value["expectedName"])
        and _number(value["expectedTime"], 0, MAX_BEATS)
    )


def validate_transport(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    valid = False
    if action == "get":
        valid = _strict(params, ("action",), ("offset", "limit")) and _page(params)
    elif action == "seek":
        valid = _strict(params, ("action", "time")) and _number(
            params.get("time"), 0, MAX_BEATS
        )
    elif action == "jump":
        valid = _strict(params, ("action", "beats")) and _number(
            params.get("beats"), -MAX_BEATS, MAX_BEATS
        )
    elif action == "set-time-signature":
        valid = (
            _strict(params, ("action", "numerator", "denominator"))
            and _integer(params.get("numerator"), 1, 99)
            and _integer(params.get("denominator"), 1, 16)
        )
    elif action in ("set-metronome", "set-link"):
        valid = (
            _strict(params, ("action", "enabled"))
            and isinstance(params.get("enabled"), bool)
        )
    elif action in (
        "set-launch-quantization",
        "set-record-quantization",
    ):
        valid = (
            _strict(params, ("action", "quantization"))
            and _integer(params.get("quantization"), 0)
        )
    elif action == "rename-cue":
        valid = (
            _strict(params, ("action", "target", "name"))
            and _cue_target(params.get("target"))
            and _name(params.get("name"), required=True)
        )
    elif action == "jump-to-cue":
        valid = _strict(params, ("action", "target")) and _cue_target(
            params.get("target")
        )
    elif action == "back-to-arrangement":
        valid = _strict(params, ("action",))
    if not valid:
        return "Invalid transport operation parameters"
    return None


def validate_midi(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    target_ok = _clip_target(params.get("target"))
    valid = False
    if action == "query":
        valid = (
            _strict(
                params,
                ("action", "target"),
                (
                    "fromTime",
                    "timeSpan",
                    "fromPitch",
                    "pitchSpan",
                    "offset",
                    "limit",
                ),
            )
            and target_ok
            and _number(params.get("fromTime", 0), 0)
            and _number(params.get("timeSpan", MAX_BEATS), positive=True, maximum=MAX_BEATS)
            and _integer(params.get("fromPitch", 0), 0, 127)
            and _integer(params.get("pitchSpan", 128), 1, 128)
            and _page(params)
        )
    elif action in ("add", "update"):
        notes = params.get("notes")
        valid = (
            _strict(params, ("action", "target", "notes"))
            and target_ok
            and isinstance(notes, list)
            and 1 <= len(notes) <= 2048
            and all(_note(note, action == "update") for note in notes)
        )
    elif action == "remove":
        valid = (
            _strict(params, ("action", "target", "noteIds"))
            and target_ok
            and _note_ids(params.get("noteIds"))
        )
    elif action == "duplicate":
        valid = (
            _strict(
                params,
                ("action", "target", "noteIds", "timeOffset"),
                ("pitchOffset",),
            )
            and target_ok
            and _note_ids(params.get("noteIds"))
            and _finite(params.get("timeOffset"))
            and _integer(params.get("pitchOffset", 0), -127, 127)
        )
    elif action == "quantize":
        valid = (
            _strict(
                params,
                (
                    "action",
                    "target",
                    "noteIds",
                    "gridBeats",
                    "amount",
                ),
            )
            and target_ok
            and _note_ids(params.get("noteIds"))
            and _number(params.get("gridBeats"), positive=True, maximum=64)
            and _number(params.get("amount"), 0, 1)
        )
    if not valid:
        return "Invalid MIDI-note operation parameters"
    return None


def validate_audio(params):
    if not isinstance(params, dict):
        return "params must be an object"
    action = params.get("action")
    target_ok = _clip_target(params.get("target"))
    valid = False
    if action == "inspect":
        valid = _strict(params, ("action", "target")) and target_ok
    elif action == "set-gain":
        valid = (
            _strict(params, ("action", "target", "gain"))
            and target_ok
            and _number(params.get("gain"), 0, 1)
        )
    elif action == "set-pitch":
        valid = (
            _strict(params, ("action", "target", "coarse", "fine"))
            and target_ok
            and _integer(params.get("coarse"), -48, 48)
            and _integer(params.get("fine"), -50, 50)
        )
    elif action == "set-warp":
        valid = (
            _strict(params, ("action", "target", "enabled"))
            and target_ok
            and isinstance(params.get("enabled"), bool)
        )
    elif action == "set-warp-mode":
        valid = (
            _strict(params, ("action", "target", "warpMode"))
            and target_ok
            and _integer(params.get("warpMode"), 0)
        )
    elif action == "set-markers":
        markers = params.get("markers")
        valid = (
            _strict(params, ("action", "target", "markers"))
            and target_ok
            and isinstance(markers, dict)
            and (
                (
                    markers.get("kind") == "start-end"
                    and _strict(
                        markers,
                        ("kind", "startMarker", "endMarker"),
                    )
                    and _number(markers.get("startMarker"), 0)
                    and _number(markers.get("endMarker"), positive=True)
                    and markers["endMarker"] > markers["startMarker"]
                )
                or (
                    markers.get("kind") == "loop"
                    and _strict(
                        markers,
                        ("kind", "loopStart", "loopEnd", "looping"),
                    )
                    and _number(markers.get("loopStart"), 0)
                    and _number(markers.get("loopEnd"), positive=True)
                    and markers["loopEnd"] > markers["loopStart"]
                    and isinstance(markers.get("looping"), bool)
                )
            )
        )
    elif action == "set-ram-mode":
        valid = (
            _strict(params, ("action", "target", "enabled"))
            and target_ok
            and isinstance(params.get("enabled"), bool)
        )
    elif action == "warp-markers":
        valid = (
            _strict(params, ("action", "target"), ("offset", "limit"))
            and target_ok
            and _page(params)
        )
    if not valid:
        return "Invalid audio-clip operation parameters"
    return None


def _validate_action_group(params, validator, actions, command_name):
    error = validator(params)
    if error:
        return error
    if params.get("action") not in actions:
        return "Action is not valid for {0}".format(command_name)
    return None


def validate_scenes_inspect(params):
    return _validate_action_group(
        params, validate_scenes, ("list", "get"), "scenes.inspect"
    )


def validate_scenes_mutate(params):
    return _validate_action_group(
        params,
        validate_scenes,
        (
            "create",
            "duplicate",
            "rename",
            "set-color",
            "set-tempo-time-signature",
            "fire",
            "delete",
        ),
        "scenes.mutate",
    )


def validate_tracks_inspect(params):
    return _validate_action_group(
        params, validate_tracks, ("list", "get"), "tracks.inspect"
    )


def validate_tracks_mutate(params):
    return _validate_action_group(
        params,
        validate_tracks,
        (
            "create-return",
            "duplicate",
            "set-color",
            "set-monitoring",
            "set-fold",
            "stop-clips",
            "back-to-arrangement",
            "delete",
        ),
        "tracks.mutate",
    )


def validate_mixer_inspect(params):
    return _validate_action_group(
        params,
        validate_mixer,
        ("inspect", "meters", "routing-options"),
        "mixer_routing.inspect",
    )


def validate_mixer_mutate(params):
    return _validate_action_group(
        params,
        validate_mixer,
        (
            "set-volume",
            "set-pan",
            "set-send",
            "set-activator",
            "set-crossfade-assignment",
            "set-master-crossfader",
            "set-cue-volume",
            "set-routing",
        ),
        "mixer_routing.mutate",
    )


def validate_transport_inspect(params):
    return _validate_action_group(
        params, validate_transport, ("get",), "transport.inspect"
    )


def validate_transport_mutate(params):
    return _validate_action_group(
        params,
        validate_transport,
        (
            "seek",
            "jump",
            "set-time-signature",
            "set-metronome",
            "set-launch-quantization",
            "set-record-quantization",
            "set-link",
            "rename-cue",
            "jump-to-cue",
            "back-to-arrangement",
        ),
        "transport.mutate",
    )


def validate_midi_inspect(params):
    return _validate_action_group(
        params, validate_midi, ("query",), "midi_notes.inspect"
    )


def validate_midi_mutate(params):
    return _validate_action_group(
        params,
        validate_midi,
        ("add", "update", "remove", "duplicate", "quantize"),
        "midi_notes.mutate",
    )


def validate_audio_inspect(params):
    return _validate_action_group(
        params,
        validate_audio,
        ("inspect", "warp-markers"),
        "audio_clips.inspect",
    )


def validate_audio_mutate(params):
    return _validate_action_group(
        params,
        validate_audio,
        (
            "set-gain",
            "set-pitch",
            "set-warp",
            "set-warp-mode",
            "set-markers",
            "set-ram-mode",
        ),
        "audio_clips.mutate",
    )


def _reference(context, cache_name, value, current_values):
    references = [
        (candidate, reference)
        for candidate, reference in getattr(context, cache_name, [])
        if any(_same_lom_object(candidate, current) for current in current_values)
    ]
    for candidate, reference in references:
        if _same_lom_object(candidate, value):
            setattr(context, cache_name, references)
            return reference
    reference = str(uuid.uuid4())
    references.append((value, reference))
    setattr(context, cache_name, references)
    return reference


def _all_tracks(song):
    return (
        list(_safe_lom_getattr(song, "tracks", ()) or ())
        + list(_safe_lom_getattr(song, "return_tracks", ()) or ())
        + (
            [_safe_lom_getattr(song, "master_track")]
            if _safe_lom_getattr(song, "master_track") is not None
            else []
        )
    )


def _track_reference(context, track):
    return _reference(
        context, "_core_track_references", track, _all_tracks(context.song)
    )


def _scene_reference(context, scene):
    return _reference(
        context,
        "_core_scene_references",
        scene,
        list(_safe_lom_getattr(context.song, "scenes", ()) or ()),
    )


def _parameter_reference(context, parameter):
    parameters = []
    for track in _all_tracks(context.song):
        mixer = _safe_lom_getattr(track, "mixer_device")
        if mixer is None:
            continue
        for name in ("volume", "panning", "crossfader", "cue_volume"):
            candidate = _safe_lom_getattr(mixer, name)
            if candidate is not None:
                parameters.append(candidate)
        parameters.extend(list(_safe_lom_getattr(mixer, "sends", ()) or ()))
    return _reference(
        context, "_core_parameter_references", parameter, parameters
    )


def _clip_reference(context, clip):
    clips = []
    for track in list(_safe_lom_getattr(context.song, "tracks", ()) or ()):
        for slot in list(_safe_lom_getattr(track, "clip_slots", ()) or ()):
            if bool(_safe_lom_getattr(slot, "has_clip", False)):
                clips.append(slot.clip)
        clips.extend(
            list(_safe_lom_getattr(track, "arrangement_clips", ()) or ())
        )
    return _reference(context, "_core_clip_references", clip, clips)


def _cue_reference(context, cue):
    return _reference(
        context,
        "_core_cue_references",
        cue,
        list(_safe_lom_getattr(context.song, "cue_points", ()) or ()),
    )


def _require_attrs(value, names, message, callable_names=()):
    for name in names:
        marker = object()
        if _safe_lom_getattr(value, name, marker) is marker:
            raise ProtocolFailure("unsupported_capability", message)
    for name in callable_names:
        if not callable(_safe_lom_getattr(value, name)):
            raise ProtocolFailure("unsupported_capability", message)


def _resolve_scene(context, target):
    scenes = list(_safe_lom_getattr(context.song, "scenes", ()) or ())
    if target["index"] >= len(scenes):
        raise ProtocolFailure("not_found", "Scene index is out of range")
    scene = scenes[target["index"]]
    reference = _scene_reference(context, scene)
    if (
        reference != target["expectedReference"]
        or (_safe_lom_getattr(scene, "name", "") or "")
        != target["expectedName"]
    ):
        raise ProtocolFailure("stale_reference", "Scene identity changed")
    return scene


def _resolve_track(context, target):
    song = context.song
    kind = target["kind"]
    if kind == "regular":
        tracks = list(_safe_lom_getattr(song, "tracks", ()) or ())
        index = target["index"]
        if index >= len(tracks):
            raise ProtocolFailure("not_found", "Track index is out of range")
        track = tracks[index]
    elif kind == "return":
        tracks = list(_safe_lom_getattr(song, "return_tracks", ()) or ())
        index = target["index"]
        if index >= len(tracks):
            raise ProtocolFailure(
                "not_found", "Return track index is out of range"
            )
        track = tracks[index]
    else:
        track = _safe_lom_getattr(song, "master_track")
        if track is None:
            raise ProtocolFailure(
                "unsupported_capability", "Master track is unavailable"
            )
    if (
        _track_reference(context, track) != target["expectedReference"]
        or (_safe_lom_getattr(track, "name", "") or "")
        != target["expectedName"]
    ):
        raise ProtocolFailure("stale_reference", "Track identity changed")
    return track


def _track_summary(context, track, kind, index):
    folded = _safe_lom_getattr(track, "fold_state")
    monitoring = _safe_lom_getattr(track, "current_monitoring_state")
    back = _safe_lom_getattr(track, "back_to_arranger")
    return {
        "kind": kind,
        "index": index,
        "reference": _track_reference(context, track),
        "name": _safe_lom_getattr(track, "name", "") or "",
        "trackType": (
            "midi"
            if bool(_safe_lom_getattr(track, "has_midi_input", False))
            else "audio"
        ),
        "colorIndex": _safe_lom_getattr(track, "color_index"),
        "isGroup": bool(_safe_lom_getattr(track, "is_foldable", False)),
        "isFolded": bool(folded) if folded is not None else None,
        "monitoringState": int(monitoring) if monitoring is not None else None,
        "canBeArmed": bool(_safe_lom_getattr(track, "can_be_armed", False)),
        "isArmed": bool(_safe_lom_getattr(track, "arm", False)),
        "isMuted": bool(_safe_lom_getattr(track, "mute", False)),
        "isSoloed": bool(_safe_lom_getattr(track, "solo", False)),
        "backToArrangement": bool(back) if back is not None else None,
    }


def _scene_summary(context, scene, index):
    numerator = _safe_lom_getattr(scene, "time_signature_numerator")
    denominator = _safe_lom_getattr(scene, "time_signature_denominator")
    enabled = _safe_lom_getattr(scene, "time_signature_enabled")
    signature = None
    if numerator is not None and denominator is not None:
        signature = {
            "numerator": int(numerator),
            "denominator": int(denominator),
            "enabled": bool(enabled) if enabled is not None else None,
        }
    tempo = _safe_lom_getattr(scene, "tempo")
    tempo_enabled = _safe_lom_getattr(scene, "tempo_enabled")
    triggered = _safe_lom_getattr(scene, "is_triggered")
    valid_tempo = _number(tempo, 20, 999)
    valid_signature = (
        _integer(numerator, 1, 99)
        and _integer(denominator, 1, 16)
    )
    return {
        "index": index,
        "reference": _scene_reference(context, scene),
        "name": _safe_lom_getattr(scene, "name", "") or "",
        "colorIndex": _safe_lom_getattr(scene, "color_index"),
        "tempo": float(tempo) if valid_tempo else None,
        "tempoEnabled": (
            bool(tempo_enabled) if tempo_enabled is not None else None
        ),
        "timeSignature": signature if valid_signature else None,
        "isTriggered": bool(triggered) if triggered is not None else None,
    }


def _verified_property_mutation(
    value, changes, summarize, expected, failure_message
):
    before = summarize()
    applied = []
    try:
        for attribute, requested in changes:
            previous = _safe_lom_getattr(value, attribute)
            setattr(value, attribute, requested)
            applied.append((attribute, previous))
        after = summarize()
        if not expected(after):
            raise ProtocolFailure("conflict", failure_message)
        return before, after
    except Exception as exc:
        recovery_error = None
        try:
            for attribute, previous in reversed(applied):
                setattr(value, attribute, previous)
        except Exception as recovery_exc:
            recovery_error = recovery_exc
        if recovery_error is not None:
            raise ProtocolFailure(
                "lom_error",
                failure_message + "; recovery failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_error),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            failure_message + "; prior state was restored",
            details={"operationError": str(exc)},
        )


def execute_scenes(context, params):
    song = context.song
    action = params["action"]
    _require_attrs(song, ("scenes",), "Scene operations are unavailable")
    scenes = list(_safe_lom_getattr(song, "scenes", ()) or ())
    if action == "list":
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "scenes": [
                _scene_summary(context, scene, index)
                for index, scene in enumerate(
                    scenes[offset : offset + limit], start=offset
                )
            ],
            "total": len(scenes),
            "offset": offset,
            "limit": limit,
        }
    if action == "get":
        scene = _resolve_scene(context, params["target"])
        return {
            "action": action,
            "scene": _scene_summary(context, scene, params["target"]["index"]),
        }
    if action in ("create", "duplicate"):
        method = "create_scene" if action == "create" else "duplicate_scene"
        _require_attrs(song, (), "Scene creation is unavailable", (method,))
        before_count = len(scenes)
        index = (
            params["index"]
            if action == "create"
            else params["target"]["index"] + 1
        )
        source = (
            _resolve_scene(context, params["target"])
            if action == "duplicate"
            else None
        )
        try:
            getattr(song, method)(
                params["index"]
                if action == "create"
                else params["target"]["index"]
            )
            current = list(song.scenes)
            actual_index = len(current) - 1 if index == -1 else index
            if len(current) != before_count + 1 or actual_index >= len(current):
                raise ProtocolFailure(
                    "conflict", "Scene creation could not be verified"
                )
            scene = current[actual_index]
            if action == "duplicate" and _same_lom_object(scene, source):
                raise ProtocolFailure(
                    "conflict", "Scene duplication could not be verified"
                )
            if params.get("name") is not None:
                scene.name = params["name"].strip()
                if scene.name != params["name"].strip():
                    raise ProtocolFailure(
                        "conflict", "Scene name could not be verified"
                    )
        except Exception as exc:
            current = list(_safe_lom_getattr(song, "scenes", ()) or ())
            if len(current) == before_count + 1 and callable(
                _safe_lom_getattr(song, "delete_scene")
            ):
                try:
                    song.delete_scene(len(current) - 1 if index == -1 else index)
                except Exception:
                    pass
            if isinstance(exc, ProtocolFailure):
                raise exc
            raise ProtocolFailure("lom_error", str(exc))
        return {
            "action": action,
            "beforeSceneCount": before_count,
            "afterSceneCount": len(song.scenes),
            "scene": _scene_summary(context, scene, actual_index),
            "verified": True,
        }
    scene = _resolve_scene(context, params["target"])
    index = params["target"]["index"]
    if action in ("rename", "set-color", "set-tempo-time-signature"):
        if action == "rename":
            _require_attrs(scene, ("name",), "Scene rename is unavailable")
            changes = (("name", params["name"].strip()),)
            expected = lambda state: state["name"] == params["name"].strip()
        elif action == "set-color":
            _require_attrs(scene, ("color_index",), "Scene color is unavailable")
            changes = (("color_index", params["colorIndex"]),)
            expected = lambda state: state["colorIndex"] == params["colorIndex"]
        else:
            state = params["state"]
            if state["kind"] == "tempo":
                _require_attrs(
                    scene,
                    ("tempo", "tempo_enabled"),
                    "Scene tempo is unavailable",
                )
                changes = (
                    ("tempo", state["tempo"]),
                    ("tempo_enabled", state["enabled"]),
                )
                expected = lambda summary: (
                    summary["tempoEnabled"] == state["enabled"]
                    and (
                        not state["enabled"]
                        or (
                            summary["tempo"] is not None
                            and abs(summary["tempo"] - state["tempo"])
                            < 0.000001
                        )
                    )
                )
            else:
                _require_attrs(
                    scene,
                    (
                        "time_signature_numerator",
                        "time_signature_denominator",
                        "time_signature_enabled",
                    ),
                    "Scene time signature is unavailable",
                )
                changes = (
                    ("time_signature_numerator", state["numerator"]),
                    ("time_signature_denominator", state["denominator"]),
                    ("time_signature_enabled", state["enabled"]),
                )
                expected = lambda summary: (
                    (
                        not state["enabled"]
                        and summary["timeSignature"] is None
                    )
                    or (
                        summary["timeSignature"] is not None
                        and summary["timeSignature"]["numerator"]
                        == state["numerator"]
                        and summary["timeSignature"]["denominator"]
                        == state["denominator"]
                        and summary["timeSignature"]["enabled"]
                        == state["enabled"]
                    )
                )
        before, after = _verified_property_mutation(
            scene,
            changes,
            lambda: _scene_summary(context, scene, index),
            expected,
            "Scene mutation could not be verified",
        )
        return {
            "action": action,
            "before": before,
            "after": after,
            "verified": True,
        }
    if action == "fire":
        _require_attrs(
            scene,
            ("is_triggered",),
            "Scene fire verification is unavailable",
            ("fire",),
        )
        scene.fire()

        def start_verification(on_success, on_failure):
            def verify():
                try:
                    after = _scene_summary(context, scene, index)
                    if not after["isTriggered"]:
                        raise ProtocolFailure(
                            "conflict", "Scene fire could not be verified"
                        )
                    on_success(
                        {
                            "action": action,
                            "scene": after,
                            "verified": True,
                        }
                    )
                except Exception as exc:
                    on_failure(exc)

            context.schedule_message(1, verify)

        return DeferredResult(start_verification)
    _require_attrs(song, (), "Scene deletion is unavailable", ("delete_scene",))
    deleted = _scene_summary(context, scene, index)
    before_count = len(scenes)
    song.delete_scene(index)
    after = list(song.scenes)
    if len(after) != before_count - 1 or any(
        _same_lom_object(scene, candidate) for candidate in after
    ):
        raise ProtocolFailure("conflict", "Scene deletion could not be verified")
    return {
        "action": action,
        "deleted": deleted,
        "beforeSceneCount": before_count,
        "afterSceneCount": len(after),
        "verified": True,
    }


def _track_collections(song):
    regular = list(_safe_lom_getattr(song, "tracks", ()) or ())
    returns = list(_safe_lom_getattr(song, "return_tracks", ()) or ())
    master = _safe_lom_getattr(song, "master_track")
    return regular, returns, master


def execute_tracks(context, params):
    song = context.song
    action = params["action"]
    _require_attrs(song, ("tracks",), "Track operations are unavailable")
    regular, returns, master = _track_collections(song)
    if action == "list":
        selected = []
        requested = params.get("trackKind", "all")
        if requested in ("regular", "all"):
            selected.extend(
                (track, "regular", index)
                for index, track in enumerate(regular)
            )
        if requested in ("return", "all"):
            selected.extend(
                (track, "return", index)
                for index, track in enumerate(returns)
            )
        if requested in ("master", "all") and master is not None:
            selected.append((master, "master", None))
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "tracks": [
                _track_summary(context, track, kind, index)
                for track, kind, index in selected[offset : offset + limit]
            ],
            "total": len(selected),
            "offset": offset,
            "limit": limit,
        }
    if action == "get":
        target = params["target"]
        return {
            "action": action,
            "track": _track_summary(
                context,
                _resolve_track(context, target),
                target["kind"],
                target.get("index"),
            ),
        }
    if action == "create-return":
        _require_attrs(
            song, (), "Return track creation is unavailable", ("create_return_track",)
        )
        before_count = len(returns)
        try:
            song.create_return_track()
            current = list(song.return_tracks)
        except Exception as exc:
            current = list(_safe_lom_getattr(song, "return_tracks", ()) or ())
            if (
                len(current) == before_count + 1
                and callable(_safe_lom_getattr(song, "delete_return_track"))
            ):
                try:
                    song.delete_return_track(len(current) - 1)
                except Exception:
                    pass
            raise ProtocolFailure("lom_error", str(exc))
        if len(current) != before_count + 1:
            raise ProtocolFailure(
                "conflict", "Return track creation could not be verified"
            )
        track = current[-1]
        if params.get("name") is not None:
            track.name = params["name"].strip()
            if track.name != params["name"].strip():
                if callable(_safe_lom_getattr(song, "delete_return_track")):
                    song.delete_return_track(len(current) - 1)
                raise ProtocolFailure(
                    "conflict", "Return track name could not be verified"
                )
        return {
            "action": action,
            "track": _track_summary(
                context, track, "return", len(current) - 1
            ),
            "beforeReturnTrackCount": before_count,
            "afterReturnTrackCount": len(current),
            "verified": True,
        }
    if action == "duplicate":
        _require_attrs(song, (), "Track duplication is unavailable", ("duplicate_track",))
        target = params["target"]
        source_track = _resolve_track(context, target)
        source = _track_summary(context, source_track, "regular", target["index"])
        before_count = len(regular)
        new_index = target["index"] + 1
        try:
            song.duplicate_track(target["index"])
            current = list(song.tracks)
        except Exception as exc:
            current = list(_safe_lom_getattr(song, "tracks", ()) or ())
            if (
                len(current) == before_count + 1
                and callable(_safe_lom_getattr(song, "delete_track"))
            ):
                try:
                    song.delete_track(new_index)
                except Exception:
                    pass
            raise ProtocolFailure("lom_error", str(exc))
        if (
            len(current) != before_count + 1
            or new_index >= len(current)
            or _same_lom_object(current[new_index], source_track)
        ):
            raise ProtocolFailure(
                "conflict", "Track duplication could not be verified"
            )
        return {
            "action": action,
            "source": source,
            "track": _track_summary(
                context, current[new_index], "regular", new_index
            ),
            "beforeTrackCount": before_count,
            "afterTrackCount": len(current),
            "verified": True,
        }
    target = params["target"]
    track = _resolve_track(context, target)
    summarize = lambda: _track_summary(
        context, track, target["kind"], target.get("index")
    )
    if action in ("set-color", "set-monitoring", "set-fold"):
        if action == "set-color":
            attribute, value, key = "color_index", params["colorIndex"], "colorIndex"
        elif action == "set-monitoring":
            attribute, value, key = (
                "current_monitoring_state",
                params["monitoringState"],
                "monitoringState",
            )
        else:
            if not bool(_safe_lom_getattr(track, "is_foldable", False)):
                raise ProtocolFailure(
                    "unsupported_capability", "Track folding is unavailable"
                )
            attribute, value, key = "fold_state", params["folded"], "isFolded"
        _require_attrs(track, (attribute,), "Track mutation is unavailable")
        before, after = _verified_property_mutation(
            track,
            ((attribute, value),),
            summarize,
            lambda state: state[key] == value,
            "Track mutation could not be verified",
        )
        return {
            "action": action,
            "result": {"before": before, "after": after, "verified": True},
        }
    if action == "stop-clips":
        _require_attrs(
            track,
            ("playing_slot_index",),
            "Track clip stopping is unavailable",
            ("stop_all_clips",),
        )
        before = summarize()
        track.stop_all_clips(params.get("quantized", True))
        after = summarize()
        if _safe_lom_getattr(track, "playing_slot_index") not in (-1, None):
            raise ProtocolFailure(
                "conflict", "Track clips did not stop as requested"
            )
        return {
            "action": action,
            "result": {"before": before, "after": after, "verified": True},
        }
    if action == "back-to-arrangement":
        _require_attrs(
            track,
            ("back_to_arranger",),
            "Track back-to-arrangement is unavailable",
        )
        before, after = _verified_property_mutation(
            track,
            (("back_to_arranger", False),),
            summarize,
            lambda state: state["backToArrangement"] is False,
            "Back-to-arrangement could not be verified",
        )
        return {
            "action": action,
            "result": {"before": before, "after": after, "verified": True},
        }
    deleted = summarize()
    kind, index = target["kind"], target["index"]
    collection = regular if kind == "regular" else returns
    method = "delete_track" if kind == "regular" else "delete_return_track"
    _require_attrs(song, (), "Track deletion is unavailable", (method,))
    before_count = len(collection)
    getattr(song, method)(index)
    current = list(
        song.tracks if kind == "regular" else song.return_tracks
    )
    if len(current) != before_count - 1 or any(
        _same_lom_object(track, candidate) for candidate in current
    ):
        raise ProtocolFailure("conflict", "Track deletion could not be verified")
    return {
        "action": action,
        "deleted": deleted,
        "beforeCount": before_count,
        "afterCount": len(current),
        "verified": True,
    }


def _display_value(parameter):
    formatter = _safe_lom_getattr(parameter, "str_for_value")
    if callable(formatter):
        try:
            return formatter(parameter.value)
        except (RuntimeError, TypeError):
            pass
    return str(_safe_lom_getattr(parameter, "value", 0.0))


def _parameter_summary(context, parameter):
    minimum = _safe_lom_getattr(parameter, "min")
    maximum = _safe_lom_getattr(parameter, "max")
    value = _safe_lom_getattr(parameter, "value")
    if not all(_finite(item) for item in (minimum, maximum, value)):
        raise ProtocolFailure("conflict", "Mixer parameter state is invalid")
    normalized = 0.0 if maximum == minimum else (
        (value - minimum) / float(maximum - minimum)
    )
    return {
        "reference": _parameter_reference(context, parameter),
        "name": _safe_lom_getattr(parameter, "name", "") or "",
        "normalizedValue": max(0.0, min(1.0, normalized)),
        "value": value,
        "displayValue": _display_value(parameter)[:256],
    }


def _mixer_summary(context, track, target):
    mixer = _safe_lom_getattr(track, "mixer_device")
    _require_attrs(
        mixer,
        ("volume", "panning", "sends"),
        "Mixer inspection is unavailable",
    )
    crossfader = _safe_lom_getattr(mixer, "crossfader")
    cue_volume = _safe_lom_getattr(mixer, "cue_volume")
    return {
        "target": _track_summary(
            context, track, target["kind"], target.get("index")
        ),
        "volume": _parameter_summary(context, mixer.volume),
        "pan": _parameter_summary(context, mixer.panning),
        "sends": [
            _parameter_summary(context, parameter)
            for parameter in list(mixer.sends)[:64]
        ],
        "activator": not bool(_safe_lom_getattr(track, "mute", False)),
        "crossfadeAssignment": _safe_lom_getattr(
            mixer, "crossfade_assign"
        ),
        "crossfader": (
            _parameter_summary(context, crossfader)
            if crossfader is not None
            else None
        ),
        "cueVolume": (
            _parameter_summary(context, cue_volume)
            if cue_volume is not None
            else None
        ),
    }


def _resolve_parameter(context, target, parameter, expected_reference, expected_name):
    _resolve_track(context, target)
    if (
        _parameter_reference(context, parameter) != expected_reference
        or (_safe_lom_getattr(parameter, "name", "") or "") != expected_name
    ):
        raise ProtocolFailure("stale_reference", "Parameter identity changed")
    return parameter


def _set_parameter(context, parameter, normalized):
    before = _parameter_summary(context, parameter)
    minimum, maximum = parameter.min, parameter.max
    requested = minimum + normalized * (maximum - minimum)
    try:
        parameter.value = requested
        after = _parameter_summary(context, parameter)
        if abs(after["normalizedValue"] - normalized) > 0.00001:
            raise ProtocolFailure(
                "conflict", "Mixer parameter update could not be verified"
            )
    except Exception as exc:
        try:
            parameter.value = before["value"]
        except Exception:
            pass
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure("lom_error", str(exc))
    return {"before": before, "after": after, "verified": True}


_ROUTING_PROPERTIES = {
    "input-type": (
        "available_input_routing_types",
        "input_routing_type",
    ),
    "input-channel": (
        "available_input_routing_channels",
        "input_routing_channel",
    ),
    "output-type": (
        "available_output_routing_types",
        "output_routing_type",
    ),
    "output-channel": (
        "available_output_routing_channels",
        "output_routing_channel",
    ),
}


def _routing_display(option):
    return (
        _safe_lom_getattr(option, "display_name")
        or _safe_lom_getattr(option, "name")
        or str(option)
    )[:256]


def _external_midi(display_name):
    lowered = display_name.lower()
    return any(
        marker in lowered
        for marker in ("external", "ext. midi", "midi port", "midi out")
    )


def _routing_warnings(target_name, direction, option):
    warnings = []
    display = _routing_display(option)
    if _external_midi(display):
        warnings.append(
            "This routing option targets external MIDI; verify connected hardware."
        )
    if (
        direction.startswith("output")
        and target_name
        and target_name.lower() in display.lower()
    ):
        warnings.append(
            "This routing option may create an audio or MIDI feedback loop."
        )
    return warnings[:8]


def _active_routing_snapshots(snapshots, now):
    active = {}
    for snapshot_id, snapshot in snapshots.items():
        created = snapshot.get("created")
        if (
            _finite(created)
            and 0 <= now - created <= ROUTING_SNAPSHOT_SECONDS
        ):
            active[snapshot_id] = snapshot
    return active


def _store_routing_snapshot(context, snapshot_id, snapshot, now):
    snapshots = _active_routing_snapshots(
        getattr(context, "_routing_snapshots", {}), now
    )
    while len(snapshots) >= ROUTING_SNAPSHOT_LIMIT:
        oldest_id = min(
            snapshots,
            key=lambda candidate: (
                snapshots[candidate]["created"],
                candidate,
            ),
        )
        snapshots.pop(oldest_id)
    snapshots[snapshot_id] = snapshot
    context._routing_snapshots = snapshots


def execute_mixer(context, params):
    action = params["action"]
    target = params.get("target") or params.get("value", {}).get("target")
    track = _resolve_track(context, target)
    mixer = _safe_lom_getattr(track, "mixer_device")
    if action == "inspect":
        return {"action": action, "mixer": _mixer_summary(context, track, target)}
    if action == "meters":
        names = (
            "input_meter_left",
            "input_meter_right",
            "output_meter_left",
            "output_meter_right",
        )
        if not any(
            _safe_lom_getattr(track, name, None) is not None
            for name in names
        ):
            raise ProtocolFailure(
                "unsupported_capability", "Track meters are unavailable"
            )
        values = []
        for name in names:
            value = _safe_lom_getattr(track, name)
            values.append(
                max(0.0, min(1.0, value)) if _finite(value) else None
            )
        return {
            "action": action,
            "inputLeft": values[0],
            "inputRight": values[1],
            "outputLeft": values[2],
            "outputRight": values[3],
            "observedAt": datetime.datetime.utcnow().isoformat() + "Z",
        }
    if action in ("set-volume", "set-pan"):
        value = params["value"]
        attribute = "volume" if action == "set-volume" else "panning"
        _require_attrs(mixer, (attribute,), "Mixer parameter is unavailable")
        parameter = _resolve_parameter(
            context,
            target,
            getattr(mixer, attribute),
            value["expectedParameterReference"],
            value["expectedParameterName"],
        )
        return {
            "action": action,
            "result": _set_parameter(
                context, parameter, value["normalizedValue"]
            ),
        }
    if action == "set-send":
        sends = list(_safe_lom_getattr(mixer, "sends", ()) or ())
        if params["sendIndex"] >= len(sends):
            raise ProtocolFailure("not_found", "Send index is out of range")
        parameter = _resolve_parameter(
            context,
            target,
            sends[params["sendIndex"]],
            params["expectedParameterReference"],
            params["expectedParameterName"],
        )
        return {
            "action": action,
            "result": _set_parameter(
                context, parameter, params["normalizedValue"]
            ),
        }
    if action == "set-activator":
        _require_attrs(track, ("mute",), "Track activator is unavailable")
        before = not bool(track.mute)
        try:
            track.mute = not params["active"]
            after = not bool(track.mute)
            if after != params["active"]:
                raise ProtocolFailure(
                    "conflict", "Track activator update could not be verified"
                )
        except Exception as exc:
            try:
                track.mute = not before
            except Exception:
                pass
            if isinstance(exc, ProtocolFailure):
                raise exc
            raise ProtocolFailure("lom_error", str(exc))
        return {
            "action": action,
            "before": before,
            "after": after,
            "verified": True,
        }
    if action == "set-crossfade-assignment":
        _require_attrs(
            mixer,
            ("crossfade_assign",),
            "Crossfade assignment is unavailable",
        )
        before = int(mixer.crossfade_assign)
        try:
            mixer.crossfade_assign = params["assignment"]
            after = int(mixer.crossfade_assign)
            if after != params["assignment"]:
                raise ProtocolFailure(
                    "conflict", "Crossfade assignment could not be verified"
                )
        except Exception as exc:
            try:
                mixer.crossfade_assign = before
            except Exception:
                pass
            if isinstance(exc, ProtocolFailure):
                raise exc
            raise ProtocolFailure("lom_error", str(exc))
        return {
            "action": action,
            "before": before,
            "after": after,
            "verified": True,
        }
    if action in ("set-master-crossfader", "set-cue-volume"):
        if target["kind"] != "master":
            raise ProtocolFailure(
                "invalid_params", "The target must be the master track"
            )
        value = params["value"]
        attribute = (
            "crossfader"
            if action == "set-master-crossfader"
            else "cue_volume"
        )
        _require_attrs(mixer, (attribute,), "Master mixer parameter is unavailable")
        parameter = _resolve_parameter(
            context,
            target,
            getattr(mixer, attribute),
            value["expectedParameterReference"],
            value["expectedParameterName"],
        )
        return {
            "action": action,
            "result": _set_parameter(
                context, parameter, value["normalizedValue"]
            ),
        }
    available_name, current_name = _ROUTING_PROPERTIES[params["direction"]]
    _require_attrs(
        track,
        (available_name, current_name),
        "Requested routing API is unavailable",
    )
    if action == "routing-options":
        options = list(getattr(track, available_name))[:256]
        snapshot_id = str(uuid.uuid4())
        entries = []
        current_token = None
        snapshot_options = {}
        current = getattr(track, current_name)
        warnings = []
        for option in options:
            token = str(uuid.uuid4())
            display = _routing_display(option)
            entry = {
                "token": token,
                "displayName": display,
                "isExternalMidi": _external_midi(display),
            }
            entries.append(entry)
            snapshot_options[token] = (option, entry)
            if _same_lom_object(option, current):
                current_token = token
            warnings.extend(
                _routing_warnings(track.name, params["direction"], option)
            )
        now = time.time()
        _store_routing_snapshot(context, snapshot_id, {
            "created": now,
            "trackReference": target["expectedReference"],
            "trackName": target["expectedName"],
            "trackKind": target["kind"],
            "trackIndex": target.get("index"),
            "direction": params["direction"],
            "options": snapshot_options,
        }, now)
        return {
            "action": action,
            "snapshotId": snapshot_id,
            "options": entries,
            "currentOptionToken": current_token,
            "warnings": list(dict.fromkeys(warnings))[:8],
        }
    now = time.time()
    snapshots = _active_routing_snapshots(
        getattr(context, "_routing_snapshots", {}), now
    )
    context._routing_snapshots = snapshots
    snapshot = snapshots.get(params["snapshotId"])
    if (
        snapshot is None
        or snapshot["trackReference"] != target["expectedReference"]
        or snapshot["trackName"] != target["expectedName"]
        or snapshot["trackKind"] != target["kind"]
        or snapshot["trackIndex"] != target.get("index")
        or snapshot["direction"] != params["direction"]
    ):
        raise ProtocolFailure(
            "stale_reference", "Routing snapshot is missing, stale, or mismatched"
        )
    selected = snapshot["options"].get(params["optionToken"])
    if (
        selected is None
        or selected[1]["displayName"] != params["expectedDisplayName"]
    ):
        raise ProtocolFailure(
            "stale_reference", "Routing option identity changed"
        )
    current = getattr(track, current_name)
    before_token = next(
        (
            pair
            for pair in snapshot["options"].values()
            if _same_lom_object(pair[0], current)
        ),
        None,
    )
    if before_token is None:
        raise ProtocolFailure(
            "stale_reference", "Current routing option was not in the snapshot"
        )
    before = before_token[1]
    try:
        setattr(track, current_name, selected[0])
        after_option = getattr(track, current_name)
        if not _same_lom_object(after_option, selected[0]):
            raise ProtocolFailure(
                "conflict", "Routing assignment could not be verified"
            )
    except Exception as exc:
        try:
            setattr(track, current_name, current)
        except Exception:
            pass
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure("lom_error", str(exc))
    warnings = _routing_warnings(
        track.name, params["direction"], selected[0]
    )
    snapshots.pop(params["snapshotId"], None)
    return {
        "action": action,
        "before": before,
        "after": selected[1],
        "warnings": warnings,
        "verified": True,
    }


def _transport_state(song):
    required = (
        "current_song_time",
        "is_playing",
        "tempo",
        "signature_numerator",
        "signature_denominator",
        "metronome",
        "clip_trigger_quantization",
        "midi_recording_quantization",
    )
    _require_attrs(song, required, "Transport state is unavailable")
    link = _safe_lom_getattr(song, "is_ableton_link_enabled")
    back = _safe_lom_getattr(song, "back_to_arranger")
    return {
        "currentSongTime": max(0.0, float(song.current_song_time)),
        "isPlaying": bool(song.is_playing),
        "tempo": float(song.tempo),
        "timeSignature": {
            "numerator": int(song.signature_numerator),
            "denominator": int(song.signature_denominator),
        },
        "metronome": bool(song.metronome),
        "launchQuantization": int(song.clip_trigger_quantization),
        "recordQuantization": int(song.midi_recording_quantization),
        "linkEnabled": bool(link) if link is not None else None,
        "backToArrangement": bool(back) if back is not None else None,
    }


def _cue_summary(context, cue):
    return {
        "reference": _cue_reference(context, cue),
        "name": _safe_lom_getattr(cue, "name", "") or "",
        "time": float(_safe_lom_getattr(cue, "time", 0.0)),
    }


def _resolve_cue(context, target):
    for cue in list(_safe_lom_getattr(context.song, "cue_points", ()) or ()):
        summary = _cue_summary(context, cue)
        if summary["reference"] == target["expectedReference"]:
            if (
                summary["name"] != target["expectedName"]
                or abs(summary["time"] - target["expectedTime"]) > 0.000001
            ):
                break
            return cue
    raise ProtocolFailure("stale_reference", "Cue point identity changed")


def execute_transport(context, params):
    song = context.song
    action = params["action"]
    if action == "get":
        _require_attrs(song, ("cue_points",), "Cue-point inspection is unavailable")
        cues = sorted(list(song.cue_points), key=lambda cue: cue.time)
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "transport": _transport_state(song),
            "cuePoints": [
                _cue_summary(context, cue)
                for cue in cues[offset : offset + limit]
            ],
            "totalCuePoints": len(cues),
            "offset": offset,
            "limit": limit,
        }
    if action == "rename-cue":
        cue = _resolve_cue(context, params["target"])
        before = _cue_summary(context, cue)
        requested = params["name"].strip()
        cue.name = requested
        after = _cue_summary(context, cue)
        if after["name"] != requested:
            cue.name = before["name"]
            raise ProtocolFailure("conflict", "Cue rename could not be verified")
        return {
            "action": action,
            "before": before,
            "after": after,
            "verified": True,
        }
    if action == "jump-to-cue":
        cue = _resolve_cue(context, params["target"])
        before_time = float(song.current_song_time)
        try:
            if callable(_safe_lom_getattr(cue, "jump")):
                cue.jump()
            else:
                song.current_song_time = cue.time
            after_time = float(song.current_song_time)
            if abs(after_time - cue.time) > 0.000001:
                raise ProtocolFailure(
                    "conflict", "Cue jump could not be verified"
                )
        except Exception as exc:
            try:
                song.current_song_time = before_time
            except Exception:
                pass
            if isinstance(exc, ProtocolFailure):
                raise exc
            raise ProtocolFailure("lom_error", str(exc))
        return {
            "action": action,
            "cuePoint": _cue_summary(context, cue),
            "beforeTime": before_time,
            "afterTime": after_time,
            "verified": True,
        }
    before = _transport_state(song)
    if action == "seek":
        changes = (("current_song_time", params["time"]),)
        check = lambda state: abs(state["currentSongTime"] - params["time"]) < 0.000001
    elif action == "jump":
        _require_attrs(song, (), "Transport jump is unavailable", ("jump_by",))
        requested = max(0.0, before["currentSongTime"] + params["beats"])
        try:
            song.jump_by(params["beats"])
            after = _transport_state(song)
            if abs(after["currentSongTime"] - requested) > 0.000001:
                raise ProtocolFailure(
                    "conflict", "Transport jump could not be verified"
                )
        except Exception as exc:
            try:
                song.current_song_time = before["currentSongTime"]
            except Exception:
                pass
            if isinstance(exc, ProtocolFailure):
                raise exc
            raise ProtocolFailure("lom_error", str(exc))
        return {
            "action": action,
            "before": before,
            "after": after,
            "verified": True,
        }
    elif action == "set-time-signature":
        changes = (
            ("signature_numerator", params["numerator"]),
            ("signature_denominator", params["denominator"]),
        )
        check = lambda state: (
            state["timeSignature"]["numerator"] == params["numerator"]
            and state["timeSignature"]["denominator"] == params["denominator"]
        )
    elif action == "set-metronome":
        changes = (("metronome", params["enabled"]),)
        check = lambda state: state["metronome"] == params["enabled"]
    elif action == "set-launch-quantization":
        changes = (("clip_trigger_quantization", params["quantization"]),)
        check = lambda state: state["launchQuantization"] == params["quantization"]
    elif action == "set-record-quantization":
        changes = (("midi_recording_quantization", params["quantization"]),)
        check = lambda state: state["recordQuantization"] == params["quantization"]
    elif action == "set-link":
        _require_attrs(
            song,
            ("is_ableton_link_enabled",),
            "Ableton Link control is unavailable",
        )
        changes = (("is_ableton_link_enabled", params["enabled"]),)
        check = lambda state: state["linkEnabled"] == params["enabled"]
    else:
        _require_attrs(
            song,
            ("back_to_arranger",),
            "Back-to-arrangement is unavailable",
        )
        changes = (("back_to_arranger", False),)
        check = lambda state: state["backToArrangement"] is False
    _verified_property_mutation(
        song,
        changes,
        lambda: _transport_state(song),
        check,
        "Transport mutation could not be verified",
    )
    return {
        "action": action,
        "before": before,
        "after": _transport_state(song),
        "verified": True,
    }


def _resolve_clip(context, target):
    track = _resolve_track(context, target["track"])
    if target["view"] == "session":
        slots = list(_safe_lom_getattr(track, "clip_slots", ()) or ())
        index = target["sceneIndex"]
        if index >= len(slots) or not bool(
            _safe_lom_getattr(slots[index], "has_clip", False)
        ):
            raise ProtocolFailure("not_found", "Session clip was not found")
        clip = slots[index].clip
    else:
        clip = None
        for candidate in list(
            _safe_lom_getattr(track, "arrangement_clips", ()) or ()
        ):
            if (
                _clip_reference(context, candidate)
                == target["expectedClipReference"]
            ):
                clip = candidate
                break
        if clip is None:
            raise ProtocolFailure("not_found", "Arrangement clip was not found")
        if abs(
            float(_safe_lom_getattr(clip, "start_time", -1))
            - target["expectedStartTime"]
        ) > 0.000001:
            raise ProtocolFailure("stale_reference", "Clip position changed")
    if (
        _clip_reference(context, clip) != target["expectedClipReference"]
        or (_safe_lom_getattr(clip, "name", "") or "")
        != target["expectedClipName"]
    ):
        raise ProtocolFailure("stale_reference", "Clip identity changed")
    return clip


def _note_value(note, name, default=None):
    if isinstance(note, dict):
        return note.get(name, default)
    return _safe_lom_getattr(note, name, default)


def _note_summary(note):
    return {
        "noteId": int(_note_value(note, "note_id")),
        "pitch": int(_note_value(note, "pitch")),
        "startTime": float(_note_value(note, "start_time")),
        "duration": float(_note_value(note, "duration")),
        "velocity": float(_note_value(note, "velocity")),
        "mute": bool(_note_value(note, "mute", False)),
        "probability": float(_note_value(note, "probability", 1.0)),
        "velocityDeviation": float(
            _note_value(note, "velocity_deviation", 0)
        ),
        "releaseVelocity": float(
            _note_value(note, "release_velocity", 64)
        ),
    }


def _note_factory(context):
    factory = getattr(context, "midi_note_factory", MidiNoteSpecification)
    if factory is None:
        raise ProtocolFailure(
            "unsupported_capability", "Modern MIDI note editing is unavailable"
        )
    return factory


def _note_spec(factory, note, include_id=False):
    specification = factory(
        pitch=note["pitch"],
        start_time=note["startTime"],
        duration=note["duration"],
        velocity=note["velocity"],
        mute=note["mute"],
        probability=note["probability"],
        velocity_deviation=note["velocityDeviation"],
        release_velocity=note["releaseVelocity"],
    )
    if include_id:
        specification.note_id = note["noteId"]
    return specification


def _modern_note_objects(clip):
    _require_attrs(
        clip,
        (),
        "Modern MIDI note access is unavailable",
        ("get_all_notes_extended",),
    )
    if not bool(_safe_lom_getattr(clip, "is_midi_clip", False)):
        raise ProtocolFailure("conflict", "The target is not a MIDI clip")
    return list(clip.get_all_notes_extended())


def _modern_notes(clip):
    return [_note_summary(note) for note in _modern_note_objects(clip)]


def _selected_notes(notes, note_ids):
    by_id = dict((note["noteId"], note) for note in notes)
    missing = [note_id for note_id in note_ids if note_id not in by_id]
    if missing:
        raise ProtocolFailure(
            "stale_reference",
            "One or more MIDI note identities changed",
            details={"missingNoteIds": missing[:64]},
        )
    return [by_id[note_id] for note_id in note_ids]


def _note_fields_equal(left, right, include_id=False):
    keys = (
        "pitch",
        "startTime",
        "duration",
        "velocity",
        "mute",
        "probability",
        "velocityDeviation",
        "releaseVelocity",
    )
    if include_id:
        keys = ("noteId",) + keys
    for key in keys:
        if isinstance(right[key], float):
            if abs(left[key] - right[key]) > 0.000001:
                return False
        elif left[key] != right[key]:
            return False
    return True


def _set_note_fields(note, state):
    for attribute, key in (
        ("pitch", "pitch"),
        ("start_time", "startTime"),
        ("duration", "duration"),
        ("velocity", "velocity"),
        ("mute", "mute"),
        ("probability", "probability"),
        ("velocity_deviation", "velocityDeviation"),
        ("release_velocity", "releaseVelocity"),
    ):
        setattr(note, attribute, state[key])


def _apply_note_modifications(clip, notes, backups):
    try:
        clip.apply_note_modifications(tuple(notes))
    except Exception as exc:
        try:
            for note, backup in zip(notes, backups):
                _set_note_fields(note, backup)
            clip.apply_note_modifications(tuple(notes))
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "MIDI note update and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        raise ProtocolFailure(
            "lom_error",
            "MIDI note update failed; prior notes were restored",
            details={"operationError": str(exc)},
        )


def execute_midi(context, params):
    clip = _resolve_clip(context, params["target"])
    action = params["action"]
    before_objects = _modern_note_objects(clip)
    before = [_note_summary(note) for note in before_objects]
    if action == "query":
        start = params.get("fromTime", 0)
        end = start + params.get("timeSpan", MAX_BEATS)
        low = params.get("fromPitch", 0)
        high = low + params.get("pitchSpan", 128)
        filtered = [
            note
            for note in before
            if start <= note["startTime"] < end
            and low <= note["pitch"] < high
        ]
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "notes": filtered[offset : offset + limit],
            "total": len(filtered),
            "offset": offset,
            "limit": limit,
            "truncated": offset + limit < len(filtered),
        }
    before_count = len(before)
    affected = []
    expected_affected = []
    if action == "add":
        factory = _note_factory(context)
        _require_attrs(
            clip, (), "Modern MIDI note addition is unavailable", ("add_new_notes",)
        )
        try:
            affected = list(
                clip.add_new_notes(
                    tuple(_note_spec(factory, note) for note in params["notes"])
                )
            )
        except Exception as exc:
            current_ids = set(
                note["noteId"] for note in _modern_notes(clip)
            )
            before_ids = set(note["noteId"] for note in before)
            added_ids = tuple(current_ids - before_ids)
            if added_ids and callable(
                _safe_lom_getattr(clip, "remove_notes_by_id")
            ):
                try:
                    clip.remove_notes_by_id(added_ids)
                except Exception:
                    pass
            raise ProtocolFailure("lom_error", str(exc))
        expected_affected = list(params["notes"])
    elif action == "update":
        _require_attrs(
            clip,
            (),
            "Modern MIDI note modification is unavailable",
            ("apply_note_modifications",),
        )
        requested_by_id = dict(
            (note["noteId"], note) for note in params["notes"]
        )
        _selected_notes(before, list(requested_by_id))
        selected_objects = [
            note
            for note in before_objects
            if int(_note_value(note, "note_id")) in requested_by_id
        ]
        backups = [_note_summary(note) for note in selected_objects]
        for note in selected_objects:
            requested = requested_by_id[int(_note_value(note, "note_id"))]
            _set_note_fields(note, requested)
        _apply_note_modifications(clip, selected_objects, backups)
        affected = [note["noteId"] for note in params["notes"]]
        expected_affected = list(params["notes"])
    elif action == "remove":
        _require_attrs(
            clip, (), "Modern MIDI note removal is unavailable", ("remove_notes_by_id",)
        )
        _selected_notes(before, params["noteIds"])
        clip.remove_notes_by_id(tuple(params["noteIds"]))
        affected = list(params["noteIds"])
    elif action == "duplicate":
        factory = _note_factory(context)
        _require_attrs(
            clip, (), "Modern MIDI note duplication is unavailable", ("add_new_notes",)
        )
        source = _selected_notes(before, params["noteIds"])
        copies = []
        for note in source:
            copied = dict(note)
            copied.pop("noteId")
            copied["startTime"] += params["timeOffset"]
            copied["pitch"] += params.get("pitchOffset", 0)
            if (
                copied["startTime"] < 0
                or copied["pitch"] < 0
                or copied["pitch"] > 127
            ):
                raise ProtocolFailure(
                    "invalid_params", "Duplicated notes exceed clip bounds"
                )
            copies.append(copied)
        try:
            affected = list(
                clip.add_new_notes(
                    tuple(_note_spec(factory, note) for note in copies)
                )
            )
        except Exception as exc:
            current_ids = set(
                note["noteId"] for note in _modern_notes(clip)
            )
            before_ids = set(note["noteId"] for note in before)
            added_ids = tuple(current_ids - before_ids)
            if added_ids and callable(
                _safe_lom_getattr(clip, "remove_notes_by_id")
            ):
                try:
                    clip.remove_notes_by_id(added_ids)
                except Exception:
                    pass
            raise ProtocolFailure("lom_error", str(exc))
        expected_affected = copies
    else:
        _require_attrs(
            clip,
            (),
            "Modern MIDI note quantization is unavailable",
            ("apply_note_modifications",),
        )
        selected = _selected_notes(before, params["noteIds"])
        selected_by_id = dict((note["noteId"], note) for note in selected)
        modified = [
            note
            for note in before_objects
            if int(_note_value(note, "note_id")) in selected_by_id
        ]
        backups = [_note_summary(note) for note in modified]
        for note in modified:
            summary = selected_by_id[int(_note_value(note, "note_id"))]
            snapped = round(summary["startTime"] / params["gridBeats"]) * params[
                "gridBeats"
            ]
            note.start_time = max(
                0.0,
                summary["startTime"]
                + (snapped - summary["startTime"]) * params["amount"],
            )
        _apply_note_modifications(clip, modified, backups)
        affected = list(params["noteIds"])
        expected_affected = [
            dict(
                selected_by_id[note_id],
                startTime=max(
                    0.0,
                    selected_by_id[note_id]["startTime"]
                    + (
                        round(
                            selected_by_id[note_id]["startTime"]
                            / params["gridBeats"]
                        )
                        * params["gridBeats"]
                        - selected_by_id[note_id]["startTime"]
                    )
                    * params["amount"],
                ),
            )
            for note_id in affected
        ]
    after = _modern_notes(clip)
    after_by_id = dict((note["noteId"], note) for note in after)
    if action == "remove":
        verified = all(note_id not in after_by_id for note_id in affected)
    else:
        verified = all(note_id in after_by_id for note_id in affected)
        if verified:
            verified = all(
                _note_fields_equal(
                    after_by_id[note_id],
                    dict(expected, noteId=note_id),
                    include_id=True,
                )
                for note_id, expected in zip(affected, expected_affected)
            )
    expected_count = {
        "add": before_count + len(params.get("notes", ())),
        "update": before_count,
        "remove": before_count - len(affected),
        "duplicate": before_count + len(affected),
        "quantize": before_count,
    }[action]
    if not verified or len(after) != expected_count:
        if action in ("add", "duplicate") and affected and callable(
            _safe_lom_getattr(clip, "remove_notes_by_id")
        ):
            clip.remove_notes_by_id(tuple(affected))
        elif action in ("update", "quantize"):
            try:
                for note, backup in zip(
                    selected_objects if action == "update" else modified,
                    backups,
                ):
                    _set_note_fields(note, backup)
                clip.apply_note_modifications(
                    tuple(
                        selected_objects
                        if action == "update"
                        else modified
                    )
                )
            except Exception as recovery_exc:
                raise ProtocolFailure(
                    "lom_error",
                    "MIDI note verification and recovery both failed",
                    details={"recoveryError": str(recovery_exc)},
                )
        raise ProtocolFailure(
            "conflict", "MIDI note mutation could not be verified"
        )
    return {
        "action": action,
        "beforeNoteCount": before_count,
        "afterNoteCount": len(after),
        "affectedNoteIds": affected,
        "verified": True,
    }


def _audio_summary(context, clip):
    if bool(_safe_lom_getattr(clip, "is_midi_clip", False)):
        raise ProtocolFailure("conflict", "The target is not an audio clip")
    length = _safe_lom_getattr(clip, "length")
    if not _number(length, positive=True):
        raise ProtocolFailure("conflict", "Audio clip length is invalid")
    def optional_number(name):
        value = _safe_lom_getattr(clip, name)
        return value if _finite(value) else None
    def optional_int(name):
        value = _safe_lom_getattr(clip, name)
        return (
            int(value)
            if _finite(value) and int(value) == value
            else None
        )
    def optional_bool(name):
        value = _safe_lom_getattr(clip, name)
        return bool(value) if value is not None else None
    file_path = _safe_lom_getattr(clip, "file_path")
    return {
        "reference": _clip_reference(context, clip),
        "name": _safe_lom_getattr(clip, "name", "") or "",
        "length": float(length),
        "gain": optional_number("gain"),
        "pitchCoarse": optional_int("pitch_coarse"),
        "pitchFine": optional_int("pitch_fine"),
        "warping": optional_bool("warping"),
        "warpMode": optional_int("warp_mode"),
        "startMarker": optional_number("start_marker"),
        "endMarker": optional_number("end_marker"),
        "loopStart": optional_number("loop_start"),
        "loopEnd": optional_number("loop_end"),
        "looping": optional_bool("looping"),
        "ramMode": optional_bool("ram_mode"),
        "filePath": str(file_path)[:2048] if file_path is not None else None,
        "sampleLength": optional_int("sample_length"),
        "sampleRate": optional_int("sample_rate"),
    }


def execute_audio(context, params):
    clip = _resolve_clip(context, params["target"])
    action = params["action"]
    if action == "inspect":
        return {"action": action, "clip": _audio_summary(context, clip)}
    if action == "warp-markers":
        _require_attrs(clip, ("warp_markers",), "Warp-marker reads are unavailable")
        markers = list(clip.warp_markers)
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        def marker_value(marker, name):
            if isinstance(marker, dict):
                return marker[name]
            return getattr(marker, name)

        return {
            "action": action,
            "markers": [
                {
                    "index": index,
                    "beatTime": float(marker_value(marker, "beat_time")),
                    "sampleTime": float(marker_value(marker, "sample_time")),
                }
                for index, marker in enumerate(
                    markers[offset : offset + limit], start=offset
                )
            ],
            "total": len(markers),
            "offset": offset,
            "limit": limit,
        }
    if action == "set-gain":
        changes = (("gain", params["gain"]),)
        expected = lambda state: abs(state["gain"] - params["gain"]) < 0.000001
    elif action == "set-pitch":
        changes = (
            ("pitch_coarse", params["coarse"]),
            ("pitch_fine", params["fine"]),
        )
        expected = lambda state: (
            state["pitchCoarse"] == params["coarse"]
            and state["pitchFine"] == params["fine"]
        )
    elif action == "set-warp":
        changes = (("warping", params["enabled"]),)
        expected = lambda state: state["warping"] == params["enabled"]
    elif action == "set-warp-mode":
        changes = (("warp_mode", params["warpMode"]),)
        expected = lambda state: state["warpMode"] == params["warpMode"]
    elif action == "set-ram-mode":
        changes = (("ram_mode", params["enabled"]),)
        expected = lambda state: state["ramMode"] == params["enabled"]
    else:
        markers = params["markers"]
        if markers["kind"] == "start-end":
            changes = (
                ("start_marker", markers["startMarker"]),
                ("end_marker", markers["endMarker"]),
            )
            expected = lambda state: (
                abs(state["startMarker"] - markers["startMarker"]) < 0.000001
                and abs(state["endMarker"] - markers["endMarker"]) < 0.000001
            )
        else:
            changes = (
                ("loop_start", markers["loopStart"]),
                ("loop_end", markers["loopEnd"]),
                ("looping", markers["looping"]),
            )
            expected = lambda state: (
                abs(state["loopStart"] - markers["loopStart"]) < 0.000001
                and abs(state["loopEnd"] - markers["loopEnd"]) < 0.000001
                and state["looping"] == markers["looping"]
            )
    _require_attrs(
        clip,
        tuple(attribute for attribute, _value in changes),
        "Requested audio clip mutation is unavailable",
    )
    if action == "set-warp":
        before = _audio_summary(context, clip)
        previous = before["warping"]
        try:
            clip.warping = params["enabled"]
        except Exception as exc:
            try:
                clip.warping = previous
            except Exception:
                pass
            raise ProtocolFailure("lom_error", str(exc))

        def start_verification(on_success, on_failure):
            def verify():
                try:
                    after = _audio_summary(context, clip)
                    if after["warping"] != params["enabled"]:
                        try:
                            clip.warping = previous
                        except Exception:
                            pass
                        raise ProtocolFailure(
                            "conflict",
                            "Audio clip warp update could not be verified",
                        )
                    on_success(
                        {
                            "action": action,
                            "before": before,
                            "after": after,
                            "verified": True,
                        }
                    )
                except Exception as exc:
                    on_failure(exc)

            context.schedule_message(1, verify)

        return DeferredResult(start_verification)
    before, after = _verified_property_mutation(
        clip,
        changes,
        lambda: _audio_summary(context, clip),
        expected,
        "Audio clip mutation could not be verified",
    )
    return {
        "action": action,
        "before": before,
        "after": after,
        "verified": True,
    }


def register_core_domain_commands(registry):
    registry.register(
        "scenes.inspect",
        execute_scenes,
        validator=validate_scenes_inspect,
    )
    registry.register(
        "scenes.mutate",
        execute_scenes,
        mutates=True,
        validator=validate_scenes_mutate,
    )
    registry.register(
        "tracks.inspect",
        execute_tracks,
        validator=validate_tracks_inspect,
    )
    registry.register(
        "tracks.mutate",
        execute_tracks,
        mutates=True,
        validator=validate_tracks_mutate,
    )
    registry.register(
        "mixer_routing.inspect",
        execute_mixer,
        validator=validate_mixer_inspect,
    )
    registry.register(
        "mixer_routing.mutate",
        execute_mixer,
        mutates=True,
        validator=validate_mixer_mutate,
    )
    registry.register(
        "transport.inspect",
        execute_transport,
        validator=validate_transport_inspect,
    )
    registry.register(
        "transport.mutate",
        execute_transport,
        mutates=True,
        validator=validate_transport_mutate,
    )
    registry.register(
        "midi_notes.inspect",
        execute_midi,
        validator=validate_midi_inspect,
    )
    registry.register(
        "midi_notes.mutate",
        execute_midi,
        mutates=True,
        validator=validate_midi_mutate,
    )
    registry.register(
        "audio_clips.inspect",
        execute_audio,
        validator=validate_audio_inspect,
    )
    registry.register(
        "audio_clips.mutate",
        execute_audio,
        mutates=True,
        validator=validate_audio_mutate,
    )
