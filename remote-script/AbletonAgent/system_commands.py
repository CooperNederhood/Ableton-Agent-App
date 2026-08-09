"""System and session inspection commands."""

from __future__ import absolute_import, unicode_literals

import math
import uuid

try:
    from Live.Clip import MidiNoteSpecification
except ImportError:  # pragma: no cover - available only inside Live
    MidiNoteSpecification = None

from .executor import DeferredResult
from .errors import ProtocolFailure

ARRANGEMENT_MAX_BEATS = 1576800


def _track_kind(track):
    return "midi" if getattr(track, "has_midi_input", False) else "audio"


def _is_finite_number(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _track_reference(context, track):
    current_tracks = list(context.song.tracks)
    references = [
        (candidate, reference)
        for candidate, reference in getattr(context, "_track_references", [])
        if any(candidate is current for current in current_tracks)
    ]
    for candidate, reference in references:
        if candidate is track:
            context._track_references = references
            return reference
    reference = str(uuid.uuid4())
    references.append((track, reference))
    context._track_references = references
    return reference


def _clip_reference(context, clip):
    current_clips = [
        slot.clip
        for track in context.song.tracks
        for slot in track.clip_slots
        if slot.has_clip
    ]
    current_clips.extend(
        clip
        for track in context.song.tracks
        for clip in getattr(track, "arrangement_clips", [])
    )
    references = [
        (candidate, reference)
        for candidate, reference in getattr(context, "_clip_references", [])
        if any(candidate is current for current in current_clips)
    ]
    for candidate, reference in references:
        if candidate is clip:
            context._clip_references = references
            return reference
    reference = str(uuid.uuid4())
    references.append((clip, reference))
    context._clip_references = references
    return reference


def _cue_point_reference(context, cue_point):
    current_cue_points = list(context.song.cue_points)
    references = [
        (candidate, reference)
        for candidate, reference in getattr(
            context, "_cue_point_references", []
        )
        if any(candidate is current for current in current_cue_points)
    ]
    for candidate, reference in references:
        if candidate is cue_point:
            context._cue_point_references = references
            return reference
    reference = str(uuid.uuid4())
    references.append((cue_point, reference))
    context._cue_point_references = references
    return reference


def _cue_point_summary(context, cue_point):
    if not _is_finite_number(cue_point.time) or cue_point.time < 0:
        raise ProtocolFailure(
            "conflict", "Cue point has invalid current numeric state"
        )
    return {
        "reference": _cue_point_reference(context, cue_point),
        "name": cue_point.name,
        "time": cue_point.time,
    }


def _arrangement_loop_state(song):
    return {
        "enabled": bool(song.loop),
        "start": song.loop_start,
        "length": song.loop_length,
    }


def _clip_notes(clip):
    if not hasattr(clip, "get_all_notes_extended"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support complete MIDI note access",
        )
    return list(clip.get_all_notes_extended())


def _clip_summary(context, track, track_index, scene_index, clip):
    return {
        "reference": _clip_reference(context, clip),
        "trackReference": _track_reference(context, track),
        "trackIndex": track_index,
        "sceneIndex": scene_index,
        "name": clip.name,
        "length": clip.length,
        "noteCount": len(_clip_notes(clip)),
    }


def _session_view_clip_summary(
    context, track, track_index, scene_index, clip
):
    is_midi = bool(getattr(clip, "is_midi_clip", False))
    note_count = (
        len(_clip_notes(clip))
        if is_midi and hasattr(clip, "get_all_notes_extended")
        else None
    )
    return {
        "reference": _clip_reference(context, clip),
        "trackReference": _track_reference(context, track),
        "trackIndex": track_index,
        "sceneIndex": scene_index,
        "name": clip.name,
        "kind": "midi" if is_midi else "audio",
        "length": clip.length,
        "noteCount": note_count,
        "muted": (
            bool(clip.muted) if hasattr(clip, "muted") else None
        ),
        "looping": (
            bool(clip.looping) if hasattr(clip, "looping") else None
        ),
        "isPlaying": bool(getattr(clip, "is_playing", False)),
        "isTriggered": bool(getattr(clip, "is_triggered", False)),
    }


def _track_mixer_state(track):
    mixer = track.mixer_device
    return {
        "isMuted": bool(track.mute),
        "isSoloed": bool(track.solo),
        "isArmed": bool(getattr(track, "arm", False)),
        "volume": mixer.volume.value,
        "pan": mixer.panning.value,
    }


def _resolve_track(context, params, allow_group=False):
    song = context.song
    index = params["index"]
    if index >= len(song.tracks):
        raise ProtocolFailure("not_found", "Track index is out of range")
    track = song.tracks[index]
    if not allow_group and getattr(track, "is_foldable", False):
        raise ProtocolFailure(
            "conflict",
            "Group tracks are not supported by this operation",
            details={"index": index, "name": track.name},
        )
    reference = _track_reference(context, track)
    if (
        reference != params["expectedReference"]
        or track.name != params["expectedName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Track identity changed before mutation",
            details={
                "index": index,
                "expectedReference": params["expectedReference"],
                "actualReference": reference,
                "expectedName": params["expectedName"],
                "actualName": track.name,
            },
        )
    return track


def _validate_track_target(params, extra_keys=None):
    required = set(["index", "expectedReference", "expectedName"])
    accepted = required | set(extra_keys or [])
    if set(params.keys()) - accepted or not required.issubset(params.keys()):
        return "index, expectedReference, and expectedName are required"
    index = params.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "index must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedReference must be a UUID"
    expected_name = params.get("expectedName")
    if not isinstance(expected_name, str) or not expected_name:
        return "expectedName must be a non-empty string"
    return None


def _no_params(params):
    if params:
        return "Command does not accept parameters"
    return None


def ping(_context, _params):
    return {"pong": True}


def inspect_session(context, _params):
    song = context.song
    tracks = []
    clips = []
    for index, track in enumerate(song.tracks):
        tracks.append(
            {
                "index": index,
                "reference": _track_reference(context, track),
                "name": track.name,
                "kind": _track_kind(track),
                "color": getattr(track, "color", None),
                "isMuted": bool(track.mute),
                "isSoloed": bool(track.solo),
                "isArmed": bool(getattr(track, "arm", False)),
                "volume": track.mixer_device.volume.value,
                "pan": track.mixer_device.panning.value,
            }
        )
        for scene_index, slot in enumerate(track.clip_slots):
            if slot.has_clip:
                clips.append(
                    _session_view_clip_summary(
                        context, track, index, scene_index, slot.clip
                    )
                )
    return {
        "tempo": song.tempo,
        "timeSignature": {
            "numerator": song.signature_numerator,
            "denominator": song.signature_denominator,
        },
        "isPlaying": bool(song.is_playing),
        "trackCount": len(tracks),
        "tracks": tracks,
        "clips": clips,
    }

def _set_tempo_params(params):
    if set(params.keys()) != set(["tempo"]):
        return "tempo is the only accepted parameter"
    tempo = params.get("tempo")
    if isinstance(tempo, bool) or not isinstance(tempo, (int, float)):
        return "tempo must be a number"
    if tempo < 20 or tempo > 999:
        return "tempo must be between 20 and 999 BPM"
    return None


def set_tempo(context, params):
    before = context.song.tempo
    context.song.tempo = params["tempo"]
    after = context.song.tempo
    return {
        "beforeTempo": before,
        "afterTempo": after,
        "verified": abs(after - params["tempo"]) < 0.001,
    }

def _set_playing_params(params):
    if set(params.keys()) != set(["isPlaying"]):
        return "isPlaying is the only accepted parameter"
    if not isinstance(params.get("isPlaying"), bool):
        return "isPlaying must be a boolean"
    return None


def set_playing(context, params):
    song = context.song
    before = bool(song.is_playing)
    if params["isPlaying"]:
        song.start_playing()
    else:
        song.stop_playing()

    def start_verification(on_success, on_failure):
        def verify():
            try:
                after = bool(song.is_playing)
                on_success(
                    {
                        "beforeIsPlaying": before,
                        "afterIsPlaying": after,
                        "verified": after == params["isPlaying"],
                    }
                )
            except Exception as exc:
                on_failure(exc)

        context.schedule_message(1, verify)

    return DeferredResult(start_verification)


def _inspect_arrangement_transport_params(params):
    if set(params.keys()) - set(["offset", "limit"]):
        return "Only offset and limit are accepted"
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        return "offset must be a non-negative integer"
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > 512
    ):
        return "limit must be an integer from 1 to 512"
    return None


def inspect_arrangement_transport(context, params):
    song = context.song
    required = ("loop", "loop_start", "loop_length", "cue_points")
    if any(not hasattr(song, attribute) for attribute in required):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not expose Arrangement loop and cue-point state",
        )
    cue_points = sorted(list(song.cue_points), key=lambda cue: cue.time)
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    return {
        "loop": _arrangement_loop_state(song),
        "cuePoints": [
            _cue_point_summary(context, cue_point)
            for cue_point in cue_points[offset : offset + limit]
        ],
        "totalCuePoints": len(cue_points),
        "offset": offset,
        "limit": limit,
    }


def _set_arrangement_loop_params(params):
    accepted = set(["enabled", "start", "length"])
    if set(params.keys()) - accepted:
        return "Only enabled, start, and length are accepted"
    if not params:
        return "At least one Arrangement loop property is required"
    if "enabled" in params and not isinstance(params.get("enabled"), bool):
        return "enabled must be a boolean"
    start = params.get("start")
    if "start" in params and (
        not _is_finite_number(start)
        or start < 0
        or start > ARRANGEMENT_MAX_BEATS
    ):
        return "start must be between 0 and 1576800 beats"
    length = params.get("length")
    if "length" in params and (
        not _is_finite_number(length)
        or length <= 0
        or length > ARRANGEMENT_MAX_BEATS
    ):
        return "length must be greater than 0 and at most 1576800 beats"
    if (
        "start" in params
        and "length" in params
        and start + length > ARRANGEMENT_MAX_BEATS
    ):
        return "Arrangement loop end must not exceed 1576800 beats"
    return None


def _loop_states_equal(left, right):
    return (
        left["enabled"] == right["enabled"]
        and abs(left["start"] - right["start"]) < 0.000001
        and abs(left["length"] - right["length"]) < 0.000001
    )


def set_arrangement_loop(context, params):
    song = context.song
    required = ("loop", "loop_start", "loop_length")
    if any(not hasattr(song, attribute) for attribute in required):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support Arrangement loop control",
        )
    before = _arrangement_loop_state(song)
    if (
        not _is_finite_number(before["start"])
        or before["start"] < 0
        or not _is_finite_number(before["length"])
        or before["length"] <= 0
    ):
        raise ProtocolFailure(
            "conflict", "Arrangement loop has invalid current numeric state"
        )
    target_start = params.get("start", before["start"])
    target_length = params.get("length", before["length"])
    if target_start + target_length > ARRANGEMENT_MAX_BEATS:
        raise ProtocolFailure(
            "invalid_params",
            "Arrangement loop end must not exceed 1576800 beats",
        )
    requested = []
    if params.get("enabled") is False:
        requested.append(("loop", "enabled", False))
    if "start" in params:
        requested.append(("loop_start", "start", params["start"]))
    if "length" in params:
        requested.append(("loop_length", "length", params["length"]))
    if params.get("enabled") is True:
        requested.append(("loop", "enabled", True))
    applied = []
    try:
        for attribute, state_key, value in requested:
            applied.append((attribute, state_key))
            setattr(song, attribute, value)
        after = _arrangement_loop_state(song)
        expected = dict(before)
        expected.update(params)
        if not _loop_states_equal(after, expected):
            raise ProtocolFailure(
                "conflict",
                "Arrangement loop update completed but verification failed",
            )
        result = {"before": before, "after": after, "verified": True}
    except Exception as exc:
        try:
            for attribute, state_key in reversed(applied):
                setattr(song, attribute, before[state_key])
            restored = _arrangement_loop_state(song)
            if not _loop_states_equal(restored, before):
                raise RuntimeError("Arrangement loop state was not restored")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Arrangement loop update and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Arrangement loop update failed; prior state was restored",
            details={"operationError": str(exc)},
        )
    return result


def _create_cue_point_params(params):
    if set(params.keys()) - set(["time", "name"]) or "time" not in params:
        return "time is required; optional name is the only other parameter"
    time = params.get("time")
    if (
        not _is_finite_number(time)
        or time < 0
        or time > ARRANGEMENT_MAX_BEATS
    ):
        return "time must be between 0 and 1576800 beats"
    name = params.get("name")
    if name is not None and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    return None


def _set_or_delete_cue_at_time(song, time):
    previous_time = song.current_song_time
    try:
        song.current_song_time = time
        return song.set_or_delete_cue()
    finally:
        song.current_song_time = previous_time


def create_cue_point(context, params):
    song = context.song
    if (
        not hasattr(song, "cue_points")
        or not hasattr(song, "current_song_time")
        or not hasattr(song, "set_or_delete_cue")
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support safe cue-point creation",
        )
    if bool(getattr(song, "is_playing", False)):
        raise ProtocolFailure(
            "conflict",
            "Stop transport before creating a cue point",
        )
    before = list(song.cue_points)
    for cue_point in before:
        if abs(cue_point.time - params["time"]) < 0.000001:
            raise ProtocolFailure(
                "conflict",
                "A cue point already exists at the requested time",
                details={
                    "reference": _cue_point_reference(context, cue_point),
                    "name": cue_point.name,
                    "time": cue_point.time,
                },
            )
    try:
        created_result = _set_or_delete_cue_at_time(song, params["time"])
        created = [
            candidate
            for candidate in song.cue_points
            if not any(candidate is previous for previous in before)
        ]
        if len(created) != 1:
            raise ProtocolFailure(
                "conflict",
                "Cue-point creation produced an unexpected number of objects",
            )
        cue_point = created[0]
        if created_result is not None and created_result is not cue_point:
            raise ProtocolFailure(
                "conflict",
                "Cue-point creation returned an unexpected object",
            )
        if "name" in params:
            if not hasattr(cue_point, "name"):
                raise ProtocolFailure(
                    "unsupported_capability",
                    "This Live version does not support cue-point naming",
                )
            cue_point.name = params["name"].strip()
        current = list(song.cue_points)
        if (
            len(current) != len(before) + 1
            or not any(candidate is cue_point for candidate in current)
            or any(
                not any(candidate is previous for candidate in current)
                for previous in before
            )
            or abs(cue_point.time - params["time"]) >= 0.000001
            or (
                "name" in params
                and cue_point.name != params["name"].strip()
            )
        ):
            raise ProtocolFailure(
                "conflict",
                "Cue-point creation completed but verification failed",
            )
        result = {
            "cuePoint": _cue_point_summary(context, cue_point),
            "beforeCuePointCount": len(before),
            "afterCuePointCount": len(current),
            "verified": True,
        }
    except Exception as exc:
        try:
            created = [
                candidate
                for candidate in song.cue_points
                if not any(candidate is previous for previous in before)
            ]
            for candidate in created:
                _set_or_delete_cue_at_time(song, candidate.time)
            current = list(song.cue_points)
            if len(current) != len(before) or any(
                not any(candidate is previous for candidate in current)
                for previous in before
            ):
                raise RuntimeError("Cue-point before-state was not restored")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Cue-point creation and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Cue-point creation failed; the new cue point was removed",
            details={"operationError": str(exc)},
        )
    return result


def _delete_cue_point_params(params):
    required = set(["expectedReference", "expectedName", "expectedTime"])
    if set(params.keys()) != required:
        return "expectedReference, expectedName, and expectedTime are required"
    try:
        uuid.UUID(params.get("expectedReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedReference must be a UUID"
    if not isinstance(params.get("expectedName"), str):
        return "expectedName must be a string"
    time = params.get("expectedTime")
    if (
        not _is_finite_number(time)
        or time < 0
        or time > ARRANGEMENT_MAX_BEATS
    ):
        return "expectedTime must be between 0 and 1576800 beats"
    return None


def delete_cue_point(context, params):
    song = context.song
    if (
        not hasattr(song, "cue_points")
        or not hasattr(song, "current_song_time")
        or not hasattr(song, "set_or_delete_cue")
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support cue-point deletion",
        )
    if bool(getattr(song, "is_playing", False)):
        raise ProtocolFailure(
            "conflict",
            "Stop transport before deleting a cue point",
        )
    target = None
    for cue_point in song.cue_points:
        if (
            _cue_point_reference(context, cue_point)
            == params["expectedReference"]
        ):
            target = cue_point
            break
    if target is None:
        raise ProtocolFailure("not_found", "Cue point no longer exists")
    if (
        not _is_finite_number(target.time)
        or target.time < 0
        or target.name != params["expectedName"]
        or abs(target.time - params["expectedTime"]) >= 0.000001
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Cue-point identity changed before deletion",
            details={
                "expectedName": params["expectedName"],
                "actualName": target.name,
                "expectedTime": params["expectedTime"],
                "actualTime": target.time,
            },
        )
    before = list(song.cue_points)
    summary = _cue_point_summary(context, target)
    _set_or_delete_cue_at_time(song, target.time)
    after = list(song.cue_points)
    if (
        len(after) != len(before) - 1
        or any(candidate is target for candidate in after)
        or any(
            previous is not target
            and not any(candidate is previous for candidate in after)
            for previous in before
        )
    ):
        raise ProtocolFailure(
            "conflict",
            "Cue-point deletion completed but verification failed",
        )
    return {
        "cuePoint": summary,
        "beforeCuePointCount": len(before),
        "afterCuePointCount": len(after),
        "verified": True,
    }


def _create_track_params(params):
    if set(params.keys()) - set(["kind", "name"]):
        return "Only kind and name are accepted"
    if params.get("kind") not in ("midi", "audio"):
        return "kind must be midi or audio"
    name = params.get("name")
    if name is not None and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    return None


def create_track(context, params):
    song = context.song
    before_count = len(song.tracks)
    index = before_count
    if params["kind"] == "midi":
        song.create_midi_track(index)
    else:
        song.create_audio_track(index)
    created = song.tracks[index]
    if params.get("name") is not None:
        created.name = params["name"].strip()
    after_count = len(song.tracks)
    verified = (
        after_count == before_count + 1
        and song.tracks[index] is created
        and _track_kind(created) == params["kind"]
        and (
            params.get("name") is None
            or created.name == params["name"].strip()
        )
    )
    if not verified:
        raise ProtocolFailure(
            "conflict",
            "Track creation completed but postcondition verification failed",
            details={
                "beforeTrackCount": before_count,
                "afterTrackCount": after_count,
            },
        )
    return {
        "beforeTrackCount": before_count,
        "afterTrackCount": after_count,
        "track": {
            "index": index,
            "reference": _track_reference(context, created),
            "name": created.name,
            "kind": params["kind"],
        },
        "verified": True,
    }


def _delete_track_params(params):
    if set(params.keys()) != set(
        ["index", "expectedReference", "expectedName", "expectedKind"]
    ):
        return (
            "index, expectedReference, expectedName, and expectedKind "
            "are required"
        )
    index = params.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "index must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedReference must be a UUID"
    expected_name = params.get("expectedName")
    if not isinstance(expected_name, str) or not expected_name:
        return "expectedName must be a non-empty string"
    if params.get("expectedKind") not in ("midi", "audio"):
        return "expectedKind must be midi or audio"
    return None


def delete_track(context, params):
    song = context.song
    before_count = len(song.tracks)
    if before_count <= 1:
        raise ProtocolFailure(
            "conflict", "Cannot delete the last remaining track"
        )
    index = params["index"]
    track = _resolve_track(context, params)
    kind = _track_kind(track)
    if kind != params["expectedKind"]:
        raise ProtocolFailure(
            "stale_reference",
            "Track identity changed before deletion",
            details={
                "index": index,
                "expectedKind": params["expectedKind"],
                "actualKind": kind,
            },
        )
    deleted = {
        "index": index,
        "reference": _track_reference(context, track),
        "name": track.name,
        "kind": kind,
    }
    song.delete_track(index)
    after_count = len(song.tracks)
    if after_count != before_count - 1:
        raise ProtocolFailure(
            "conflict",
            "Track deletion completed but postcondition verification failed",
            details={
                "beforeTrackCount": before_count,
                "afterTrackCount": after_count,
            },
        )
    return {
        "beforeTrackCount": before_count,
        "afterTrackCount": after_count,
        "track": deleted,
        "verified": True,
    }


def _rename_track_params(params):
    error = _validate_track_target(params, ["name"])
    if error:
        return error
    name = params.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        return "name must be a non-empty string of at most 128 characters"
    return None


def rename_track(context, params):
    track = _resolve_track(context, params, allow_group=True)
    reference = _track_reference(context, track)
    before = track.name
    requested = params["name"].strip()
    track.name = requested
    after = track.name
    if after != requested:
        raise ProtocolFailure(
            "conflict",
            "Track rename completed but postcondition verification failed",
            details={"beforeName": before, "afterName": after},
        )
    return {
        "reference": reference,
        "index": params["index"],
        "beforeName": before,
        "afterName": after,
        "verified": True,
    }


def _set_track_mixer_params(params):
    fields = ["isMuted", "isSoloed", "isArmed", "volume", "pan"]
    error = _validate_track_target(params, fields)
    if error:
        return error
    if not any(field in params for field in fields):
        return "At least one mixer property is required"
    for field in ("isMuted", "isSoloed", "isArmed"):
        if field in params and not isinstance(params[field], bool):
            return "{0} must be a boolean".format(field)
    for field, lower, upper in (("volume", 0.0, 1.0), ("pan", -1.0, 1.0)):
        if field in params:
            value = params[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return "{0} must be a number".format(field)
            if value < lower or value > upper:
                return "{0} must be between {1} and {2}".format(
                    field, lower, upper
                )
    return None


def set_track_mixer(context, params):
    track = _resolve_track(context, params, allow_group=True)
    if "isArmed" in params and not bool(
        getattr(track, "can_be_armed", hasattr(track, "arm"))
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This track cannot be armed",
        )
    before = _track_mixer_state(track)
    if "isMuted" in params:
        track.mute = params["isMuted"]
    if "isSoloed" in params:
        track.solo = params["isSoloed"]
    if "isArmed" in params:
        track.arm = params["isArmed"]
    if "volume" in params:
        track.mixer_device.volume.value = params["volume"]
    if "pan" in params:
        track.mixer_device.panning.value = params["pan"]
    after = _track_mixer_state(track)
    expected = dict(before)
    for param, result_key in (
        ("isMuted", "isMuted"),
        ("isSoloed", "isSoloed"),
        ("isArmed", "isArmed"),
        ("volume", "volume"),
        ("pan", "pan"),
    ):
        if param in params:
            expected[result_key] = params[param]
    verified = all(
        abs(after[key] - value) < 0.000001
        if isinstance(value, float)
        else after[key] == value
        for key, value in expected.items()
    )
    if not verified:
        raise ProtocolFailure(
            "conflict",
            "Track mixer update completed but verification failed",
            details={"before": before, "after": after},
        )
    return {
        "reference": _track_reference(context, track),
        "index": params["index"],
        "before": before,
        "after": after,
        "verified": True,
    }


def _create_midi_clip_params(params):
    error = _validate_track_target(params, ["sceneIndex", "length", "name"])
    if error:
        return error
    scene_index = params.get("sceneIndex")
    if (
        isinstance(scene_index, bool)
        or not isinstance(scene_index, int)
        or scene_index < 0
    ):
        return "sceneIndex must be a non-negative integer"
    length = params.get("length")
    if isinstance(length, bool) or not isinstance(length, (int, float)):
        return "length must be a number"
    if length <= 0 or length > 4096:
        return "length must be greater than zero and at most 4096 beats"
    name = params.get("name")
    if name is not None and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    return None


def create_midi_clip(context, params):
    track = _resolve_track(context, params)
    if not getattr(track, "has_midi_input", False):
        raise ProtocolFailure(
            "unsupported_capability",
            "MIDI clips can only be created on MIDI tracks",
        )
    scene_index = params["sceneIndex"]
    if scene_index >= len(track.clip_slots):
        raise ProtocolFailure("not_found", "Scene index is out of range")
    slot = track.clip_slots[scene_index]
    if slot.has_clip:
        raise ProtocolFailure(
            "conflict",
            "Clip slot is already occupied",
            details={"sceneIndex": scene_index},
        )
    try:
        slot.create_clip(params["length"])
        clip = slot.clip
        if params.get("name") is not None:
            clip.name = params["name"].strip()
        if (
            not slot.has_clip
            or abs(clip.length - params["length"]) >= 0.000001
            or (
                params.get("name") is not None
                and clip.name != params["name"].strip()
            )
        ):
            raise ProtocolFailure(
                "conflict",
                "MIDI clip creation completed but verification failed",
            )
        result = {
            "clip": _clip_summary(
                context, track, params["index"], scene_index, clip
            ),
            "verified": True,
        }
    except Exception as exc:
        try:
            if slot.has_clip:
                slot.delete_clip()
            if slot.has_clip:
                raise RuntimeError("clip slot remained occupied")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "MIDI clip creation and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise
    return result


def _replace_midi_notes_params(params):
    error = _validate_track_target(
        params,
        [
            "sceneIndex",
            "expectedClipReference",
            "allowPerNoteExpressionLoss",
            "notes",
        ],
    )
    if error:
        return error
    scene_index = params.get("sceneIndex")
    if (
        isinstance(scene_index, bool)
        or not isinstance(scene_index, int)
        or scene_index < 0
    ):
        return "sceneIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedClipReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedClipReference must be a UUID"
    if not isinstance(params.get("allowPerNoteExpressionLoss"), bool):
        return "allowPerNoteExpressionLoss must be a boolean"
    notes = params.get("notes")
    if not isinstance(notes, list) or len(notes) > 2048:
        return "notes must be an array with at most 2048 items"
    accepted = set(["pitch", "startTime", "duration", "velocity", "mute"])
    required = set(["pitch", "startTime", "duration", "velocity"])
    for note in notes:
        if (
            not isinstance(note, dict)
            or set(note.keys()) - accepted
            or not required.issubset(note.keys())
        ):
            return "Each note has invalid or missing fields"
        pitch = note.get("pitch")
        velocity = note.get("velocity")
        start_time = note.get("startTime")
        duration = note.get("duration")
        if (
            isinstance(pitch, bool)
            or not isinstance(pitch, int)
            or pitch < 0
            or pitch > 127
        ):
            return "note pitch must be an integer from 0 to 127"
        if (
            isinstance(velocity, bool)
            or not isinstance(velocity, int)
            or velocity < 1
            or velocity > 127
        ):
            return "note velocity must be an integer from 1 to 127"
        if (
            not _is_finite_number(start_time)
            or start_time < 0
        ):
            return "note startTime must be a non-negative number"
        if (
            not _is_finite_number(duration)
            or duration <= 0
        ):
            return "note duration must be greater than zero"
        if "mute" in note and not isinstance(note["mute"], bool):
            return "note mute must be a boolean"
    return None


def _note_value(note, key):
    if isinstance(note, dict):
        return note[key]
    return getattr(note, key)


def _note_value_or(note, key, default):
    if isinstance(note, dict):
        return note.get(key, default)
    return getattr(note, key, default)


def _note_specification(note_factory, note):
    return note_factory(
        pitch=_note_value(note, "pitch"),
        start_time=_note_value(note, "start_time"),
        duration=_note_value(note, "duration"),
        velocity=_note_value(note, "velocity"),
        mute=bool(_note_value(note, "mute")),
        probability=_note_value_or(note, "probability", 1.0),
        velocity_deviation=_note_value_or(
            note, "velocity_deviation", 0.0
        ),
        release_velocity=_note_value_or(note, "release_velocity", 64.0),
    )


def _replace_all_clip_notes(clip, notes):
    existing_note_ids = tuple(
        _note_value(note, "note_id") for note in _clip_notes(clip)
    )
    if existing_note_ids:
        clip.remove_notes_by_id(existing_note_ids)
    if notes:
        return tuple(clip.add_new_notes(notes))
    return ()


def _restore_clip_notes(clip, added_note_ids, backup_notes):
    if added_note_ids:
        clip.remove_notes_by_id(added_note_ids)
    if backup_notes:
        clip.add_new_notes(backup_notes)


def _replace_midi_clip_notes(context, clip, params, summarize):
    note_factory = getattr(context, "midi_note_factory", MidiNoteSpecification)
    if (
        not hasattr(clip, "remove_notes_by_id")
        or not hasattr(clip, "add_new_notes")
        or note_factory is None
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support complete MIDI note editing",
        )
    for note in params["notes"]:
        if note["startTime"] + note["duration"] > clip.length + 0.000001:
            raise ProtocolFailure(
                "invalid_params",
                "Notes must fit within the clip length",
            )
    original_notes = _clip_notes(clip)
    before_count = len(original_notes)
    if before_count and not params["allowPerNoteExpressionLoss"]:
        raise ProtocolFailure(
            "conflict",
            "Replacing notes may discard per-note expression data; explicit opt-in is required",
        )
    backup_notes = tuple(
        _note_specification(note_factory, note) for note in original_notes
    )
    new_notes = tuple(
        note_factory(
            pitch=note["pitch"],
            start_time=note["startTime"],
            duration=note["duration"],
            velocity=note["velocity"],
            mute=note.get("mute", False),
        )
        for note in params["notes"]
    )
    try:
        added_note_ids = _replace_all_clip_notes(clip, new_notes)
    except Exception as exc:
        try:
            _replace_all_clip_notes(clip, backup_notes)
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "MIDI note replacement and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        raise ProtocolFailure(
            "lom_error",
            "MIDI note replacement failed; core note data was restored but per-note expression may be lost",
            details={
                "operationError": str(exc),
                "perNoteExpressionMayBeLost": True,
            },
        )
    try:
        observed = _clip_notes(clip)
        expected = sorted(
            [
                (
                    note["pitch"],
                    note["startTime"],
                    note["duration"],
                    note["velocity"],
                    note.get("mute", False),
                )
                for note in params["notes"]
            ]
        )
        actual = sorted(
            [
                (
                    _note_value(note, "pitch"),
                    _note_value(note, "start_time"),
                    _note_value(note, "duration"),
                    _note_value(note, "velocity"),
                    bool(_note_value(note, "mute")),
                )
                for note in observed
            ]
        )
        verified = len(actual) == len(expected) and all(
            left[0] == right[0]
            and abs(left[1] - right[1]) < 0.000001
            and abs(left[2] - right[2]) < 0.000001
            and left[3:] == right[3:]
            for left, right in zip(actual, expected)
        )
        if not verified:
            raise ProtocolFailure(
                "conflict",
                "MIDI note verification failed; original notes were restored",
                details={
                    "beforeNoteCount": before_count,
                    "afterNoteCount": len(actual),
                },
            )
        result = {
            "clip": summarize(),
            "beforeNoteCount": before_count,
            "afterNoteCount": len(actual),
            "verified": True,
        }
    except Exception as exc:
        try:
            _restore_clip_notes(clip, added_note_ids, backup_notes)
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "MIDI note postcondition check and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "MIDI note postcondition check failed; core note data was restored but per-note expression may be lost",
            details={
                "operationError": str(exc),
                "perNoteExpressionMayBeLost": True,
            },
        )
    return result


def replace_midi_notes(context, params):
    track = _resolve_track(context, params)
    scene_index = params["sceneIndex"]
    if scene_index >= len(track.clip_slots):
        raise ProtocolFailure("not_found", "Scene index is out of range")
    slot = track.clip_slots[scene_index]
    if not slot.has_clip:
        raise ProtocolFailure("not_found", "Clip slot is empty")
    clip = slot.clip
    if _clip_reference(context, clip) != params["expectedClipReference"]:
        raise ProtocolFailure(
            "stale_reference",
            "Clip identity changed before note replacement",
        )
    return _replace_midi_clip_notes(
        context,
        clip,
        params,
        lambda: _clip_summary(
            context, track, params["index"], scene_index, clip
        ),
    )


def _session_clip_target_params(params, extra_keys=None):
    extras = ["sceneIndex", "expectedClipReference"] + list(
        extra_keys or []
    )
    error = _validate_track_target(params, extras)
    if error:
        return error
    scene_index = params.get("sceneIndex")
    if (
        isinstance(scene_index, bool)
        or not isinstance(scene_index, int)
        or scene_index < 0
    ):
        return "sceneIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedClipReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedClipReference must be a UUID"
    return None


def _resolve_session_clip(context, track, params, operation):
    scene_index = params["sceneIndex"]
    if scene_index >= len(track.clip_slots):
        raise ProtocolFailure("not_found", "Scene index is out of range")
    slot = track.clip_slots[scene_index]
    if not slot.has_clip:
        raise ProtocolFailure("not_found", "Clip slot is empty")
    clip = slot.clip
    if _clip_reference(context, clip) != params["expectedClipReference"]:
        raise ProtocolFailure(
            "stale_reference",
            "Clip identity changed before {0}".format(operation),
        )
    return slot, clip


def _session_clip_properties(clip):
    return {
        "name": clip.name,
        "muted": (
            bool(clip.muted) if hasattr(clip, "muted") else None
        ),
        "looping": (
            bool(clip.looping) if hasattr(clip, "looping") else None
        ),
    }


def _session_clip_launch_state(context, track, target):
    if not hasattr(track, "playing_slot_index"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not expose Session playback state",
        )
    playing_scene_index = track.playing_slot_index
    playing_reference = None
    if (
        isinstance(playing_scene_index, int)
        and playing_scene_index >= 0
        and playing_scene_index < len(track.clip_slots)
        and track.clip_slots[playing_scene_index].has_clip
    ):
        playing_reference = _clip_reference(
            context, track.clip_slots[playing_scene_index].clip
        )
    else:
        playing_scene_index = None
    return {
        "trackPlayingSceneIndex": playing_scene_index,
        "trackPlayingClipReference": playing_reference,
        "targetIsPlaying": bool(getattr(target, "is_playing", False)),
        "targetIsTriggered": bool(getattr(target, "is_triggered", False)),
    }


def _launch_session_clip_params(params):
    return _session_clip_target_params(params)


def launch_session_clip(context, params):
    track = _resolve_track(context, params)
    slot, target = _resolve_session_clip(
        context, track, params, "launch"
    )
    if not hasattr(slot, "fire") or not hasattr(slot, "stop"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support safe Session clip launch",
        )
    if not hasattr(track, "playing_slot_index"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not expose Session playback state",
        )
    if track.playing_slot_index == -2:
        raise ProtocolFailure(
            "conflict",
            "Cannot safely launch while this track is playing Arrangement content",
        )
    triggered = [
        index
        for index, candidate in enumerate(track.clip_slots)
        if candidate.has_clip
        and bool(getattr(candidate.clip, "is_triggered", False))
    ]
    if triggered and triggered != [params["sceneIndex"]]:
        raise ProtocolFailure(
            "conflict",
            "Cannot safely replace a pending Session clip launch",
        )
    before = _session_clip_launch_state(context, track, target)
    if before["targetIsPlaying"] or before["targetIsTriggered"]:
        return {
            "clip": _session_view_clip_summary(
                context,
                track,
                params["index"],
                params["sceneIndex"],
                target,
            ),
            "before": before,
            "after": before,
            "verified": True,
        }
    previous_scene_index = before["trackPlayingSceneIndex"]
    try:
        slot.fire()
        after = _session_clip_launch_state(context, track, target)
        if not (after["targetIsPlaying"] or after["targetIsTriggered"]):
            raise ProtocolFailure(
                "conflict",
                "Session clip launch completed but verification failed",
            )
        result = {
            "clip": _session_view_clip_summary(
                context,
                track,
                params["index"],
                params["sceneIndex"],
                target,
            ),
            "before": before,
            "after": after,
            "verified": True,
        }
    except Exception as exc:
        try:
            if (
                before["targetIsPlaying"]
                or before["targetIsTriggered"]
            ):
                pass
            elif previous_scene_index is not None:
                previous_slot = track.clip_slots[previous_scene_index]
                previous_slot.fire()
                previous_clip = previous_slot.clip
                if not (
                    bool(getattr(previous_clip, "is_playing", False))
                    or bool(getattr(previous_clip, "is_triggered", False))
                ):
                    raise RuntimeError(
                        "previous Session clip did not resume"
                    )
                if bool(getattr(target, "is_playing", False)) or bool(
                    getattr(target, "is_triggered", False)
                ):
                    raise RuntimeError(
                        "failed Session launch remained active"
                    )
            else:
                slot.stop()
                if bool(getattr(target, "is_playing", False)) or bool(
                    getattr(target, "is_triggered", False)
                ):
                    raise RuntimeError("launched Session clip did not stop")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Session clip launch and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Session clip launch failed; prior playback was restored",
            details={"operationError": str(exc)},
        )
    return result


def _duplicate_session_clip_params(params):
    error = _session_clip_target_params(
        params,
        [
            "destinationTrackIndex",
            "expectedDestinationTrackReference",
            "expectedDestinationTrackName",
            "destinationSceneIndex",
        ],
    )
    if error:
        return error
    destination_index = params.get("destinationTrackIndex")
    destination_scene_index = params.get("destinationSceneIndex")
    if (
        isinstance(destination_index, bool)
        or not isinstance(destination_index, int)
        or destination_index < 0
    ):
        return "destinationTrackIndex must be a non-negative integer"
    if (
        isinstance(destination_scene_index, bool)
        or not isinstance(destination_scene_index, int)
        or destination_scene_index < 0
    ):
        return "destinationSceneIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedDestinationTrackReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedDestinationTrackReference must be a UUID"
    destination_name = params.get("expectedDestinationTrackName")
    if not isinstance(destination_name, str) or not destination_name:
        return "expectedDestinationTrackName must be a non-empty string"
    return None


def duplicate_session_clip(context, params):
    source_track = _resolve_track(context, params)
    source_slot, source = _resolve_session_clip(
        context, source_track, params, "duplication"
    )
    destination_track = _resolve_track(
        context,
        {
            "index": params["destinationTrackIndex"],
            "expectedReference": params[
                "expectedDestinationTrackReference"
            ],
            "expectedName": params["expectedDestinationTrackName"],
        },
    )
    destination_scene_index = params["destinationSceneIndex"]
    if destination_scene_index >= len(destination_track.clip_slots):
        raise ProtocolFailure(
            "not_found", "Destination scene index is out of range"
        )
    destination_slot = destination_track.clip_slots[
        destination_scene_index
    ]
    if destination_slot.has_clip:
        raise ProtocolFailure(
            "conflict", "Destination clip slot is already occupied"
        )
    if not hasattr(source_slot, "duplicate_clip_to") or not hasattr(
        destination_slot, "delete_clip"
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support safe Session clip duplication",
        )
    try:
        source_slot.duplicate_clip_to(destination_slot)
        if not destination_slot.has_clip:
            raise ProtocolFailure(
                "conflict",
                "Session clip duplication completed but destination is empty",
            )
        duplicated = destination_slot.clip
        if (
            source_slot.clip is not source
            or _clip_reference(context, source)
            != params["expectedClipReference"]
            or duplicated is source
            or bool(getattr(duplicated, "is_midi_clip", False))
            != bool(getattr(source, "is_midi_clip", False))
            or abs(duplicated.length - source.length) >= 0.000001
            or duplicated.name != source.name
            or (
                hasattr(source, "muted")
                and hasattr(duplicated, "muted")
                and bool(duplicated.muted) != bool(source.muted)
            )
            or (
                hasattr(source, "looping")
                and hasattr(duplicated, "looping")
                and bool(duplicated.looping) != bool(source.looping)
            )
        ):
            raise ProtocolFailure(
                "conflict",
                "Session clip duplication completed but verification failed",
            )
        result = {
            "sourceClip": _session_view_clip_summary(
                context,
                source_track,
                params["index"],
                params["sceneIndex"],
                source,
            ),
            "clip": _session_view_clip_summary(
                context,
                destination_track,
                params["destinationTrackIndex"],
                destination_scene_index,
                duplicated,
            ),
            "verified": True,
        }
    except Exception as exc:
        try:
            if destination_slot.has_clip:
                destination_slot.delete_clip()
            if destination_slot.has_clip:
                raise RuntimeError("destination clip remained present")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Session clip duplication and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Session clip duplication failed; the destination was restored",
            details={"operationError": str(exc)},
        )
    return result


def _delete_session_clip_params(params):
    return _session_clip_target_params(params)


def delete_session_clip(context, params):
    track = _resolve_track(context, params)
    slot, target = _resolve_session_clip(
        context, track, params, "deletion"
    )
    if not hasattr(slot, "delete_clip"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support Session clip deletion",
        )
    before_count = sum(
        1 for candidate in track.clip_slots if candidate.has_clip
    )
    summary = _session_view_clip_summary(
        context, track, params["index"], params["sceneIndex"], target
    )
    slot.delete_clip()
    after_count = sum(
        1 for candidate in track.clip_slots if candidate.has_clip
    )
    if slot.has_clip or after_count != before_count - 1:
        raise ProtocolFailure(
            "conflict",
            "Session clip deletion completed but verification failed",
            details={
                "beforeClipCount": before_count,
                "afterClipCount": after_count,
            },
        )
    return {
        "clip": summary,
        "beforeClipCount": before_count,
        "afterClipCount": after_count,
        "verified": True,
    }


def _set_session_clip_properties_params(params):
    error = _session_clip_target_params(
        params, ["name", "muted", "looping"]
    )
    if error:
        return error
    if not any(key in params for key in ("name", "muted", "looping")):
        return "At least one clip property is required"
    name = params.get("name")
    if "name" in params and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    if "muted" in params and not isinstance(params.get("muted"), bool):
        return "muted must be a boolean"
    if "looping" in params and not isinstance(params.get("looping"), bool):
        return "looping must be a boolean"
    return None


def set_session_clip_properties(context, params):
    track = _resolve_track(context, params)
    slot, target = _resolve_session_clip(
        context, track, params, "property update"
    )
    for key in ("name", "muted", "looping"):
        if key in params and not hasattr(target, key):
            raise ProtocolFailure(
                "unsupported_capability",
                "{0} is unsupported for this Session clip".format(key),
            )
    before = _session_clip_properties(target)
    requested = []
    if "name" in params:
        requested.append(("name", params["name"].strip()))
    if "muted" in params:
        requested.append(("muted", params["muted"]))
    if "looping" in params:
        requested.append(("looping", params["looping"]))
    applied = []
    try:
        for key, value in requested:
            applied.append(key)
            setattr(target, key, value)
        after = _session_clip_properties(target)
        if (
            not slot.has_clip
            or slot.clip is not target
            or _clip_reference(context, target)
            != params["expectedClipReference"]
            or any(after[key] != value for key, value in requested)
        ):
            raise ProtocolFailure(
                "conflict",
                "Session clip property verification failed",
            )
        result = {
            "clip": _session_view_clip_summary(
                context,
                track,
                params["index"],
                params["sceneIndex"],
                target,
            ),
            "before": before,
            "after": after,
            "verified": True,
        }
    except Exception as exc:
        try:
            for key in reversed(applied):
                setattr(target, key, before[key])
            restored = _session_clip_properties(target)
            if (
                not slot.has_clip
                or slot.clip is not target
                or any(
                    restored[key] != before[key] for key in applied
                )
            ):
                raise RuntimeError(
                    "Session clip properties were not restored"
                )
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Session property update and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Session property update failed; prior values were restored",
            details={"operationError": str(exc)},
        )
    return result


def _create_arrangement_midi_clip_params(params):
    error = _validate_track_target(
        params, ["startTime", "length", "name"]
    )
    if error:
        return error
    start_time = params.get("startTime")
    length = params.get("length")
    if (
        not _is_finite_number(start_time)
        or start_time < 0
        or start_time > 1576800
    ):
        return "startTime must be between 0 and 1576800 beats"
    if (
        isinstance(length, bool)
        or not isinstance(length, (int, float))
        or length <= 0
        or length > 4096
    ):
        return "length must be greater than zero and at most 4096 beats"
    if start_time + length > 1576800:
        return "Arrangement clip end must not exceed 1576800 beats"
    name = params.get("name")
    if name is not None and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    return None


def _arrangement_overlap(track, start_time, end_time):
    for existing in track.arrangement_clips:
        if start_time < existing.end_time and end_time > existing.start_time:
            return existing
    return None


def create_arrangement_midi_clip(context, params):
    track = _resolve_track(context, params)
    if (
        not hasattr(track, "arrangement_clips")
        or not hasattr(track, "create_midi_clip")
        or not hasattr(track, "delete_clip")
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support Arrangement clip creation",
        )
    if not getattr(track, "has_midi_input", False):
        raise ProtocolFailure(
            "unsupported_capability",
            "Arrangement MIDI clips require a MIDI track",
        )
    start_time = params["startTime"]
    end_time = start_time + params["length"]
    existing = _arrangement_overlap(track, start_time, end_time)
    if existing is not None:
        raise ProtocolFailure(
            "conflict",
            "Arrangement range overlaps an existing clip",
            details={
                "existingStartTime": existing.start_time,
                "existingEndTime": existing.end_time,
            },
        )
    before_clips = list(track.arrangement_clips)
    clip = None
    try:
        clip = track.create_midi_clip(start_time, params["length"])
        if params.get("name") is not None:
            clip.name = params["name"].strip()
        if (
            not any(candidate is clip for candidate in track.arrangement_clips)
            or abs(clip.start_time - start_time) >= 0.000001
            or abs(clip.end_time - end_time) >= 0.000001
            or (
                params.get("name") is not None
                and clip.name != params["name"].strip()
            )
        ):
            raise ProtocolFailure(
                "conflict",
                "Arrangement clip creation completed but verification failed",
            )
        result = {
            "clip": _arrangement_clip_summary(
                context, track, params["index"], clip
            ),
            "verified": True,
        }
    except Exception as exc:
        try:
            created_clips = [
                candidate
                for candidate in track.arrangement_clips
                if not any(candidate is before for before in before_clips)
            ]
            for created in created_clips:
                track.delete_clip(created)
            if any(
                not any(candidate is before for before in before_clips)
                for candidate in track.arrangement_clips
            ):
                raise RuntimeError("arrangement clip remained present")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Arrangement clip creation and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise
    return result


def _arrangement_clip_summary(context, track, track_index, clip):
    is_midi = bool(getattr(clip, "is_midi_clip", False))
    note_count = (
        len(_clip_notes(clip))
        if is_midi and hasattr(clip, "get_all_notes_extended")
        else None
    )
    looping = (
        bool(clip.looping) if hasattr(clip, "looping") else None
    )
    return {
        "reference": _clip_reference(context, clip),
        "trackReference": _track_reference(context, track),
        "trackIndex": track_index,
        "name": clip.name,
        "kind": "midi" if is_midi else "audio",
        "startTime": clip.start_time,
        "endTime": clip.end_time,
        "length": clip.length,
        "noteCount": note_count,
        "muted": bool(getattr(clip, "muted", False)),
        "looping": looping,
    }


def _resolve_arrangement_clip(context, track, params, operation):
    target = None
    for clip in getattr(track, "arrangement_clips", []):
        if _clip_reference(context, clip) == params["expectedClipReference"]:
            target = clip
            break
    if target is None:
        raise ProtocolFailure("stale_reference", "Arrangement clip changed")
    if abs(target.start_time - params["expectedStartTime"]) >= 0.000001:
        raise ProtocolFailure(
            "stale_reference",
            "Arrangement clip moved before {0}".format(operation),
        )
    return target


def _inspect_arrangement_params(params):
    if set(params.keys()) - set(["offset", "limit"]):
        return "Only offset and limit are accepted"
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        return "offset must be a non-negative integer"
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > 512
    ):
        return "limit must be an integer from 1 to 512"
    return None


def inspect_arrangement(context, params):
    clip_records = []
    for track_index, track in enumerate(context.song.tracks):
        for clip in getattr(track, "arrangement_clips", []):
            clip_records.append(
                (clip.start_time, track_index, track, clip)
            )
    clip_records.sort(key=lambda item: (item[0], item[1]))
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    clips = [
        _arrangement_clip_summary(context, track, track_index, clip)
        for _, track_index, track, clip in clip_records[
            offset : offset + limit
        ]
    ]
    return {
        "clips": clips,
        "total": len(clip_records),
        "offset": offset,
        "limit": limit,
    }


def _delete_arrangement_clip_params(params):
    error = _validate_track_target(
        params, ["expectedClipReference", "expectedStartTime"]
    )
    if error:
        return error
    try:
        uuid.UUID(params.get("expectedClipReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedClipReference must be a UUID"
    start_time = params.get("expectedStartTime")
    if not _is_finite_number(start_time) or start_time < 0:
        return "expectedStartTime must be a non-negative number"
    return None


def delete_arrangement_clip(context, params):
    track = _resolve_track(context, params, allow_group=True)
    if not hasattr(track, "arrangement_clips") or not hasattr(
        track, "delete_clip"
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support Arrangement clip deletion",
        )
    target = _resolve_arrangement_clip(
        context, track, params, "deletion"
    )
    before_count = len(track.arrangement_clips)
    summary = _arrangement_clip_summary(
        context, track, params["index"], target
    )
    track.delete_clip(target)
    after_count = len(track.arrangement_clips)
    if after_count != before_count - 1 or any(
        candidate is target for candidate in track.arrangement_clips
    ):
        raise ProtocolFailure(
            "conflict",
            "Arrangement clip deletion completed but verification failed",
            details={
                "beforeClipCount": before_count,
                "afterClipCount": after_count,
            },
        )
    return {
        "clip": summary,
        "beforeClipCount": before_count,
        "afterClipCount": after_count,
        "verified": True,
    }


def _replace_arrangement_midi_notes_params(params):
    candidate = {
        "index": params.get("index"),
        "expectedReference": params.get("expectedReference"),
        "expectedName": params.get("expectedName"),
        "sceneIndex": 0,
        "expectedClipReference": params.get("expectedClipReference"),
        "allowPerNoteExpressionLoss": params.get(
            "allowPerNoteExpressionLoss"
        ),
        "notes": params.get("notes"),
    }
    error = _replace_midi_notes_params(candidate)
    if error:
        return error
    if set(params.keys()) - set(
        [
            "index",
            "expectedReference",
            "expectedName",
            "expectedClipReference",
            "expectedStartTime",
            "allowPerNoteExpressionLoss",
            "notes",
        ]
    ):
        return "Unexpected Arrangement note replacement parameter"
    start_time = params.get("expectedStartTime")
    if not _is_finite_number(start_time) or start_time < 0:
        return "expectedStartTime must be a non-negative number"
    return None


def replace_arrangement_midi_notes(context, params):
    track = _resolve_track(context, params, allow_group=True)
    target = _resolve_arrangement_clip(
        context, track, params, "note replacement"
    )
    if not bool(getattr(target, "is_midi_clip", False)):
        raise ProtocolFailure(
            "conflict", "Arrangement clip is not a MIDI clip"
        )
    return _replace_midi_clip_notes(
        context,
        target,
        params,
        lambda: _arrangement_clip_summary(
            context, track, params["index"], target
        ),
    )


def _duplicate_clip_to_arrangement_params(params):
    error = _validate_track_target(
        params,
        ["sceneIndex", "expectedClipReference", "destinationTime"],
    )
    if error:
        return error
    scene_index = params.get("sceneIndex")
    if (
        isinstance(scene_index, bool)
        or not isinstance(scene_index, int)
        or scene_index < 0
    ):
        return "sceneIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedClipReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedClipReference must be a UUID"
    destination_time = params.get("destinationTime")
    if (
        not _is_finite_number(destination_time)
        or destination_time < 0
        or destination_time > 1576800
    ):
        return "destinationTime must be between 0 and 1576800 beats"
    return None


def duplicate_clip_to_arrangement(context, params):
    track = _resolve_track(context, params)
    if (
        not hasattr(track, "arrangement_clips")
        or not hasattr(track, "duplicate_clip_to_arrangement")
        or not hasattr(track, "delete_clip")
    ):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not support Session-to-Arrangement duplication",
        )
    scene_index = params["sceneIndex"]
    if scene_index >= len(track.clip_slots):
        raise ProtocolFailure("not_found", "Scene index is out of range")
    slot = track.clip_slots[scene_index]
    if not slot.has_clip:
        raise ProtocolFailure("not_found", "Clip slot is empty")
    source = slot.clip
    if _clip_reference(context, source) != params["expectedClipReference"]:
        raise ProtocolFailure(
            "stale_reference",
            "Source clip identity changed before duplication",
        )
    if not bool(getattr(source, "is_midi_clip", False)):
        raise ProtocolFailure(
            "unsupported_capability",
            "Safe Session-to-Arrangement duplication currently requires a MIDI clip",
        )
    source_length = source.length
    if not _is_finite_number(source_length) or source_length <= 0:
        raise ProtocolFailure(
            "conflict", "Source clip has an invalid length"
        )
    destination_time = params["destinationTime"]
    destination_end = destination_time + source_length
    if destination_end > 1576800:
        raise ProtocolFailure(
            "invalid_params",
            "Duplicated Arrangement clip end must not exceed 1576800 beats",
        )
    existing = _arrangement_overlap(
        track, destination_time, destination_end
    )
    if existing is not None:
        raise ProtocolFailure(
            "conflict",
            "Arrangement range overlaps an existing clip",
            details={
                "existingStartTime": existing.start_time,
                "existingEndTime": existing.end_time,
            },
        )
    before_clips = list(track.arrangement_clips)
    duplicated = None
    try:
        duplicated = track.duplicate_clip_to_arrangement(
            source, destination_time
        )
        created_clips = [
            candidate
            for candidate in track.arrangement_clips
            if not any(candidate is before for before in before_clips)
        ]
        if len(created_clips) != 1:
            raise ProtocolFailure(
                "conflict",
                "Arrangement duplication created an unexpected number of clips",
            )
        created = created_clips[0]
        if duplicated is not None and duplicated is not created:
            raise ProtocolFailure(
                "conflict",
                "Arrangement duplication returned an unexpected clip",
            )
        if (
            slot.clip is not source
            or _clip_reference(context, source)
            != params["expectedClipReference"]
            or len(track.arrangement_clips) != len(before_clips) + 1
            or any(
                not any(
                    candidate is current
                    for current in track.arrangement_clips
                )
                for candidate in before_clips
            )
            or abs(created.start_time - destination_time) >= 0.000001
            or abs(created.end_time - destination_end) >= 0.000001
            or abs(created.length - source_length) >= 0.000001
            or bool(getattr(created, "is_midi_clip", False))
            != bool(getattr(source, "is_midi_clip", False))
        ):
            raise ProtocolFailure(
                "conflict",
                "Arrangement duplication completed but verification failed",
            )
        result = {
            "sourceClip": _session_view_clip_summary(
                context, track, params["index"], scene_index, source
            ),
            "clip": _arrangement_clip_summary(
                context, track, params["index"], created
            ),
            "beforeClipCount": len(before_clips),
            "afterClipCount": len(track.arrangement_clips),
            "verified": True,
        }
    except Exception as exc:
        try:
            created_clips = [
                candidate
                for candidate in track.arrangement_clips
                if not any(candidate is before for before in before_clips)
            ]
            for created in created_clips:
                track.delete_clip(created)
            if len(track.arrangement_clips) != len(before_clips) or any(
                not any(
                    candidate is current
                    for current in track.arrangement_clips
                )
                for candidate in before_clips
            ):
                raise RuntimeError("Arrangement before-state was not restored")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Arrangement duplication and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Arrangement duplication failed; the destination clip was removed",
            details={"operationError": str(exc)},
        )
    return result


def _set_arrangement_clip_properties_params(params):
    error = _validate_track_target(
        params,
        [
            "expectedClipReference",
            "expectedStartTime",
            "name",
            "muted",
            "looping",
        ],
    )
    if error:
        return error
    try:
        uuid.UUID(params.get("expectedClipReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedClipReference must be a UUID"
    start_time = params.get("expectedStartTime")
    if not _is_finite_number(start_time) or start_time < 0:
        return "expectedStartTime must be a non-negative number"
    if not any(key in params for key in ("name", "muted", "looping")):
        return "At least one clip property is required"
    name = params.get("name")
    if "name" in params and (
        not isinstance(name, str) or not name.strip() or len(name) > 128
    ):
        return "name must be a non-empty string of at most 128 characters"
    if "muted" in params and not isinstance(params.get("muted"), bool):
        return "muted must be a boolean"
    if "looping" in params and not isinstance(params.get("looping"), bool):
        return "looping must be a boolean"
    return None


def _arrangement_clip_properties(clip):
    return {
        "name": clip.name,
        "muted": bool(clip.muted),
        "looping": bool(clip.looping) if hasattr(clip, "looping") else None,
    }


def set_arrangement_clip_properties(context, params):
    track = _resolve_track(context, params, allow_group=True)
    target = _resolve_arrangement_clip(
        context, track, params, "property update"
    )
    if not hasattr(target, "name") or not hasattr(target, "muted"):
        raise ProtocolFailure(
            "unsupported_capability",
            "This clip does not support required Arrangement properties",
        )
    if "looping" in params and not hasattr(target, "looping"):
        raise ProtocolFailure(
            "unsupported_capability",
            "Looping is unsupported for this Arrangement clip",
        )
    before = _arrangement_clip_properties(target)
    requested = []
    if "name" in params:
        requested.append(("name", params["name"].strip()))
    if "muted" in params:
        requested.append(("muted", params["muted"]))
    if "looping" in params:
        requested.append(("looping", params["looping"]))
    applied = []
    try:
        for key, value in requested:
            applied.append(key)
            setattr(target, key, value)
        after = _arrangement_clip_properties(target)
        if (
            not any(
                candidate is target for candidate in track.arrangement_clips
            )
            or abs(target.start_time - params["expectedStartTime"])
            >= 0.000001
            or any(after[key] != value for key, value in requested)
        ):
            raise ProtocolFailure(
                "conflict",
                "Arrangement clip property verification failed",
            )
        result = {
            "clip": _arrangement_clip_summary(
                context, track, params["index"], target
            ),
            "before": before,
            "after": after,
            "verified": True,
        }
    except Exception as exc:
        try:
            for key in reversed(applied):
                setattr(target, key, before[key])
            restored = _arrangement_clip_properties(target)
            if (
                not any(
                    candidate is target
                    for candidate in track.arrangement_clips
                )
                or abs(target.start_time - params["expectedStartTime"])
                >= 0.000001
                or any(restored[key] != before[key] for key in applied)
            ):
                raise RuntimeError("Arrangement clip properties were not restored")
        except Exception as recovery_exc:
            raise ProtocolFailure(
                "lom_error",
                "Arrangement property update and recovery both failed",
                details={
                    "operationError": str(exc),
                    "recoveryError": str(recovery_exc),
                },
            )
        if isinstance(exc, ProtocolFailure):
            raise exc
        raise ProtocolFailure(
            "lom_error",
            "Arrangement property update failed; prior values were restored",
            details={"operationError": str(exc)},
        )
    return result


def register_system_commands(registry):
    registry.register("system.ping", ping, validator=_no_params)
    registry.register("session.inspect", inspect_session, validator=_no_params)
    registry.register(
        "transport.set_tempo",
        set_tempo,
        mutates=True,
        capability="transport.set_tempo",
        validator=_set_tempo_params,
    )
    registry.register(
        "transport.set_playing",
        set_playing,
        mutates=True,
        capability="transport.set_playing",
        validator=_set_playing_params,
    )
    registry.register(
        "transport.inspect_arrangement",
        inspect_arrangement_transport,
        capability="transport.inspect_arrangement",
        validator=_inspect_arrangement_transport_params,
    )
    registry.register(
        "transport.set_arrangement_loop",
        set_arrangement_loop,
        mutates=True,
        capability="transport.set_arrangement_loop",
        validator=_set_arrangement_loop_params,
    )
    registry.register(
        "transport.create_cue_point",
        create_cue_point,
        mutates=True,
        capability="transport.create_cue_point",
        validator=_create_cue_point_params,
    )
    registry.register(
        "transport.delete_cue_point",
        delete_cue_point,
        mutates=True,
        capability="transport.delete_cue_point",
        validator=_delete_cue_point_params,
    )
    registry.register(
        "tracks.create",
        create_track,
        mutates=True,
        capability="tracks.create",
        validator=_create_track_params,
    )
    registry.register(
        "tracks.delete",
        delete_track,
        mutates=True,
        capability="tracks.delete",
        validator=_delete_track_params,
    )
    registry.register(
        "tracks.rename",
        rename_track,
        mutates=True,
        capability="tracks.rename",
        validator=_rename_track_params,
    )
    registry.register(
        "tracks.set_mixer",
        set_track_mixer,
        mutates=True,
        capability="tracks.set_mixer",
        validator=_set_track_mixer_params,
    )
    registry.register(
        "clips.create_midi",
        create_midi_clip,
        mutates=True,
        capability="clips.create_midi",
        validator=_create_midi_clip_params,
    )
    registry.register(
        "clips.replace_notes",
        replace_midi_notes,
        mutates=True,
        capability="clips.replace_notes",
        validator=_replace_midi_notes_params,
    )
    registry.register(
        "clips.launch",
        launch_session_clip,
        mutates=True,
        capability="clips.launch",
        validator=_launch_session_clip_params,
    )
    registry.register(
        "clips.duplicate",
        duplicate_session_clip,
        mutates=True,
        capability="clips.duplicate",
        validator=_duplicate_session_clip_params,
    )
    registry.register(
        "clips.delete",
        delete_session_clip,
        mutates=True,
        capability="clips.delete",
        validator=_delete_session_clip_params,
    )
    registry.register(
        "clips.set_properties",
        set_session_clip_properties,
        mutates=True,
        capability="clips.set_properties",
        validator=_set_session_clip_properties_params,
    )
    registry.register(
        "arrangement.create_midi_clip",
        create_arrangement_midi_clip,
        mutates=True,
        capability="arrangement.create_midi_clip",
        validator=_create_arrangement_midi_clip_params,
    )
    registry.register(
        "arrangement.inspect",
        inspect_arrangement,
        capability="arrangement.inspect",
        validator=_inspect_arrangement_params,
    )
    registry.register(
        "arrangement.delete_clip",
        delete_arrangement_clip,
        mutates=True,
        capability="arrangement.delete_clip",
        validator=_delete_arrangement_clip_params,
    )
    registry.register(
        "arrangement.replace_notes",
        replace_arrangement_midi_notes,
        mutates=True,
        capability="arrangement.replace_notes",
        validator=_replace_arrangement_midi_notes_params,
    )
    registry.register(
        "arrangement.duplicate_clip",
        duplicate_clip_to_arrangement,
        mutates=True,
        capability="arrangement.duplicate_clip",
        validator=_duplicate_clip_to_arrangement_params,
    )
    registry.register(
        "arrangement.set_clip_properties",
        set_arrangement_clip_properties,
        mutates=True,
        capability="arrangement.set_clip_properties",
        validator=_set_arrangement_clip_properties_params,
    )
