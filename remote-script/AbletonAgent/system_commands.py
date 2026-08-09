"""System and session inspection commands."""

from __future__ import absolute_import, unicode_literals

import uuid

from .executor import DeferredResult
from .errors import ProtocolFailure


def _track_kind(track):
    return "midi" if getattr(track, "has_midi_input", False) else "audio"


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


def _no_params(params):
    if params:
        return "Command does not accept parameters"
    return None


def ping(_context, _params):
    return {"pong": True}


def inspect_session(context, _params):
    song = context.song
    tracks = []
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
            }
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
    if index >= before_count:
        raise ProtocolFailure("not_found", "Track index is out of range")
    track = song.tracks[index]
    if getattr(track, "is_foldable", False):
        raise ProtocolFailure(
            "conflict",
            "Group tracks require a broad deletion operation",
            details={"index": index, "name": track.name},
        )
    kind = _track_kind(track)
    if (
        _track_reference(context, track) != params["expectedReference"]
        or track.name != params["expectedName"]
        or kind != params["expectedKind"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Track identity changed before deletion",
            details={
                "index": index,
                "expectedReference": params["expectedReference"],
                "actualReference": _track_reference(context, track),
                "expectedName": params["expectedName"],
                "actualName": track.name,
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
