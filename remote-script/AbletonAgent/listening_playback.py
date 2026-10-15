"""Guarded Arrangement positioning/start; deliberately never stops playback."""

from .core_domain_commands import (
    _clip_target, _integer, _name, _number, _strict, _track_target, _uuid,
)
from .errors import ProtocolFailure
from .executor import DeferredResult
from .identity import build_live_identity
from .listening_commands import (
    inspect_listening_context, _placement_collection, _session_override,
)
from .system_commands import _safe_lom_getattr

OWNERSHIP_LIMITATION = (
    "A verified transport seek/source-retrigger ownership adapter is unavailable; "
    "state snapshots and ordinary position callbacks cannot certify exclusive ownership."
)
SESSION_LIMITATION = (
    "Session listening playback is unsupported until actual quantized source onset is verified."
)
PLAYBACK_CAPABILITIES = (
    "listening.position_playback", "listening.start_playback", "listening.stop_playback",
)
POSITION_LIMITATION = (
    "Arrangement only, stopped and recording-off; independently reads back insert marker "
    "and stopped position before native arm. Does not start, stop, certify source onset, "
    "or grant transport ownership."
)
START_LIMITATION = (
    "Arrangement only; the existing insert marker must match the requested start. "
    "Seek/start readbacks are deferred; playback continues after completion/cancellation. "
    "No ownership or verified source-onset/timing claim; Session start and stop are unsupported."
)


def _overdub_state(song):
    canonical = _safe_lom_getattr(song, "overdub")
    if not isinstance(canonical, bool):
        return None
    try:
        alias = getattr(song, "arrangement_overdub")
    except AttributeError:
        return canonical
    except RuntimeError:
        return None
    if not isinstance(alias, bool):
        return None
    return canonical or alias


def guarded_arrangement_start_supported(song):
    return (
        callable(_safe_lom_getattr(song, "start_playing"))
        and _overdub_state(song) is not None
        and all(_safe_lom_getattr(song, field) is not None for field in (
            "current_song_time", "start_time", "is_playing", "loop", "back_to_arranger",
            "record_mode", "session_record", "session_automation_record",
        ))
    )


def _transport_guards(context, params, identity_builder, check_revision=True,
                      expected_playing=False):
    song = context.song
    if identity_builder(song)["liveSetId"] != params["expectedLiveSetId"]:
        raise ProtocolFailure("conflict", "Listening Set identity changed")
    if check_revision and context.project_revision != params["expectedProjectRevision"]:
        raise ProtocolFailure("conflict", "Listening project revision changed")
    if _safe_lom_getattr(song, "is_playing") is not expected_playing:
        raise ProtocolFailure("conflict", "Listening transport state is unsafe or unknown",
                              details={"reason": "unsafe_or_unknown_is_playing", "mutated": False})
    for field in (
        "record_mode", "session_record",
        "session_automation_record", "loop", "back_to_arranger",
    ):
        value = _safe_lom_getattr(song, field)
        if value is not False:
            raise ProtocolFailure("conflict", "Listening requires known stopped/recording-off/Arrangement state",
                                  details={"reason": "unsafe_or_unknown_" + field, "mutated": False})
    if _overdub_state(song) is not False:
        raise ProtocolFailure("conflict", "Listening overdub state is unsafe or unknown")
    if not _number(_safe_lom_getattr(song, "current_song_time"), 0, 1576800):
        raise ProtocolFailure("unsupported_capability", "Listening position is unknown")
    allowed_slots = (-1, -2) if expected_playing else (-1,)
    for track in _placement_collection(song, "tracks", 256):
        if (_session_override(song, track) is not False
                or _safe_lom_getattr(track, "playing_slot_index") not in allowed_slots
                or _safe_lom_getattr(track, "fired_slot_index") != -1):
            raise ProtocolFailure("conflict", "Session source override or pending launch is unsupported")


def _marker_guard(song, params):
    marker = _safe_lom_getattr(song, "start_time")
    if not _number(marker, 0, 1576800) or marker != params["range"]["startBeat"]:
        raise ProtocolFailure("conflict", "Arrangement insert marker does not match the requested start",
                              details={"reason": "arrangement_start_marker_mismatch", "mutated": False})


def _guards(context, params, identity_builder, check_revision=True, require_marker=True):
    _transport_guards(context, params, identity_builder, check_revision)
    if require_marker:
        _marker_guard(context.song, params)
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
    if require_marker:
        _marker_guard(context.song, params)
    return evidence


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


def validate_position(params):
    error = validate_start(params)
    if error or params["mode"] != "arrangement":
        return "Invalid Arrangement listening position parameters"
    return None


def _unmutated_start_failure(error):
    details = dict(error.details or {})
    details.update({"mutated": False, "cleanupPolicy": "leave-running"})
    return ProtocolFailure(error.code, error.message, details=details)


def _start_failure(song, error, stage, mutation_attempted, operation="start"):
    if not mutation_attempted:
        if isinstance(error, ProtocolFailure):
            return _unmutated_start_failure(error)
        return ProtocolFailure("lom_error", "Guarded " + operation + " failed before a mutation attempt",
                               details={"stage": stage, "mutated": False,
                                        "cleanupPolicy": "leave-running"})
    playing = _safe_lom_getattr(song, "is_playing")
    beat = _safe_lom_getattr(song, "current_song_time")
    details = {
        "stage": stage, "mutationState": "indeterminate",
        "cleanupPolicy": "leave-running",
        "playing": playing if isinstance(playing, bool) else None,
        "currentBeat": beat if _number(beat, 0, 1576800) else None,
    }
    uncertainty = ""
    if operation == "position":
        marker = _safe_lom_getattr(song, "start_time")
        details["insertMarkerBeat"] = marker if _number(marker, 0, 1576800) else None
        uncertainty = "position may have changed; "
    return ProtocolFailure(
        "lom_error", "Guarded " + operation + " failed after a mutation attempt; "
        + uncertainty + "playback is left unchanged", details=details)


def position_listening_playback(context, params, identity_builder=build_live_identity):
    error = validate_position(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    song = context.song
    if (not guarded_arrangement_start_supported(song)
            or not callable(getattr(context, "schedule_message", None))):
        raise ProtocolFailure("unsupported_capability", "Required Arrangement positioning primitives are unavailable",
                              details={"mutated": False, "cleanupPolicy": "leave-running"})
    try:
        initial = _guards(context, params, identity_builder, require_marker=False)
        initial_marker = _safe_lom_getattr(song, "start_time")
        initial_position = _safe_lom_getattr(song, "current_song_time")
        if not _number(initial_marker, 0, 1576800):
            raise ProtocolFailure("conflict", "Listening insert marker is unknown")
    except Exception as error:
        raise _start_failure(song, error, "position_guard", False, "position")
    target = params["range"]["startBeat"]
    state = {"stage": "position_marker", "mutation_attempted": False, "settled": False}

    def source_evidence(inspection):
        return [
            {field: item[field] for field in ("canonicalPath", "binding", "fingerprint")}
            for item in inspection["listeners"]
        ]

    baseline = source_evidence(initial)

    def revalidate():
        current = _guards(
            context, params, identity_builder,
            check_revision=not state["mutation_attempted"], require_marker=False)
        if source_evidence(current) != baseline:
            raise ProtocolFailure("conflict", "Listening source changed during positioning")

    def begin(on_success, on_failure, on_progress):
        def failed(error):
            if state["settled"]:
                raise error
            state["settled"] = True
            on_failure(_start_failure(
                song, error, state["stage"], state["mutation_attempted"], "position"))

        def schedule(phase, callback):
            if on_progress is not None:
                on_progress({"phase": phase})
            context.schedule_message(1, callback)

        def verify_position():
            if state["settled"]:
                return
            try:
                revalidate()
                _marker_guard(song, params)
                position = _safe_lom_getattr(song, "current_song_time")
                if position != target:
                    raise ProtocolFailure("conflict", "Requested stopped position was not independently observed")
                result = {
                    "schemaVersion": 1, "mode": "arrangement",
                    "cleanupPolicy": "leave-running", "sourceOnset": "unverified",
                    "requestedStartBeat": target,
                    "insertMarkerBeat": _safe_lom_getattr(song, "start_time"),
                    "currentBeat": position, "playing": False,
                    "changed": {
                        "insertMarker": initial_marker != target,
                        "currentPosition": initial_position != target,
                    },
                }
            except Exception as error:
                failed(error)
                return
            state["settled"] = True
            on_success(result)

        def verify_marker():
            if state["settled"]:
                return
            try:
                revalidate()
                _marker_guard(song, params)
                state["stage"] = "position_seek"
                if _safe_lom_getattr(song, "current_song_time") != target:
                    state["mutation_attempted"] = True
                    song.current_song_time = target
                state["stage"] = "position_verify"
                schedule("listening_position_seek_verification", verify_position)
            except Exception as error:
                failed(error)

        try:
            revalidate()
            if _safe_lom_getattr(song, "start_time") != target:
                state["mutation_attempted"] = True
                song.start_time = target
            state["stage"] = "position_marker_verify"
            schedule("listening_position_marker_verification", verify_marker)
        except Exception as error:
            failed(error)

    return DeferredResult(begin, supports_progress=True)


def start_listening_playback(context, params, identity_builder=build_live_identity):
    error = validate_start(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    if params["mode"] == "session":
        raise ProtocolFailure("unsupported_capability", SESSION_LIMITATION, details={
            "reason": "session_source_onset_unverified", "mutated": False,
        })
    song = context.song
    if (not guarded_arrangement_start_supported(song)
            or not callable(getattr(context, "schedule_message", None))):
        raise ProtocolFailure("unsupported_capability", "Required Arrangement start primitives are unavailable",
                              details={"mutated": False})
    try:
        _guards(context, params, identity_builder)
    except Exception as error:
        raise _start_failure(song, error, "guard", False)
    state = {"stage": "seek", "mutation_attempted": False, "settled": False}
    seek_attempted = False
    try:
        position = _safe_lom_getattr(song, "current_song_time")
        if not _number(position, 0, 1576800):
            raise ProtocolFailure("conflict", "Listening position became unknown")
        # Preserve an already-armed native boundary when no seek is required.
        if position != params["range"]["startBeat"]:
            seek_attempted = True
            state["mutation_attempted"] = True
            song.current_song_time = params["range"]["startBeat"]
    except Exception as error:
        raise _start_failure(song, error, state["stage"], state["mutation_attempted"])

    def begin(on_success, on_failure, on_progress):
        def failed(error):
            if state["settled"]:
                raise error
            state["settled"] = True
            on_failure(_start_failure(
                song, error, state["stage"], state["mutation_attempted"]))

        def progress(phase):
            if on_progress is not None:
                on_progress({"phase": phase})

        def verify():
            if state["settled"]:
                return
            try:
                _transport_guards(context, params, identity_builder,
                                  check_revision=False, expected_playing=True)
                _marker_guard(song, params)
                result = {
                    "schemaVersion": 1, "mode": "arrangement",
                    "cleanupPolicy": "leave-running",
                    "startedAtBeat": params["range"]["startBeat"],
                    "sourceOnset": "unverified",
                }
            except Exception as error:
                failed(error)
                return
            state["settled"] = True
            on_success(result)

        def start():
            if state["settled"]:
                return
            try:
                # Only our attempted seek may waive revision revalidation.
                _guards(context, params, identity_builder, check_revision=not seek_attempted)
                if _safe_lom_getattr(song, "current_song_time") != params["range"]["startBeat"]:
                    raise ProtocolFailure("conflict", "Requested seek was not independently observed")
                state["stage"] = "start"
                state["mutation_attempted"] = True
                song.start_playing()
                state["stage"] = "verify"
                progress("listening_start_verification")
                context.schedule_message(1, verify)
            except Exception as error:
                failed(error)

        try:
            if seek_attempted:
                progress("listening_seek_verification")
                context.schedule_message(1, start)
            else:
                start()
        except Exception as error:
            failed(error)

    return DeferredResult(begin, supports_progress=True)


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
        "listening.position_playback", position_listening_playback, mutates=True,
        capability="listening.position_playback", validator=validate_position,
    )
    registry.register(
        "listening.start_playback", start_listening_playback, mutates=True,
        capability="listening.start_playback", validator=validate_start,
    )
    registry.register(
        "listening.stop_playback", stop_listening_playback, mutates=True,
        capability="listening.stop_playback", validator=validate_stop,
    )
