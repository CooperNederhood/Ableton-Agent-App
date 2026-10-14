"""Guarded Arrangement seek/continue; deliberately never stops playback."""

from .core_domain_commands import (
    _clip_target, _integer, _name, _number, _strict, _track_target, _uuid,
)
from .errors import ProtocolFailure
from .identity import build_live_identity
from .listening_commands import inspect_listening_context, _placement_collection
from .system_commands import _safe_lom_getattr

OWNERSHIP_LIMITATION = (
    "A verified transport seek/source-retrigger ownership adapter is unavailable; "
    "state snapshots and ordinary position callbacks cannot certify exclusive ownership."
)
SESSION_LIMITATION = (
    "Session listening playback is unsupported until actual quantized source onset is verified."
)
PLAYBACK_CAPABILITIES = ("listening.start_playback", "listening.stop_playback")
START_LIMITATION = (
    "Arrangement only; playback continues after completion/cancellation. "
    "No ownership or verified source-onset/timing claim; Session start and stop are unsupported."
)


def guarded_arrangement_start_supported(song):
    return (
        callable(_safe_lom_getattr(song, "continue_playing"))
        and all(_safe_lom_getattr(song, field) is not None for field in (
            "current_song_time", "is_playing", "loop", "back_to_arranger",
            "record_mode", "session_record", "arrangement_overdub",
            "session_automation_record",
        ))
    )


def _transport_guards(context, params, identity_builder, check_revision=True):
    song = context.song
    if identity_builder(song)["liveSetId"] != params["expectedLiveSetId"]:
        raise ProtocolFailure("conflict", "Listening Set identity changed")
    if check_revision and context.project_revision != params["expectedProjectRevision"]:
        raise ProtocolFailure("conflict", "Listening project revision changed")
    for field in (
        "is_playing", "record_mode", "session_record", "arrangement_overdub",
        "session_automation_record", "loop", "back_to_arranger",
    ):
        value = _safe_lom_getattr(song, field)
        if value is not False:
            raise ProtocolFailure("conflict", "Listening requires known stopped/recording-off/Arrangement state",
                                  details={"reason": "unsafe_or_unknown_" + field, "mutated": False})
    # Legacy MIDI-overdub alias must not hide a contradictory recording flag.
    alias = _safe_lom_getattr(song, "overdub", False)
    if alias is not False:
        raise ProtocolFailure("conflict", "Listening overdub state is unsafe or unknown")
    if not _number(_safe_lom_getattr(song, "current_song_time"), 0, 1576800):
        raise ProtocolFailure("unsupported_capability", "Listening position is unknown")
    for track in _placement_collection(song, "tracks", 256):
        if (_safe_lom_getattr(track, "back_to_arranger") is not False
                or _safe_lom_getattr(track, "playing_slot_index") != -1
                or _safe_lom_getattr(track, "fired_slot_index") != -1):
            raise ProtocolFailure("conflict", "Session source override or pending launch is unsupported")


def _guards(context, params, identity_builder, check_revision=True):
    _transport_guards(context, params, identity_builder, check_revision)
    evidence = inspect_listening_context(context, {
        "schemaVersion": 1, "listeners": params["listeners"],
        "range": params["range"], "maxClips": 64, "maxParameters": 1,
    })
    if not evidence["transport"]["safeToStart"] or any(
        item["enabled"] is not True or item["sessionOverride"] is not False
        for item in evidence["listeners"]
    ):
        raise ProtocolFailure("conflict", "Listener or clip recording/source evidence is unsafe or unknown")
    _transport_guards(context, params, identity_builder, check_revision)


def _listener(value):
    return (
        _strict(value, (
            "track", "deviceIndex", "expectedDeviceReference",
            "expectedDeviceName", "expectedClassName",
        ))
        and _track_target(value["track"])
        and _integer(value["deviceIndex"], 0)
        and _uuid(value["expectedDeviceReference"])
        and _name(value["expectedDeviceName"])
        and _name(value["expectedClassName"])
    )


def validate_start(params):
    if not isinstance(params, dict):
        return "Invalid listening playback start"
    mode = params.get("mode")
    required = (
        "schemaVersion", "mode", "ownerId", "passId", "expectedLiveSetId",
        "expectedProjectRevision", "listeners", "range",
    ) + (("clip",) if mode == "session" else ())
    if not _strict(params, required) or mode not in ("arrangement", "session"):
        return "Invalid listening playback mode or parameters"
    listeners = params["listeners"]
    window = params["range"]
    if not (
        params["schemaVersion"] == 1 and not isinstance(params["schemaVersion"], bool)
        and _name(params["ownerId"], required=True)
        and _uuid(params["passId"])
        and _name(params["expectedLiveSetId"], required=True)
        and _integer(params["expectedProjectRevision"], 0)
        and isinstance(listeners, list) and 1 <= len(listeners) <= 8
        and all(_listener(value) for value in listeners)
        and len(set(value["expectedDeviceReference"] for value in listeners)) == len(listeners)
        and _strict(window, ("startBeat", "endBeat"))
        and _number(window["startBeat"], 0, 1576800)
        and _number(window["endBeat"], 0, 1576800)
        and window["endBeat"] > window["startBeat"]
        and (mode != "session" or (_clip_target(params["clip"]) and params["clip"]["view"] == "session"))
    ):
        return "Invalid listening playback bounds, version, or identities"
    return None


def validate_stop(params):
    if not _strict(params, ("schemaVersion", "ownership")):
        return "Invalid listening playback stop"
    token = params["ownership"]
    if not (
        params["schemaVersion"] == 1 and not isinstance(params["schemaVersion"], bool)
        and _strict(token, ("ownerId", "passId", "generation", "liveSetId"))
        and _name(token["ownerId"], required=True)
        and _uuid(token["passId"]) and _uuid(token["generation"])
        and _name(token["liveSetId"], required=True)
    ):
        return "Invalid listening playback ownership token"
    return None


def _unmutated_start_failure(error):
    details = dict(error.details or {})
    details.update({"mutated": False, "cleanupPolicy": "leave-running"})
    return ProtocolFailure(error.code, error.message, details=details)


def start_listening_playback(context, params, identity_builder=build_live_identity):
    error = validate_start(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    if params["mode"] == "session":
        raise ProtocolFailure("unsupported_capability", SESSION_LIMITATION, details={
            "reason": "session_source_onset_unverified", "mutated": False,
        })
    song = context.song
    if not guarded_arrangement_start_supported(song):
        raise ProtocolFailure("unsupported_capability", "Required Arrangement start primitives are unavailable",
                              details={"mutated": False})
    try:
        _guards(context, params, identity_builder)
    except ProtocolFailure as error:
        raise _unmutated_start_failure(error)
    stage = "seek"
    mutation_attempted = False
    try:
        position = _safe_lom_getattr(song, "current_song_time")
        if not _number(position, 0, 1576800):
            raise ProtocolFailure("conflict", "Listening position became unknown")
        # Preserve an already-armed native boundary when no seek is required.
        if position != params["range"]["startBeat"]:
            mutation_attempted = True
            song.current_song_time = params["range"]["startBeat"]
        # A setter may reenter host code. Only an attempted seek may have
        # advanced our own revision; a skipped seek must revalidate it.
        _guards(context, params, identity_builder, check_revision=not mutation_attempted)
        if song.current_song_time != params["range"]["startBeat"]:
            raise ProtocolFailure("conflict", "Requested seek was not observed")
        stage = "start"
        mutation_attempted = True
        song.continue_playing()
        stage = "verify"
        if _safe_lom_getattr(song, "is_playing") is not True:
            raise ProtocolFailure("lom_error", "Start acknowledgement state is unknown or not running")
        return {
            "schemaVersion": 1, "mode": "arrangement",
            "cleanupPolicy": "leave-running", "startedAtBeat": params["range"]["startBeat"],
            "sourceOnset": "unverified",
        }
    except Exception as error:
        if not mutation_attempted:
            if isinstance(error, ProtocolFailure):
                raise _unmutated_start_failure(error)
            raise ProtocolFailure("lom_error", "Guarded start failed before a mutation attempt",
                                  details={"stage": stage, "mutated": False,
                                           "cleanupPolicy": "leave-running"})
        # Even a setter that throws may already have mutated the host. Never
        # restore position or stop: that could overwrite independent user work.
        playing = _safe_lom_getattr(song, "is_playing")
        beat = _safe_lom_getattr(song, "current_song_time")
        raise ProtocolFailure("lom_error", "Guarded start failed after a mutation attempt; playback is left unchanged",
                              details={
                                  "stage": stage, "mutationState": "indeterminate",
                                  "cleanupPolicy": "leave-running",
                                  "playing": playing if isinstance(playing, bool) else None,
                                  "currentBeat": beat if _number(beat, 0, 1576800) else None,
                              })


def stop_listening_playback(context, params):
    del context
    error = validate_stop(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    raise ProtocolFailure("unsupported_capability", OWNERSHIP_LIMITATION, details={
        "reason": "transport_ownership_unverified", "mutated": False,
    })


def register_playback_commands(registry):
    registry.register(
        "listening.start_playback", start_listening_playback, mutates=True,
        capability="listening.start_playback", validator=validate_start,
    )
    registry.register(
        "listening.stop_playback", stop_listening_playback, mutates=True,
        capability="listening.stop_playback", validator=validate_stop,
    )
