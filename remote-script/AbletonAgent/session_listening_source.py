"""Read-only Session source diagnostics; never grants native launch authority."""

from .core_domain_commands import (
    _clip_reference, _clip_target, _integer, _number, _resolve_clip,
    _resolve_track, _strict, _uuid,
)
from .errors import ProtocolFailure
from .system_commands import _safe_lom_getattr

try:
    from Live.Clip import ClipLaunchQuantization
except ImportError:  # Available only inside Live.
    ClipLaunchQuantization = None


CLIP_LAUNCH_QUANTIZATION_MEMBERS = (
    "q_global", "q_none", "q_8_bars", "q_4_bars", "q_2_bars", "q_bar",
    "q_half", "q_half_triplet", "q_quarter", "q_quarter_triplet",
    "q_eighth", "q_eighth_triplet", "q_sixteenth", "q_sixteenth_triplet", "q_thirtysecond",
)
_HOST_ENUM = object()


def _enum_integer(value, enum_type):
    if isinstance(value, bool):
        return None
    if not isinstance(value, int) and not isinstance(value, enum_type):
        return None
    try:
        native = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return native if _integer(native, -2147483648, 2147483647) else None


def _clip_launch_quantization(clip, enum_type):
    if not isinstance(enum_type, type):
        return None
    raw = _enum_integer(_safe_lom_getattr(clip, "launch_quantization"), enum_type)
    if raw is None:
        return None
    # Map installed public semantic members to Max's wire ordinals. Never
    # infer Python enum values from XML serialization or a freshly made clip.
    native_to_canonical = {}
    for canonical, name in enumerate(CLIP_LAUNCH_QUANTIZATION_MEMBERS):
        native = _enum_integer(_safe_lom_getattr(enum_type, name), enum_type)
        if native is None or native in native_to_canonical:
            return None
        native_to_canonical[native] = canonical
    return native_to_canonical.get(raw)


def validate_session_listening_source(params):
    if not _strict(params, ("schemaVersion", "queryId", "target")):
        return "Invalid Session source inspection parameters"
    target = params["target"]
    if not (
        _integer(params["schemaVersion"], 1, 1)
        and _uuid(params["queryId"])
        and _clip_target(target) and target["view"] == "session"
        and _integer(target["sceneIndex"], 0, 255)
        and _integer(target["track"]["index"], 0, 255)
    ):
        return "Invalid Session source inspection version, query or exact target"
    return None


def _boolean(obj, field):
    value = _safe_lom_getattr(obj, field)
    return value if isinstance(value, bool) else None


def _coordinate(obj, field):
    value = _safe_lom_getattr(obj, field)
    return value if _number(value, -1576800, 1576800) else None


def _index(obj, field, minimum, maximum):
    value = _safe_lom_getattr(obj, field)
    return value if _integer(value, minimum, maximum) else None


def _state(context, track, clip):
    song = context.song
    playing = _index(track, "playing_slot_index", -2, 255)
    selected = None
    if playing is not None and playing >= 0:
        slots = _safe_lom_getattr(track, "clip_slots", ())
        if playing < len(slots) and _boolean(slots[playing], "has_clip") is True:
            current = _safe_lom_getattr(slots[playing], "clip")
            if current is not None:
                selected = _clip_reference(context, current, bounded=True)
    return {
        "transportPlaying": _boolean(song, "is_playing"),
        "globalBeat": _coordinate(song, "current_song_time"),
        # Session start_time can describe another selected clip on this track.
        # Preserve that read without interpreting it as this target's origin.
        "startTimeBeats": _coordinate(clip, "start_time"),
        "playingPosition": _coordinate(clip, "playing_position"),
        "targetPlaying": _boolean(clip, "is_playing"),
        "targetTriggered": _boolean(clip, "is_triggered"),
        "targetRecording": _boolean(clip, "is_recording"),
        "playingSlotIndex": playing,
        "firedSlotIndex": _index(track, "fired_slot_index", -2, 255),
        "selectedClipReference": selected,
    }


def inspect_session_listening_source(context, params, launch_quantization_enum=_HOST_ENUM):
    error = validate_session_listening_source(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    target = params["target"]
    track = _resolve_track(context, target["track"], bounded=True)
    clip = _resolve_clip(context, target, scan_limit=256)
    before = _state(context, track, clip)
    audio, midi = _boolean(clip, "is_audio_clip"), _boolean(clip, "is_midi_clip")
    warping = _boolean(clip, "warping")
    kind = "unknown"
    if midi is True and audio is False:
        kind = "midi"
    elif audio is True and midi is False and warping is not None:
        kind = "warped-audio" if warping else "unwarped-audio"
    tempo = _safe_lom_getattr(context.song, "tempo")
    settings = {
        "tempoBpm": tempo if _number(tempo, positive=True) else None,
        "signatureNumerator": _index(context.song, "signature_numerator", 1, 128),
        "signatureDenominator": _index(context.song, "signature_denominator", 1, 128),
        "globalQuantization": _index(context.song, "clip_trigger_quantization", 0, 14),
        "launchQuantization": _clip_launch_quantization(
            clip, ClipLaunchQuantization if launch_quantization_enum is _HOST_ENUM
            else launch_quantization_enum,
        ),
        "launchMode": _index(clip, "launch_mode", 0, 3),
        "legato": _boolean(clip, "legato"),
        "followActionEnabled": _boolean(clip, "follow_action_enabled"),
        "looping": _boolean(clip, "looping"),
    }
    for public, private in (
        ("startMarker", "start_marker"), ("endMarker", "end_marker"),
        ("loopStart", "loop_start"), ("loopEnd", "loop_end"),
    ):
        settings[public] = _coordinate(clip, private)
    after = _state(context, track, clip)
    _resolve_clip(context, target, scan_limit=256)
    return {
        "schemaVersion": 1, "queryId": params["queryId"], "target": target,
        "projectRevision": context.project_revision,
        "evidence": "message-rate-only", "nativeAlignment": "unverified",
        "sourceKind": kind,
        "positionUnit": None if kind == "unknown" else "seconds" if kind == "unwarped-audio" else "beats",
        "before": before, "after": after, "settings": settings,
    }


def register_session_listening_source(registry):
    registry.register(
        "listening.inspect_session_source", inspect_session_listening_source,
        capability="listening.inspect_session_source",
        validator=validate_session_listening_source,
    )
