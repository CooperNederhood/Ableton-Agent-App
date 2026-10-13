"""Bounded, read-only Live 11 listening evidence. No file IO or audio polling."""

from __future__ import absolute_import, unicode_literals

import hashlib
import json
import math
import re

from .core_domain_commands import (
    _clip_reference, _integer, _name, _number, _resolve_clip, _resolve_track, _strict,
    _track_reference, _track_target, _uuid,
)
from .device_commands import (
    _device_reference, _parameter_reference, _resolve_identity,
)
from .errors import ProtocolFailure
from .system_commands import _safe_lom_getattr, _same_lom_object

MAX_BEATS = 1576800
SCAN_LIMIT = 256
INDEX_TOKEN = r"(?:0|[1-9][0-9]{0,2})"
PATH_RE = re.compile(
    r"^live_set (?:tracks {0}|return_tracks {0}|master_track) devices {0}"
    r"(?: chains {0} devices {0}){{0,4}}$".format(INDEX_TOKEN)
)
CLIP_FIELDS = (
    "file_path", "gain", "pitch_coarse", "pitch_fine", "warping", "warp_mode",
    "start_marker", "end_marker", "loop_start", "loop_end", "looping",
    "muted", "length", "sample_length", "sample_rate",
)
TRACK_FIELDS = (
    "mute", "solo", "arm", "current_monitoring_state", "back_to_arranger",
    "has_audio_input", "has_midi_input",
)


def validate_listening_context(params):
    if not _strict(
        params, ("schemaVersion", "listeners", "range"),
        ("maxClips", "maxParameters", "bindingQueryId"),
    ) or params.get("schemaVersion") != 1 or isinstance(params.get("schemaVersion"), bool):
        return "Unsupported or invalid listening context schema"
    if "bindingQueryId" in params and not _uuid(params["bindingQueryId"]):
        return "Invalid listening binding query identity"
    listeners = params.get("listeners")
    if not isinstance(listeners, list) or not 1 <= len(listeners) <= 8:
        return "Listening requires 1..8 exact listener bindings"
    references = set()
    for target in listeners:
        if _strict(target, ("canonicalPath",)):
            path = target["canonicalPath"]
            if not isinstance(path, str) or len(path) > 512 or PATH_RE.fullmatch(path) is None:
                return "Invalid canonical listener path"
            key = "path:" + path
            if key in references:
                return "Listener bindings must be unique"
            references.add(key)
            continue
        if not (
            _strict(target, (
                "track", "deviceIndex", "expectedDeviceReference",
                "expectedDeviceName", "expectedClassName",
            ))
            and _track_target(target["track"])
            and _integer(target["deviceIndex"], 0)
            and _uuid(target["expectedDeviceReference"])
            and _name(target["expectedDeviceName"])
            and _name(target["expectedClassName"])
        ):
            return "Invalid listener identity"
        if target["expectedDeviceReference"] in references:
            return "Listener bindings must be unique"
        references.add(target["expectedDeviceReference"])
    window = params["range"]
    if not (
        _strict(window, ("startBeat", "endBeat"))
        and _number(window["startBeat"], 0, MAX_BEATS)
        and _number(window["endBeat"], 0, MAX_BEATS)
        and window["endBeat"] > window["startBeat"]
        and _integer(params.get("maxClips", 32), 1, 64)
        and _integer(params.get("maxParameters", 16), 1, 32)
    ):
        return "Listening range or evidence budget is invalid"
    return None


def _placement_collection(obj, field, limit):
    collection = _safe_lom_getattr(obj, field)
    if collection is None:
        raise ProtocolFailure("unsupported_capability", "Listener placement collection is unavailable")
    if len(collection) > limit:
        raise ProtocolFailure("unsupported_capability", "Listener placement exceeds bounded traversal")
    return collection


def _attest_path(context, track, device):
    """Derive paths from actual Song collections, never numeric IDs or names."""
    track_matches = []
    reachable_tracks = []
    for field, kind in (("tracks", "regular"), ("return_tracks", "return")):
        collection = _placement_collection(context.song, field, 256)
        for index in range(len(collection)):
            reachable_tracks.append(collection[index])
            if _same_lom_object(collection[index], track):
                track_matches.append((kind, index, "live_set {0} {1}".format(field, index)))
    master = _safe_lom_getattr(context.song, "master_track")
    if master is not None:
        reachable_tracks.append(master)
    if master is not None and _same_lom_object(master, track):
        track_matches.append(("master", None, "live_set master_track"))
    if len(track_matches) != 1:
        raise ProtocolFailure("ambiguous_reference" if track_matches else "not_found",
                              "Listener owning track is not uniquely reachable")
    devices = _placement_collection(track, "devices", 32)
    positions = [index for index in range(len(devices)) if _same_lom_object(devices[index], device)]
    if len(positions) != 1:
        raise ProtocolFailure("ambiguous_reference" if positions else "not_found",
                              "Listener device placement is not uniquely reachable")
    reachable_positions = []
    for owner in reachable_tracks:
        owner_devices = _placement_collection(owner, "devices", 32)
        for index in range(len(owner_devices)):
            if _same_lom_object(owner_devices[index], device):
                reachable_positions.append((owner, index))
    if len(reachable_positions) != 1:
        raise ProtocolFailure("ambiguous_reference", "Listener has multiple reachable device paths")
    parent = _safe_lom_getattr(device, "canonical_parent")
    if parent is not None and not _same_lom_object(parent, track):
        raise ProtocolFailure("unsupported_capability", "Nested or unknown listener ownership is unsupported")
    kind, track_index, track_path = track_matches[0]
    target = {
        "track": {
            "kind": kind, "expectedReference": _track_reference(context, track, bounded=True),
            "expectedName": _safe_lom_getattr(track, "name", "") or "",
        },
        "deviceIndex": positions[0],
        "expectedDeviceReference": _device_reference(context, device, bounded=True),
        "expectedDeviceName": _safe_lom_getattr(device, "name", "") or "",
        "expectedClassName": _safe_lom_getattr(device, "class_name", "") or "",
    }
    if track_index is not None:
        target["track"]["index"] = track_index
    if any(not _name(value) for value in (
        target["track"]["expectedName"], target["expectedDeviceName"], target["expectedClassName"],
    )):
        raise ProtocolFailure("unsupported_capability", "Listener identity exceeds bounded schema")
    attestation = {
        "schemaVersion": 1, "source": "remote-script-lom",
        "canonicalTrackPath": track_path,
        "canonicalDevicePath": track_path + " devices " + str(positions[0]),
        "trackReference": target["track"]["expectedReference"],
        "deviceReference": target["expectedDeviceReference"],
        "placement": {"kind": "track-device", "deviceIndex": positions[0]},
    }
    return target, attestation


def _resolve_path(context, path):
    tokens = path.split(" ")
    if "chains" in tokens:
        raise ProtocolFailure("unsupported_capability", "Nested listener paths are not independently supported")
    if tokens[1] == "master_track":
        track = _safe_lom_getattr(context.song, "master_track")
        device_index = int(tokens[3])
    else:
        track_index, device_index = int(tokens[2]), int(tokens[4])
        if track_index >= 256:
            raise ProtocolFailure("unsupported_capability", "Listener track exceeds bounded traversal")
        tracks = _placement_collection(context.song, tokens[1], 256)
        if track_index >= len(tracks):
            raise ProtocolFailure("not_found", "Canonical listener track is unavailable")
        track = tracks[track_index]
    if track is None:
        raise ProtocolFailure("not_found", "Canonical listener track is unavailable")
    if device_index >= 32:
        raise ProtocolFailure("unsupported_capability", "Listener device exceeds bounded traversal")
    devices = _placement_collection(track, "devices", 32)
    if device_index >= len(devices):
        raise ProtocolFailure("not_found", "Canonical listener device is unavailable")
    target, attestation = _attest_path(context, track, devices[device_index])
    if attestation["canonicalDevicePath"] != path:
        raise ProtocolFailure("stale_reference", "Canonical listener path changed")
    return target


def _scalar(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, str) and len(value) <= 1024:
        return value
    return None


def _read(obj, name):
    return _scalar(_safe_lom_getattr(obj, name))


def _boolean(obj, name):
    value = _read(obj, name)
    return value if isinstance(value, bool) else None


def _beat(obj, name):
    value = _read(obj, name)
    return value if _number(value, 0, MAX_BEATS) else None


def _evidence(obj, fields):
    return [{"field": name, "value": _read(obj, name)} for name in fields]


def fingerprint(evidence, reasons):
    """Hashes only observed fields; unknown dependencies never become fresh."""
    return {
        "algorithm": "sha256",
        "scope": "available-live-fields/v1",
        "digest": hashlib.sha256(json.dumps(
            evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")).hexdigest(),
        "completeness": "unknown" if reasons else "complete",
        "unknownReasons": reasons[:16],
    }


def _bounded_collection(obj, field, limit):
    collection = _safe_lom_getattr(obj, field)
    if collection is None:
        return [], True
    try:
        # LOM collections support len/index; never materialize a whole Set.
        count = len(collection)
        return [collection[index] for index in range(min(count, limit))], count > limit
    except (AttributeError, IndexError, TypeError, RuntimeError):
        return [], True


def _clip(context, clip, target, interval, activity):
    _resolve_clip(context, target, scan_limit=SCAN_LIMIT)
    settings = _evidence(clip, CLIP_FIELDS)
    reasons = ["source-content-not-hashed", "warp-markers-unverified", "automation-unverified"]
    if any(item["value"] is None for item in settings):
        reasons.append("clip-fields-unavailable")
    evidence = {"settings": settings, "interval": interval}
    return {
        "target": target, "interval": interval, "activity": activity,
        "isAudioClip": _boolean(clip, "is_audio_clip"),
        "isRecording": _boolean(clip, "is_recording"),
        "settings": settings, "fingerprint": fingerprint(evidence, reasons),
    }


def _activity(playing, override, clip, in_interval=True):
    active = _boolean(clip, "is_playing")
    if playing is False or override is True or not in_interval or active is False:
        return "inactive"
    if playing is True and override is False and active is True:
        return "active"
    return "unknown"


def _listener(context, target, params, transport):
    if "canonicalPath" in target:
        target = _resolve_path(context, target["canonicalPath"])
    if target["deviceIndex"] >= 32:
        raise ProtocolFailure("unsupported_capability", "Listener exceeds bounded device inspection")
    track = _resolve_track(context, target["track"], bounded=True)
    device = _resolve_identity(
        _safe_lom_getattr(track, "devices", ()),
        {
            "index": target["deviceIndex"],
            "expectedReference": target["expectedDeviceReference"],
            "expectedName": target["expectedDeviceName"],
        },
        lambda value: _device_reference(context, value, bounded=True), "Listener",
    )
    if _safe_lom_getattr(device, "class_name") != target["expectedClassName"]:
        raise ProtocolFailure("stale_reference", "Listener class changed")
    if target["expectedClassName"] != "MxDeviceAudioEffect":
        raise ProtocolFailure("conflict", "Listener must be a Max for Live Audio Effect")
    attested_target, path_attestation = _attest_path(context, track, device)
    if attested_target != target:
        raise ProtocolFailure("stale_reference", "Listener placement changed during inspection")
    reasons = ["nonexclusive-audio-tap", "routing-dependencies-unverified",
               "automation-unverified", "device-hidden-state-unverified"]
    devices, _devices_truncated = _bounded_collection(track, "devices", 32)
    dependencies_truncated = False
    upstream = []
    remaining = params.get("maxParameters", 16)
    for upstream_device in devices[:target["deviceIndex"] + 1]:
        parameters, truncated = _bounded_collection(upstream_device, "parameters", remaining)
        dependencies_truncated = dependencies_truncated or truncated
        upstream.append({
            "reference": _device_reference(context, upstream_device, bounded=True),
            "name": str(_safe_lom_getattr(upstream_device, "name", ""))[:128],
            "className": str(_safe_lom_getattr(upstream_device, "class_name", ""))[:128],
            "enabled": _boolean(upstream_device, "is_active"),
            "parameters": [{
                "reference": _parameter_reference(context, parameter, bounded=True),
                "name": str(_safe_lom_getattr(parameter, "name", ""))[:128],
                "value": _read(parameter, "value") if _number(_read(parameter, "value")) else None,
            } for parameter in parameters],
        })
        remaining -= len(parameters)
    # Downstream devices do not affect a known top-level tap.
    dependencies_truncated = dependencies_truncated or len(upstream) != target["deviceIndex"] + 1
    index = _read(track, "playing_slot_index")
    back = _boolean(track, "back_to_arranger")
    override = (
        True if _integer(index, 0) or back is True
        else False if index == -2 or back is False
        else None
    )
    clips = []
    truncated = False
    max_clips = params.get("maxClips", 32)
    if target["track"]["kind"] == "regular":
        slots, slots_truncated = _bounded_collection(track, "clip_slots", SCAN_LIMIT)
        truncated = slots_truncated
        # Include the actual playing slot first even if outside the bounded scan.
        if _integer(index, 0) and index >= len(slots):
            collection = _safe_lom_getattr(track, "clip_slots", ())
            if index < len(collection):
                slots = [(index, collection[index])] + list(enumerate(slots))
            else:
                override = None
                slots = list(enumerate(slots))
        else:
            slots = sorted(enumerate(slots), key=lambda pair: pair[0] != index)
        for scene_index, slot in slots:
            if _boolean(slot, "is_triggered") is True:
                reasons.append("session-slot-trigger-pending")
            has_clip = _boolean(slot, "has_clip")
            if has_clip is None:
                truncated = True
            if has_clip is not True:
                continue
            if len(clips) >= max_clips:
                truncated = True
                break
            clip = _safe_lom_getattr(slot, "clip")
            if clip is None:
                truncated = True
                continue
            clip_target = {
                "view": "session", "track": target["track"], "sceneIndex": scene_index,
                "expectedClipReference": _clip_reference(context, clip, bounded=True),
                "expectedClipName": _safe_lom_getattr(clip, "name", "") or "",
            }
            activity = (
                "active" if transport["playing"] is True and index == scene_index
                and _boolean(clip, "is_playing") is True
                else "inactive" if transport["playing"] is False or _boolean(clip, "is_playing") is False or (
                    _integer(index, -2) and index != scene_index
                ) else "unknown"
            )
            clips.append(_clip(context, clip, clip_target, None, activity))
        arrangement, arrangement_truncated = _bounded_collection(track, "arrangement_clips", SCAN_LIMIT)
        truncated = truncated or arrangement_truncated
        for clip in arrangement:
            start, end = _beat(clip, "start_time"), _beat(clip, "end_time")
            if start is None or end is None or end <= start:
                reasons.append("arrangement-interval-unavailable")
                continue
            if end <= params["range"]["startBeat"] or start >= params["range"]["endBeat"]:
                continue
            if len(clips) >= max_clips:
                truncated = True
                break
            clip_target = {
                "view": "arrangement", "track": target["track"],
                "expectedClipReference": _clip_reference(context, clip, bounded=True),
                "expectedClipName": _safe_lom_getattr(clip, "name", "") or "",
                "expectedStartTime": start,
            }
            current = transport["currentBeat"]
            clips.append(_clip(
                context, clip, clip_target, {"startBeat": start, "endBeat": end},
                _activity(transport["playing"], override if current is not None else None, clip,
                          current is None or start <= current < end),
            ))
    else:
        reasons.append("mixed-return-or-master")
        override = None
    track_evidence = _evidence(track, TRACK_FIELDS)
    mixer = _safe_lom_getattr(track, "mixer_device")
    for field in ("volume", "panning", "crossfader_assign"):
        value = _safe_lom_getattr(mixer, field)
        track_evidence.append({
            "field": "mixer." + field,
            "value": _scalar(value) if field == "crossfader_assign" else _read(value, "value"),
        })
    for field in ("input_routing_type", "input_routing_channel",
                  "output_routing_type", "output_routing_channel"):
        route = _safe_lom_getattr(track, field)
        track_evidence.append({"field": field, "value": _read(route, "display_name")})
    sends, sends_truncated = _bounded_collection(mixer, "sends", 8)
    for send_index, send in enumerate(sends):
        track_evidence.append({
            "field": "mixer.send." + str(send_index), "value": _read(send, "value"),
        })
    if sends_truncated:
        reasons.append("send-state-unverified")
    if truncated:
        reasons.append("clip-scan-truncated")
    if dependencies_truncated:
        reasons.append("dependency-scan-truncated")
    if override is None:
        reasons.append("session-override-unknown")
    evidence = {
        "binding": target, "track": track_evidence, "upstream": upstream,
        "clips": [item["fingerprint"] for item in clips], "tempo": transport["tempo"],
    }
    return {
        "binding": target, "verified": True,
        "canonicalPath": path_attestation["canonicalDevicePath"],
        "pathAttestation": path_attestation,
        "enabled": _boolean(device, "is_active"), "sessionOverride": override,
        "clips": clips, "clipsTruncated": truncated,
        "trackEvidence": track_evidence, "upstreamDevices": upstream,
        "dependenciesTruncated": dependencies_truncated,
        "fingerprint": fingerprint(evidence, list(dict.fromkeys(reasons))),
        "attribution": "nonexclusive", "unknownReasons": list(dict.fromkeys(reasons))[:16],
    }


def inspect_listening_context(context, params):
    error = validate_listening_context(params)
    if error:
        raise ProtocolFailure("invalid_params", error)
    song = context.song
    recording = {
        public: _boolean(song, private) for public, private in (
            ("recordMode", "record_mode"), ("sessionRecord", "session_record"),
            ("arrangementOverdub", "overdub"),
            ("sessionAutomationRecord", "session_automation_record"),
        )
    }
    transport = {
        "playing": _boolean(song, "is_playing"),
        "currentBeat": _beat(song, "current_song_time"),
        "tempo": _read(song, "tempo") if _number(_read(song, "tempo"), positive=True) else None,
        "recording": recording, "safeToStart": False,
    }
    listeners = [_listener(context, target, params, transport) for target in params["listeners"]]
    if len(set(listener["binding"]["expectedDeviceReference"] for listener in listeners)) != len(listeners):
        raise ProtocolFailure("ambiguous_reference", "Listener selectors resolve to the same device")
    transport["safeToStart"] = (
        transport["playing"] is False
        and all(value is False for value in recording.values())
        and all(not listener["clipsTruncated"] for listener in listeners)
        and all(clip["isRecording"] is False for listener in listeners for clip in listener["clips"])
        and all("arrangement-interval-unavailable" not in listener["unknownReasons"] for listener in listeners)
        and all("session-slot-trigger-pending" not in listener["unknownReasons"] for listener in listeners)
    )
    result = {
        "schemaVersion": 1, "projectRevision": context.project_revision,
        "bindingScope": "live-connection", "transport": transport,
        "listeners": listeners,
    }
    if "bindingQueryId" in params:
        result["bindingQueryId"] = params["bindingQueryId"]
    return result


def register_listening_commands(registry):
    from .listening_playback import register_playback_commands

    register_playback_commands(registry)
    registry.register(
        "listening.inspect_context", inspect_listening_context,
        capability="listening.inspect_context", validator=validate_listening_context,
    )
