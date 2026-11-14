"""Bounded read-only Arrangement evidence; unavailable properties stay unavailable."""

from .core_domain_commands import _clip_reference, _integer, _number, _resolve_track, _strict, _track_target, _uuid
from .errors import ProtocolFailure
from .system_commands import _safe_lom_getattr
from .listening_commands import _source_evidence


def validate_arrangement_listening_source(params):
    if not _strict(params, ("schemaVersion", "queryId", "track", "range")):
        return "Invalid Arrangement source inspection"
    target, window = params["track"], params["range"]
    if not (_integer(params["schemaVersion"], 1, 1) and _uuid(params["queryId"])
            and _track_target(target) and target["kind"] == "regular"
            and _integer(target["index"], 0, 255)
            and _strict(window, ("startBeat", "endBeat"))
            and _number(window["startBeat"], 0, 1576800)
            and _number(window["endBeat"], 0, 1576800)
            and window["endBeat"] > window["startBeat"]):
        return "Invalid exact Arrangement track or range"
    return None


def _boolean(obj, key):
    value = _safe_lom_getattr(obj, key)
    return value if isinstance(value, bool) else None


def _numeric(obj, key, positive=False):
    value = _safe_lom_getattr(obj, key)
    return value if _number(value, positive=positive) else None


def _state(context, track):
    song = context.song
    counts = [0, 0]
    tracks = _safe_lom_getattr(song, "tracks")
    if tracks is None or len(tracks) > 256:
        raise ProtocolFailure("unsupported_capability", "Unbounded Session source inventory")
    for owner in tracks:
        slots = _safe_lom_getattr(owner, "clip_slots")
        if slots is None or len(slots) > 256:
            raise ProtocolFailure("unsupported_capability", "Unbounded Session slot inventory")
        for slot in slots:
            triggered = _boolean(slot, "is_triggered")
            has_clip = _boolean(slot, "has_clip")
            if triggered is None or has_clip is None:
                counts[1] = None
            elif triggered and counts[1] is not None:
                counts[1] += 1
            if has_clip:
                playing = _boolean(_safe_lom_getattr(slot, "clip"), "is_playing")
                if playing is None:
                    counts[0] = None
                elif playing and counts[0] is not None:
                    counts[0] += 1
    monitoring = _safe_lom_getattr(track, "current_monitoring_state")
    try:
        monitoring = int(monitoring) if not isinstance(monitoring, (bool, str)) and monitoring is not None else None
    except (TypeError, ValueError, OverflowError):
        monitoring = None
    evidence = _source_evidence(song, track)
    eligible = None if evidence["state"] == "unknown" else evidence["state"] == "arrangement"
    return {
        "transportPlaying": _boolean(song, "is_playing"),
        "currentBeat": _numeric(song, "current_song_time"),
        "tempoBpm": _numeric(song, "tempo", True),
        "loopEnabled": _boolean(song, "loop"),
        "arrangementRecord": _boolean(song, "record_mode"),
        "sessionRecord": _boolean(song, "session_record"),
        "overdub": _boolean(song, "overdub"),
        "sessionAutomationRecord": _boolean(song, "session_automation_record"),
        "globalBackToArrangement": _boolean(song, "back_to_arranger"),
        "targetArmed": _boolean(track, "arm"),
        "targetMonitoring": monitoring if _integer(monitoring, 0, 2) else None,
        "arrangementEligible": eligible,
        "playingSessionClips": counts[0], "queuedSessionClips": counts[1],
    }


def inspect_arrangement_listening_source(context, params):
    error = validate_arrangement_listening_source(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    track = _resolve_track(context, params["track"], bounded=True)
    before = _state(context, track)
    collection = _safe_lom_getattr(track, "arrangement_clips")
    if collection is None or len(collection) > 256:
        raise ProtocolFailure("unsupported_capability", "Arrangement inventory missing or truncated")
    clips = []
    for clip in collection:
        start, end = _numeric(clip, "start_time"), _numeric(clip, "end_time")
        if start is None or end is None or end <= start:
            raise ProtocolFailure("unsupported_capability", "Arrangement interval unavailable")
        if end <= params["range"]["startBeat"] or start >= params["range"]["endBeat"]:
            continue
        if _boolean(clip, "is_audio_clip") is not True:
            raise ProtocolFailure("unsupported_capability", "Expected Arrangement audio source")
        path = _safe_lom_getattr(clip, "file_path")
        item = {
            "clipId": _clip_reference(context, clip, bounded=True),
            "name": _safe_lom_getattr(clip, "name", ""),
            "startBeat": start, "endBeat": end,
            "filePath": path if isinstance(path, str) and 0 < len(path) <= 4096 else None,
            "sampleRate": _numeric(clip, "sample_rate", True),
            "sampleLength": _numeric(clip, "sample_length", True),
            "recording": _boolean(clip, "is_recording"),
            "warped": _boolean(clip, "warping"),
            "looping": _boolean(clip, "looping"),
        }
        for public, private in (("startMarker", "start_marker"), ("endMarker", "end_marker"),
                                ("loopStart", "loop_start"), ("loopEnd", "loop_end"),
                                ("gain", "gain"), ("pitchCoarse", "pitch_coarse"), ("pitchFine", "pitch_fine")):
            item[public] = _numeric(clip, private)
        clips.append(item)
    after = _state(context, track)
    _resolve_track(context, params["track"], bounded=True)
    project_path = _safe_lom_getattr(context.song, "file_path")
    return dict(params, projectRevision=context.project_revision, evidence="message-rate-only",
                projectPath=project_path if isinstance(project_path, str) and 0 < len(project_path) <= 4096 else None,
                before=before, after=after, clips=sorted(clips, key=lambda clip: (clip["startBeat"], clip["clipId"])))


def register_arrangement_listening_source(registry):
    registry.register("listening.inspect_arrangement_source", inspect_arrangement_listening_source,
                      capability="listening.inspect_arrangement_source", validator=validate_arrangement_listening_source)
