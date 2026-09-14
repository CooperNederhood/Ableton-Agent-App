"""Capability-detected Live 11 workflow adapters.

The public protocol uses semantic action names. Private Live names remain
contained in this module and every mutation performs an identity check plus a
readback before reporting success.
"""

from __future__ import absolute_import, unicode_literals

import datetime
import hashlib
import json
import math
import uuid

from .errors import ProtocolFailure
from .core_domain_commands import (
    _clip_reference,
    _resolve_clip,
    _resolve_scene,
    _resolve_track,
    _scene_reference,
    _track_reference,
)
from .device_commands import (
    _chain_reference,
    _device_reference,
    _pad_reference,
    _parameter_reference,
)
from .browser_commands import _resolve_expected_item
from .system_commands import _safe_lom_getattr, _same_lom_object

GLOBAL_HISTORY_WARNING = (
    "Undo and redo operate on Live's global history and may include changes "
    "made outside Ableton Agent. Compound operations are not promised as "
    "atomic rollback."
)
MAX_JOBS = 128
MISSING = object()


def _now():
    return datetime.datetime.utcnow().replace(
        tzinfo=datetime.timezone.utc
    ).isoformat().replace("+00:00", "Z")


def _finite(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _unsupported(message):
    raise ProtocolFailure("unsupported_capability", message)


def _strict_action(params, actions):
    if not isinstance(params, dict) or params.get("action") not in actions:
        return "Invalid workflow adapter operation parameters"
    return None


def _runtime_context_error(params, require_tracks):
    runtime_context = params.get("runtimeContext")
    if not isinstance(runtime_context, dict):
        return "Runtime job context is required"
    for field in ("ownerId", "correlationId", "traceId"):
        value = runtime_context.get(field)
        if not isinstance(value, str) or not value or len(value) > 128:
            return "Runtime job context field '{0}' is invalid".format(field)
    causation_id = runtime_context.get("causationId")
    if causation_id is not None and (
        not isinstance(causation_id, str)
        or not causation_id
        or len(causation_id) > 128
    ):
        return "Runtime job context field 'causationId' is invalid"
    if require_tracks:
        track_references = runtime_context.get("trackReferences")
        if (
            not isinstance(track_references, list)
            or not track_references
            or len(track_references) > 16
            or any(
                not isinstance(reference, str) or not reference
                for reference in track_references
            )
        ):
            return "Runtime job track references are invalid"
    return None


def validate_recording(params):
    error = _strict_action(
        params,
        (
            "inspect",
            "set-arrangement-record",
            "set-session-record",
            "set-overdub",
            "set-session-automation-record",
            "set-punch",
            "capture-midi",
            "record-session-slot",
        ),
    )
    if error is not None:
        return error
    if params.get("action") == "record-session-slot":
        return _runtime_context_error(params, True)
    return None


def validate_grooves(params):
    return _strict_action(
        params,
        (
            "list",
            "get",
            "inspect-clip",
            "set-clip-groove",
            "clear-clip-groove",
            "set-properties",
            "set-global-amount",
        ),
    )


def validate_selection_view(params):
    return _strict_action(
        params,
        (
            "inspect-selection",
            "inspect-view",
            "select-track",
            "select-scene",
            "select-slot",
            "select-clip",
            "select-device",
            "select-chain",
            "set-view",
            "set-follow",
            "set-draw-mode",
            "set-track-fold",
            "set-device-collapsed",
        ),
    )


def validate_history(params):
    return _strict_action(params, ("inspect", "undo", "redo"))


def validate_browser_adapters(params):
    return _strict_action(
        params,
        (
            "preview",
            "stop-preview",
            "hot-swap",
            "insert-adjacent",
            "load-empty-drum-pad",
        ),
    )


def validate_clip_automation(params):
    return _strict_action(
        params,
        ("list-envelopes", "sample", "insert-step", "clear-envelope", "clear-all"),
    )


def validate_warp_markers(params):
    return _strict_action(params, ("inspect", "add", "move", "remove"))


def validate_special_devices(params):
    error = _strict_action(
        params,
        (
            "inspect-simpler",
            "set-simpler-markers",
            "set-simpler-slices",
            "inspect-looper",
            "control-looper",
            "export-looper",
            "inspect-wavetable",
            "set-wavetable-modulation",
        ),
    )
    if error is not None:
        return error
    if params.get("action") == "export-looper":
        return _runtime_context_error(params, True)
    return None


def validate_jobs(params):
    error = _strict_action(params, ("get", "list", "cancel"))
    if error is not None:
        return error
    if params.get("action") == "cancel":
        runtime_context = params.get("runtimeContext")
        owner_id = (
            runtime_context.get("ownerId")
            if isinstance(runtime_context, dict)
            else None
        )
        if not isinstance(owner_id, str) or not owner_id or len(owner_id) > 128:
            return "Runtime job owner is invalid"
    return None


def _route_validator(validator, actions):
    def validate(params):
        error = validator(params)
        if error is not None:
            return error
        return _strict_action(params, actions)

    return validate


def _recording_state(song):
    names = (
        ("arrangementRecord", "record_mode"),
        ("sessionRecord", "session_record"),
        ("overdub", "overdub"),
        ("sessionAutomationRecord", "session_automation_record"),
        ("punchIn", "punch_in"),
        ("punchOut", "punch_out"),
    )
    state = {}
    for public, private in names:
        value = _safe_lom_getattr(song, private)
        if value is None:
            _unsupported("Live 11 does not expose recording state: {0}".format(public))
        state[public] = bool(value)
    return state


def _verified_song_flags(song, changes):
    before = _recording_state(song)
    changed = []
    try:
        for attribute, value in changes:
            if _safe_lom_getattr(song, attribute) is None:
                _unsupported(
                    "Live 11 does not expose recording control '{0}'".format(
                        attribute
                    )
                )
            setattr(song, attribute, bool(value))
            changed.append(attribute)
        after = _recording_state(song)
        expected = dict(before)
        public_names = {
            "record_mode": "arrangementRecord",
            "session_record": "sessionRecord",
            "overdub": "overdub",
            "session_automation_record": "sessionAutomationRecord",
            "punch_in": "punchIn",
            "punch_out": "punchOut",
        }
        for attribute, value in changes:
            expected[public_names[attribute]] = bool(value)
        if after != expected:
            raise ProtocolFailure(
                "conflict", "Recording mutation readback did not match"
            )
        return before, after
    except Exception:
        for attribute in reversed(changed):
            public = {
                "record_mode": "arrangementRecord",
                "session_record": "sessionRecord",
                "overdub": "overdub",
                "session_automation_record": "sessionAutomationRecord",
                "punch_in": "punchIn",
                "punch_out": "punchOut",
            }[attribute]
            try:
                setattr(song, attribute, before[public])
            except Exception:
                pass
        raise


def _resolve_session_slot(context, target, require_empty=None):
    track = _resolve_track(context, target.get("track"))
    if target["track"].get("kind") != "regular":
        raise ProtocolFailure("invalid_params", "Session slots require a regular track")
    scene_index = target.get("sceneIndex")
    _resolve_scene(
        context,
        {
            "index": scene_index,
            "expectedReference": target.get("expectedSceneReference"),
            "expectedName": target.get("expectedSceneName"),
        },
    )
    slots = list(_safe_lom_getattr(track, "clip_slots", ()) or ())
    if not isinstance(scene_index, int) or scene_index < 0 or scene_index >= len(slots):
        raise ProtocolFailure("not_found", "Session slot no longer exists")
    slot = slots[scene_index]
    has_clip = bool(_safe_lom_getattr(slot, "has_clip", False))
    if has_clip != bool(target.get("expectedHasClip")):
        raise ProtocolFailure("stale_reference", "Session slot occupancy changed")
    if has_clip:
        clip = _safe_lom_getattr(slot, "clip")
        if (
            _clip_reference(context, clip) != target.get("expectedClipReference")
            or (_safe_lom_getattr(clip, "name", "") or "")
            != target.get("expectedClipName")
        ):
            raise ProtocolFailure("stale_reference", "Session clip identity changed")
    if require_empty is True and has_clip:
        raise ProtocolFailure("conflict", "Destination Session slot is occupied")
    return track, slot


def _job_manager(context):
    manager = getattr(context, "_workflow_job_manager", None)
    if manager is None:
        manager = WorkflowJobManager(context)
        context._workflow_job_manager = manager
    return manager


def _validate_job_track_context(runtime_context, expected_references):
    actual = sorted(set(runtime_context["trackReferences"]))
    expected = sorted(set(expected_references))
    if actual != expected:
        raise ProtocolFailure(
            "invalid_params",
            "Runtime job track scope does not match the exact operation targets",
        )


class WorkflowJobManager(object):
    def __init__(self, context):
        self._context = context
        self._jobs = {}
        self._order = []
        self._cancel_callbacks = {}
        self._job_contexts = {}

    def _emit(self, stage, job):
        publish = getattr(self._context, "publish_event", None)
        if publish is not None:
            payload = {
                "jobId": job["jobId"],
                "kind": job["kind"],
                "status": job["status"],
                "progress": job["progress"],
                "correlationId": job["correlationId"],
                "traceId": job["traceId"],
                "updatedAt": job["updatedAt"],
            }
            if job.get("causationId") is not None:
                payload["causationId"] = job["causationId"]
            publish(
                "workflow_job.{0}".format(stage),
                payload,
                getattr(self._context, "project_revision", None),
            )

    def create(self, kind, runtime_context, cancel_callback=None):
        timestamp = _now()
        job = {
            "jobId": str(uuid.uuid4()),
            "kind": kind,
            "status": "queued",
            "progress": 0.0,
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "correlationId": runtime_context["correlationId"],
            "traceId": runtime_context["traceId"],
        }
        if runtime_context.get("causationId") is not None:
            job["causationId"] = runtime_context["causationId"]
        self._jobs[job["jobId"]] = job
        self._job_contexts[job["jobId"]] = {
            "ownerId": runtime_context["ownerId"],
            "trackReferences": list(runtime_context["trackReferences"]),
        }
        self._order.append(job["jobId"])
        if cancel_callback is not None:
            self._cancel_callbacks[job["jobId"]] = cancel_callback
        while len(self._order) > MAX_JOBS:
            expired = self._order.pop(0)
            self._jobs.pop(expired, None)
            self._cancel_callbacks.pop(expired, None)
            self._job_contexts.pop(expired, None)
        self._emit("queued", job)
        return job

    def update(self, job_id, status, progress=None, result=None, error=None):
        job = self._jobs.get(job_id)
        if job is None:
            return None
        terminal = ("completed", "failed", "cancelled", "indeterminate")
        if job["status"] in terminal and status != job["status"]:
            raise ProtocolFailure(
                "conflict",
                "Workflow job terminal state cannot transition to {0}".format(status),
            )
        job["status"] = status
        if progress is not None:
            job["progress"] = min(1.0, max(0.0, float(progress)))
        if result is not None:
            job["result"] = result
        if error is not None:
            job["error"] = {
                "code": str(error.get("code", "job_failed"))[:64],
                "message": str(error.get("message", "Job failed"))[:512],
            }
        job["updatedAt"] = _now()
        self._emit(
            "progress" if status == "running" else status,
            job,
        )
        if status in terminal:
            self._cancel_callbacks.pop(job_id, None)
        return job

    def get(self, job_id):
        job = self._jobs.get(job_id)
        if job is None:
            raise ProtocolFailure("not_found", "Workflow job was not found")
        return dict(job)

    def list(self):
        return [dict(self._jobs[job_id]) for job_id in reversed(self._order)]

    def cancel(self, job_id, owner_id):
        job = self._jobs.get(job_id)
        if job is None:
            raise ProtocolFailure("not_found", "Workflow job was not found")
        job_context = self._job_contexts.get(job_id)
        if job_context is None or job_context["ownerId"] != owner_id:
            raise ProtocolFailure(
                "conflict",
                "Workflow job can only be cancelled by its originating agent",
            )
        if job["status"] in ("completed", "failed", "cancelled", "indeterminate"):
            return dict(job), False
        callback = self._cancel_callbacks.get(job_id)
        if callback is not None:
            callback()
        return dict(self.update(job_id, "cancelled", job["progress"])), True

    def mark_running_indeterminate(self):
        for job_id in list(self._order):
            job = self._jobs.get(job_id)
            if job and job["status"] in ("queued", "started", "running"):
                self.update(job_id, "indeterminate", job["progress"])


def _start_timed_recording(context, params):
    track, slot = _resolve_session_slot(context, params["target"], require_empty=True)
    _validate_job_track_context(
        params["runtimeContext"],
        [params["target"]["track"]["expectedReference"]],
    )
    if not bool(_safe_lom_getattr(track, "can_be_armed", False)):
        raise ProtocolFailure("conflict", "Target track cannot be armed")
    if not bool(_safe_lom_getattr(track, "arm", False)):
        raise ProtocolFailure(
            "conflict", "Timed Session recording requires the exact target track armed"
        )
    fire = _safe_lom_getattr(slot, "fire")
    if not callable(fire):
        _unsupported("Live 11 does not expose timed Session-slot recording")
    manager = _job_manager(context)
    job = manager.create(
        "timed-session-recording",
        params["runtimeContext"],
        cancel_callback=lambda: (
            _safe_lom_getattr(slot, "stop")()
            if callable(_safe_lom_getattr(slot, "stop"))
            else None
        ),
    )
    manager.update(job["jobId"], "started", 0.0)
    try:
        quantization = params.get("launchQuantization")
        if quantization is None:
            fire(record_length=params["durationBeats"])
        else:
            fire(
                record_length=params["durationBeats"],
                launch_quantization=quantization,
            )
    except TypeError:
        if quantization is None:
            fire(params["durationBeats"])
        else:
            fire(params["durationBeats"], quantization)
    except Exception as exc:
        manager.update(
            job["jobId"],
            "failed",
            0.0,
            error={"code": "lom_error", "message": str(exc)},
        )
        raise
    manager.update(job["jobId"], "running", 0.05)
    poll_state = {"attempts": 0, "clipReference": None}
    max_polls = max(
        10,
        int(math.ceil((params["durationBeats"] + 128.0) * 30.0)),
    )

    def poll_until_complete():
        current = manager.get(job["jobId"])
        if current["status"] == "cancelled":
            return
        poll_state["attempts"] += 1
        has_clip = bool(_safe_lom_getattr(slot, "has_clip", False))
        if has_clip:
            clip = _safe_lom_getattr(slot, "clip")
            clip_reference = _clip_reference(context, clip)
            if poll_state["clipReference"] is None:
                poll_state["clipReference"] = clip_reference
            elif poll_state["clipReference"] != clip_reference:
                manager.update(
                    job["jobId"],
                    "failed",
                    1.0,
                    error={
                        "code": "stale_reference",
                        "message": "Timed recording destination clip changed",
                    },
                )
                return
            is_recording = _safe_lom_getattr(clip, "is_recording")
            if is_recording is None:
                manager.update(
                    job["jobId"],
                    "failed",
                    1.0,
                    error={
                        "code": "unsupported_capability",
                        "message": "Timed recording state cannot be verified",
                    },
                )
                return
            if not bool(is_recording):
                manager.update(
                    job["jobId"],
                    "completed",
                    1.0,
                    result={
                        "trackReference": _track_reference(context, track),
                        "clipReference": clip_reference,
                        "sceneIndex": params["target"]["sceneIndex"],
                    },
                )
                return
        if poll_state["attempts"] >= max_polls:
            manager.update(
                job["jobId"],
                "failed",
                1.0,
                error={
                    "code": "operation_timeout",
                    "message": "Timed recording did not reach a verified terminal state",
                },
            )
            return
        context.schedule_message(1, poll_until_complete)

    context.schedule_message(1, poll_until_complete)
    return manager.get(job["jobId"])


def execute_recording(context, params):
    action = params["action"]
    if action == "inspect":
        return {"action": action, "state": _recording_state(context.song)}
    if action == "record-session-slot":
        return {
            "action": action,
            "job": _start_timed_recording(context, params),
            "recordingIntent": "record",
        }
    warnings = []
    if action == "capture-midi":
        if params.get("destination") != "selected-armed-tracks":
            raise ProtocolFailure("invalid_params", "Unsupported Capture MIDI destination")
        capture = _safe_lom_getattr(context.song, "capture_midi")
        if not callable(capture):
            _unsupported("Live 11 does not expose Capture MIDI")
        selected = _safe_lom_getattr(_safe_lom_getattr(context.song, "view"), "selected_track")
        if selected is None or not bool(_safe_lom_getattr(selected, "arm", False)):
            raise ProtocolFailure(
                "conflict", "Capture MIDI requires a selected armed track"
            )
        capture()
        return {
            "action": action,
            "destination": "selected-armed-tracks",
            "captured": True,
            "verified": True,
            "warnings": [
                "Capture MIDI uses Live's selected armed-track destination semantics."
            ],
        }
    changes = {
        "set-arrangement-record": [("record_mode", params["enabled"])],
        "set-session-record": [("session_record", params["enabled"])],
        "set-overdub": [("overdub", params["enabled"])],
        "set-session-automation-record": [
            ("session_automation_record", params["enabled"])
        ],
        "set-punch": [
            (attribute, params[public])
            for public, attribute in (
                ("punchIn", "punch_in"),
                ("punchOut", "punch_out"),
            )
            if public in params
        ],
    }[action]
    before, after = _verified_song_flags(context.song, changes)
    return {
        "action": action,
        "result": {
            "before": before,
            "after": after,
            "verified": True,
            "warnings": warnings,
        },
    }


def _grooves(context):
    pool = _safe_lom_getattr(context.song, "groove_pool")
    if pool is None:
        _unsupported("Live 11 does not expose the Groove Pool")
    return list(_safe_lom_getattr(pool, "grooves", ()) or ())


def _groove_reference(context, groove):
    current = _grooves(context)
    refs = [
        pair
        for pair in getattr(context, "_groove_references", [])
        if any(_same_lom_object(pair[0], candidate) for candidate in current)
    ]
    for candidate, reference in refs:
        if _same_lom_object(candidate, groove):
            context._groove_references = refs
            return reference
    reference = str(uuid.uuid4())
    refs.append((groove, reference))
    context._groove_references = refs
    return reference


def _optional_number(value, name):
    current = _safe_lom_getattr(value, name)
    return float(current) if _finite(current) else None


def _groove_summary(context, index, groove):
    return {
        "index": index,
        "reference": _groove_reference(context, groove),
        "name": _safe_lom_getattr(groove, "name", "") or "",
        "base": _optional_number(groove, "base"),
        "quantizationAmount": _optional_number(groove, "quantization_amount"),
        "timingAmount": _optional_number(groove, "timing_amount"),
        "randomAmount": _optional_number(groove, "random_amount"),
        "velocityAmount": _optional_number(groove, "velocity_amount"),
    }


def _groove_revision(context):
    payload = [
        (_groove_reference(context, groove), _safe_lom_getattr(groove, "name", ""))
        for groove in _grooves(context)
    ]
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def _resolve_groove(context, target):
    if target.get("poolRevision") != _groove_revision(context):
        raise ProtocolFailure(
            "stale_reference", "Groove Pool changed; refresh groove handles"
        )
    grooves = _grooves(context)
    index = target.get("index")
    if not isinstance(index, int) or index < 0 or index >= len(grooves):
        raise ProtocolFailure("not_found", "Groove no longer exists")
    groove = grooves[index]
    if (
        _groove_reference(context, groove) != target.get("expectedReference")
        or (_safe_lom_getattr(groove, "name", "") or "")
        != target.get("expectedName")
    ):
        raise ProtocolFailure("stale_reference", "Groove identity changed")
    return groove


def _clip_groove_state(context, clip):
    assigned = _safe_lom_getattr(clip, "groove")
    summary = None
    if assigned is not None:
        for index, groove in enumerate(_grooves(context)):
            if _same_lom_object(assigned, groove):
                summary = _groove_summary(context, index, groove)
                break
    return {"clipReference": _clip_reference(context, clip), "groove": summary}


def execute_grooves(context, params):
    action = params["action"]
    grooves = _grooves(context)
    if action == "list":
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "grooves": [
                _groove_summary(context, index, groove)
                for index, groove in enumerate(grooves[offset : offset + limit], offset)
            ],
            "total": len(grooves),
            "offset": offset,
            "limit": limit,
            "poolRevision": _groove_revision(context),
            "globalAmount": float(_safe_lom_getattr(context.song, "groove_amount", 1.0)),
        }
    if action == "get":
        groove = _resolve_groove(context, params["target"])
        return {
            "action": action,
            "groove": _groove_summary(context, params["target"]["index"], groove),
            "poolRevision": _groove_revision(context),
        }
    if action in ("inspect-clip", "set-clip-groove", "clear-clip-groove"):
        clip = _resolve_clip(context, params["target"])
        before = _clip_groove_state(context, clip)
        if action == "inspect-clip":
            return {"action": action, "state": before}
        assigned = (
            _resolve_groove(context, params["groove"])
            if action == "set-clip-groove"
            else None
        )
        if _safe_lom_getattr(clip, "groove", MISSING) is MISSING:
            _unsupported("Live 11 does not expose clip groove assignment")
        clip.groove = assigned
        after = _clip_groove_state(context, clip)
        expected = None if assigned is None else _groove_reference(context, assigned)
        actual = None if after["groove"] is None else after["groove"]["reference"]
        if actual != expected:
            raise ProtocolFailure("conflict", "Clip groove readback did not match")
        return {"action": action, "before": before, "after": after, "verified": True}
    if action == "set-global-amount":
        before = float(_safe_lom_getattr(context.song, "groove_amount"))
        context.song.groove_amount = params["amount"]
        after = float(_safe_lom_getattr(context.song, "groove_amount"))
        if abs(after - params["amount"]) > 1e-6:
            context.song.groove_amount = before
            raise ProtocolFailure("conflict", "Global groove amount readback failed")
        return {"action": action, "before": before, "after": after, "verified": True}
    groove = _resolve_groove(context, params["target"])
    before = _groove_summary(context, params["target"]["index"], groove)
    names = {
        "quantizationAmount": "quantization_amount",
        "timingAmount": "timing_amount",
        "randomAmount": "random_amount",
        "velocityAmount": "velocity_amount",
    }
    changed = []
    try:
        for public, private in names.items():
            if public in params:
                if _safe_lom_getattr(groove, private) is None:
                    _unsupported("Live 11 does not expose groove property " + public)
                old = _safe_lom_getattr(groove, private)
                setattr(groove, private, params[public])
                changed.append((private, old))
        after = _groove_summary(context, params["target"]["index"], groove)
        for public in names:
            if public in params and abs(after[public] - params[public]) > 1e-6:
                raise ProtocolFailure("conflict", "Groove property readback failed")
    except Exception:
        for private, old in reversed(changed):
            try:
                setattr(groove, private, old)
            except Exception:
                pass
        raise
    return {
        "action": action,
        "before": before,
        "after": after,
        "poolRevision": _groove_revision(context),
        "verified": True,
    }


def _find_scene(context, index, expected_reference, expected_name):
    scenes = list(context.song.scenes)
    if index < 0 or index >= len(scenes):
        raise ProtocolFailure("not_found", "Scene no longer exists")
    scene = scenes[index]
    if (
        _scene_reference(context, scene) != expected_reference
        or (_safe_lom_getattr(scene, "name", "") or "") != expected_name
    ):
        raise ProtocolFailure("stale_reference", "Scene identity changed")
    return scene


def _find_device(context, target):
    track = _resolve_track(context, target["track"])
    devices = list(_safe_lom_getattr(track, "devices", ()) or ())
    index = target["deviceIndex"]
    if index < 0 or index >= len(devices):
        raise ProtocolFailure("not_found", "Device no longer exists")
    device = devices[index]
    if (
        _device_reference(context, device) != target["expectedDeviceReference"]
        or (_safe_lom_getattr(device, "name", "") or "") != target["expectedDeviceName"]
        or (_safe_lom_getattr(device, "class_name", "") or "")
        != target["expectedClassName"]
    ):
        raise ProtocolFailure("stale_reference", "Device identity changed")
    return track, device


def _find_chain(context, target):
    track = _resolve_track(context, target["track"])
    devices = list(_safe_lom_getattr(track, "devices", ()) or ())
    rack_index = target["rackIndex"]
    if rack_index < 0 or rack_index >= len(devices):
        raise ProtocolFailure("not_found", "Rack no longer exists")
    rack = devices[rack_index]
    if (
        _device_reference(context, rack) != target["expectedRackReference"]
        or (_safe_lom_getattr(rack, "name", "") or "") != target["expectedRackName"]
    ):
        raise ProtocolFailure("stale_reference", "Rack identity changed")
    chains = list(_safe_lom_getattr(rack, "chains", ()) or ())
    index = target["chainIndex"]
    if index < 0 or index >= len(chains):
        raise ProtocolFailure("not_found", "Chain no longer exists")
    chain = chains[index]
    if (
        _chain_reference(context, chain) != target["expectedChainReference"]
        or (_safe_lom_getattr(chain, "name", "") or "") != target["expectedChainName"]
    ):
        raise ProtocolFailure("stale_reference", "Chain identity changed")
    return track, rack, chain


def _selection_state(context):
    song = context.song
    view = _safe_lom_getattr(song, "view")
    selected_track = _safe_lom_getattr(view, "selected_track")
    selected_scene = _safe_lom_getattr(view, "selected_scene")
    highlighted_slot = _safe_lom_getattr(view, "highlighted_clip_slot")
    detail_clip = _safe_lom_getattr(view, "detail_clip")
    selected_device = _safe_lom_getattr(view, "selected_device")
    track_reference = (
        _track_reference(context, selected_track) if selected_track is not None else None
    )
    scene_reference = (
        _scene_reference(context, selected_scene) if selected_scene is not None else None
    )
    slot_state = None
    if highlighted_slot is not None:
        for track in list(song.tracks):
            for index, slot in enumerate(_safe_lom_getattr(track, "clip_slots", ()) or ()):
                if _same_lom_object(slot, highlighted_slot):
                    slot_state = {
                        "trackReference": _track_reference(context, track),
                        "sceneIndex": index,
                    }
                    break
    chain_reference = None
    for track in list(song.tracks):
        for device in _safe_lom_getattr(track, "devices", ()) or ():
            for chain in _safe_lom_getattr(device, "chains", ()) or ():
                if bool(_safe_lom_getattr(chain, "is_selected", False)):
                    chain_reference = _chain_reference(context, chain)
    return {
        "trackReference": track_reference,
        "sceneReference": scene_reference,
        "clipReference": (
            _clip_reference(context, detail_clip) if detail_clip is not None else None
        ),
        "slot": slot_state,
        "deviceReference": (
            _device_reference(context, selected_device)
            if selected_device is not None
            else None
        ),
        "chainReference": chain_reference,
    }


def _view_state(context):
    app_view = _safe_lom_getattr(context.application, "view")
    if app_view is None:
        _unsupported("Live 11 does not expose application view state")
    visible = []
    is_visible = _safe_lom_getattr(app_view, "is_view_visible")
    for name in ("Session", "Arranger", "Detail", "Browser"):
        try:
            if callable(is_visible) and bool(is_visible(name)):
                visible.append(name)
        except RuntimeError:
            pass
    focused = None
    is_focused = _safe_lom_getattr(app_view, "is_view_focused")
    if callable(is_focused):
        for name in ("Session", "Arranger", "Detail", "Browser"):
            try:
                if is_focused(name):
                    focused = name
                    break
            except RuntimeError:
                pass
    song_view = _safe_lom_getattr(context.song, "view")
    return {
        "visibleViews": visible,
        "focusedView": focused,
        "follow": (
            bool(_safe_lom_getattr(song_view, "follow_song"))
            if _safe_lom_getattr(song_view, "follow_song") is not None
            else None
        ),
        "drawMode": (
            bool(_safe_lom_getattr(app_view, "draw_mode"))
            if _safe_lom_getattr(app_view, "draw_mode") is not None
            else None
        ),
    }


def execute_selection_view(context, params):
    action = params["action"]
    if action == "inspect-selection":
        return {"action": action, "selection": _selection_state(context)}
    if action == "inspect-view":
        return {"action": action, "view": _view_state(context)}
    selection_action = action.startswith("select-")
    fold_track = None
    collapsed_view = None
    if action == "set-track-fold":
        fold_track = _resolve_track(context, params["target"])
        fold_state = _safe_lom_getattr(fold_track, "fold_state")
        if fold_state is None:
            _unsupported("Live 11 does not expose fold state for this track")
        before = bool(fold_state)
    elif action == "set-device-collapsed":
        _track, device = _find_device(context, params["target"])
        collapsed_view = _safe_lom_getattr(device, "view")
        collapsed = _safe_lom_getattr(collapsed_view, "is_collapsed")
        if collapsed_view is None or collapsed is None:
            _unsupported("Live 11 does not expose device collapse state")
        before = bool(collapsed)
    else:
        before = _selection_state(context) if selection_action else _view_state(context)
    song_view = _safe_lom_getattr(context.song, "view")
    app_view = _safe_lom_getattr(context.application, "view")
    if action == "select-track":
        song_view.selected_track = _resolve_track(context, params["target"])
    elif action == "select-scene":
        song_view.selected_scene = _find_scene(
            context,
            params["sceneIndex"],
            params["expectedSceneReference"],
            params["expectedSceneName"],
        )
    elif action == "select-slot":
        _track, slot = _resolve_session_slot(context, params["target"])
        song_view.highlighted_clip_slot = slot
    elif action == "select-clip":
        clip = _resolve_clip(context, params["target"])
        song_view.detail_clip = clip
    elif action == "select-device":
        _track, device = _find_device(context, params["target"])
        select_device = _safe_lom_getattr(song_view, "select_device")
        if callable(select_device):
            select_device(device)
        else:
            song_view.selected_device = device
    elif action == "select-chain":
        _track, _rack, chain = _find_chain(context, params["target"])
        if _safe_lom_getattr(chain, "is_selected") is None:
            _unsupported("Live 11 does not expose chain selection")
        chain.is_selected = True
    elif action == "set-view":
        method = {
            "show": "show_view",
            "hide": "hide_view",
            "focus": "focus_view",
        }[params["state"]]
        callback = _safe_lom_getattr(app_view, method)
        if not callable(callback):
            _unsupported("Live 11 does not expose requested view operation")
        callback(params["view"])
    elif action == "set-follow":
        if _safe_lom_getattr(song_view, "follow_song") is None:
            _unsupported("Live 11 does not expose follow-song state")
        song_view.follow_song = params["enabled"]
    elif action == "set-draw-mode":
        if _safe_lom_getattr(app_view, "draw_mode") is None:
            _unsupported("Live 11 does not expose draw mode")
        app_view.draw_mode = params["enabled"]
    elif action == "set-track-fold":
        fold_track.fold_state = params["folded"]
    elif action == "set-device-collapsed":
        collapsed_view.is_collapsed = params["collapsed"]
    if action == "set-track-fold":
        after = bool(_safe_lom_getattr(fold_track, "fold_state"))
        verified = after == params["folded"]
    elif action == "set-device-collapsed":
        after = bool(_safe_lom_getattr(collapsed_view, "is_collapsed"))
        verified = after == params["collapsed"]
    else:
        after = _selection_state(context) if selection_action else _view_state(context)
        if action == "select-track":
            verified = after["trackReference"] == params["target"]["expectedReference"]
        elif action == "select-scene":
            verified = after["sceneReference"] == params["expectedSceneReference"]
        elif action == "select-slot":
            verified = after["slot"] == {
                "trackReference": params["target"]["track"]["expectedReference"],
                "sceneIndex": params["target"]["sceneIndex"],
            }
        elif action == "select-clip":
            verified = (
                after["clipReference"] == params["target"]["expectedClipReference"]
            )
        elif action == "select-device":
            verified = (
                after["deviceReference"]
                == params["target"]["expectedDeviceReference"]
            )
        elif action == "select-chain":
            verified = (
                after["chainReference"]
                == params["target"]["expectedChainReference"]
            )
        elif action == "set-view":
            verified = (
                params["view"] in after["visibleViews"]
                if params["state"] == "show"
                else params["view"] not in after["visibleViews"]
                if params["state"] == "hide"
                else after["focusedView"] == params["view"]
            )
        elif action == "set-follow":
            verified = after["follow"] == params["enabled"]
        else:
            verified = after["drawMode"] == params["enabled"]
    if not verified:
        raise ProtocolFailure("conflict", "Selection or view mutation was not observed")
    return {"action": action, "before": before, "after": after, "verified": True}


def _history_state(song):
    can_undo = _safe_lom_getattr(song, "can_undo")
    can_redo = _safe_lom_getattr(song, "can_redo")
    if can_undo is None or can_redo is None:
        _unsupported("Live 11 does not expose global undo/redo state")
    return {"canUndo": bool(can_undo), "canRedo": bool(can_redo)}


def execute_history(context, params):
    action = params["action"]
    before = _history_state(context.song)
    if action == "inspect":
        return {
            "action": action,
            "state": before,
            "warnings": [GLOBAL_HISTORY_WARNING],
        }
    if params.get("confirmation") != "global-live-history":
        raise ProtocolFailure(
            "invalid_params", "Global Live history confirmation is required"
        )
    if action == "undo":
        if not before["canUndo"]:
            raise ProtocolFailure("conflict", "Live has no undo step")
        context.song.undo()
    else:
        if not before["canRedo"]:
            raise ProtocolFailure("conflict", "Live has no redo step")
        context.song.redo()
    return {
        "action": action,
        "before": before,
        "after": _history_state(context.song),
        "verified": True,
        "warnings": [GLOBAL_HISTORY_WARNING],
    }


def _browser_state(context, selection_restored):
    browser = _safe_lom_getattr(context.application, "browser")
    app_view = _safe_lom_getattr(context.application, "view")
    return {
        "previewing": (
            bool(_safe_lom_getattr(browser, "is_previewing"))
            if _safe_lom_getattr(browser, "is_previewing") is not None
            else None
        ),
        "hotswap": (
            _safe_lom_getattr(browser, "hotswap_target") is not None
            if _safe_lom_getattr(browser, "hotswap_target", MISSING) is not MISSING
            else None
        ),
        "filterType": (
            int(_safe_lom_getattr(browser, "filter_type"))
            if isinstance(_safe_lom_getattr(browser, "filter_type"), int)
            else None
        ),
        "deviceInsertMode": (
            int(_safe_lom_getattr(app_view, "device_insert_mode"))
            if isinstance(_safe_lom_getattr(app_view, "device_insert_mode"), int)
            else None
        ),
        "selectionRestored": bool(selection_restored),
    }


def _restore_selection(context, before):
    song_view = _safe_lom_getattr(context.song, "view")
    restored = True
    for attribute, value in before.items():
        if value is MISSING:
            continue
        try:
            setattr(song_view, attribute, value)
        except Exception:
            restored = False
            continue
        actual = _safe_lom_getattr(song_view, attribute, MISSING)
        if actual is MISSING:
            restored = False
        elif value is None:
            restored = restored and actual is None
        else:
            restored = restored and _same_lom_object(actual, value)
    return restored


def _restore_browser_state(browser, app_view, before):
    restored = True
    for target, attribute in (
        (browser, "hotswap_target"),
        (browser, "filter_type"),
        (app_view, "device_insert_mode"),
    ):
        value = before[attribute]
        if value is MISSING:
            continue
        try:
            setattr(target, attribute, value)
        except Exception:
            restored = False
            continue
        actual = _safe_lom_getattr(target, attribute, MISSING)
        if actual is MISSING:
            restored = False
        elif value is None:
            restored = restored and actual is None
        elif isinstance(value, (bool, int, float, str)):
            restored = restored and actual == value
        else:
            restored = restored and _same_lom_object(actual, value)
    return restored


def execute_browser_adapters(context, params):
    browser = _safe_lom_getattr(context.application, "browser")
    if browser is None:
        _unsupported("Live 11 Browser is unavailable")
    song_view = _safe_lom_getattr(context.song, "view")
    saved_selection = {
        name: _safe_lom_getattr(song_view, name, MISSING)
        for name in (
            "selected_track",
            "selected_scene",
            "highlighted_clip_slot",
            "detail_clip",
            "selected_device",
        )
    }
    app_view = _safe_lom_getattr(context.application, "view")
    saved_browser = {
        "hotswap_target": _safe_lom_getattr(browser, "hotswap_target", MISSING),
        "filter_type": _safe_lom_getattr(browser, "filter_type", MISSING),
        "device_insert_mode": _safe_lom_getattr(
            app_view, "device_insert_mode", MISSING
        ),
    }
    before = _browser_state(context, True)
    item = None
    try:
        if params["action"] != "stop-preview":
            _resolved_browser, item, _actual = _resolve_expected_item(
                context, params
            )
        if params["action"] == "preview":
            preview = _safe_lom_getattr(browser, "preview_item")
            if not callable(preview):
                _unsupported("Live 11 Browser preview is unavailable")
            preview(item)
        elif params["action"] == "stop-preview":
            stop = _safe_lom_getattr(browser, "stop_preview")
            if not callable(stop):
                _unsupported("Live 11 Browser stop-preview is unavailable")
            stop()
        elif params["action"] == "hot-swap":
            _track, device = _find_device(context, params["target"])
            if _safe_lom_getattr(browser, "hotswap_target", MISSING) is MISSING:
                _unsupported("Live 11 Browser Hot-Swap target is unavailable")
            browser.hotswap_target = device
            browser.load_item(item)
        elif params["action"] == "insert-adjacent":
            _track, device = _find_device(context, params["target"])
            mode = _safe_lom_getattr(app_view, "device_insert_mode")
            if mode is None or not callable(_safe_lom_getattr(browser, "load_item")):
                _unsupported(
                    "Adjacent Browser insertion is not supported by this Live 11 API shape"
                )
            select_device = _safe_lom_getattr(song_view, "select_device")
            if callable(select_device):
                select_device(device)
            app_view.device_insert_mode = 0 if params["placement"] == "before" else 1
            browser.load_item(item)
            app_view.device_insert_mode = mode
        elif params["action"] == "load-empty-drum-pad":
            _track, rack = _find_device(context, params["rack"])
            pads = list(_safe_lom_getattr(rack, "drum_pads", ()) or ())
            matches = [
                pad for pad in pads if _safe_lom_getattr(pad, "note") == params["note"]
            ]
            if len(matches) != 1:
                raise ProtocolFailure("not_found", "Exact Drum Rack pad was not found")
            pad = matches[0]
            if _pad_reference(context, pad) != params["expectedPadReference"]:
                raise ProtocolFailure("stale_reference", "Drum Rack pad identity changed")
            if list(_safe_lom_getattr(pad, "chains", ()) or ()):
                raise ProtocolFailure("conflict", "Drum Rack pad is not empty")
            load = _safe_lom_getattr(browser, "load_item")
            if not callable(load) or _safe_lom_getattr(song_view, "selected_device") is None:
                _unsupported(
                    "Empty Drum Rack pad loading is not supported by this Live 11 API shape"
                )
            select_device = _safe_lom_getattr(song_view, "select_device")
            if callable(select_device):
                select_device(rack)
            if _safe_lom_getattr(pad, "is_selected") is None:
                _unsupported("Live 11 does not expose Drum Rack pad selection")
            pad.is_selected = True
            load(item)
    finally:
        browser_restored = _restore_browser_state(browser, app_view, saved_browser)
        selection_restored = _restore_selection(context, saved_selection)
    restored = browser_restored and selection_restored
    after = _browser_state(context, restored)
    if not restored:
        raise ProtocolFailure(
            "conflict", "Browser or selection state restoration could not be verified"
        )
    return {
        "action": params["action"],
        "before": before,
        "after": after,
        "verified": True,
        "warnings": (
            [
                "Native Browser insertion is best-effort and verified only for the detected Live 11 API shape."
            ]
            if params["action"] in ("insert-adjacent", "load-empty-drum-pad")
            else []
        ),
    }


def _resolve_envelope(context, target):
    clip = _resolve_clip(context, target["clip"])
    if target["clip"].get("view") != "session":
        raise ProtocolFailure(
            "unsupported_capability",
            "Direct Arrangement automation is intentionally unavailable",
        )
    parameters = list(_safe_lom_getattr(clip, "available_envelope_parameters", ()) or ())
    identity = target["parameter"]
    index = identity["index"]
    if index < 0 or index >= len(parameters):
        raise ProtocolFailure("not_found", "Envelope parameter no longer exists")
    parameter = parameters[index]
    if (
        _parameter_reference(context, parameter) != identity["expectedReference"]
        or (_safe_lom_getattr(parameter, "name", "") or "")
        != identity["expectedName"]
    ):
        raise ProtocolFailure("stale_reference", "Envelope parameter identity changed")
    envelope = clip.automation_envelope(parameter)
    if envelope is None:
        raise ProtocolFailure("not_found", "Clip has no envelope for the parameter")
    return clip, parameter, envelope


def _envelope_parameter_summary(context, index, parameter):
    return {
        "index": index,
        "reference": _parameter_reference(context, parameter),
        "name": _safe_lom_getattr(parameter, "name", "") or "",
        "min": float(_safe_lom_getattr(parameter, "min", 0.0)),
        "max": float(_safe_lom_getattr(parameter, "max", 1.0)),
        "isQuantized": bool(_safe_lom_getattr(parameter, "is_quantized", False)),
    }


def execute_clip_automation(context, params):
    action = params["action"]
    if action == "list-envelopes":
        clip = _resolve_clip(context, params["target"])
        if params["target"].get("view") != "session":
            _unsupported("Direct Arrangement automation is intentionally unavailable")
        parameters = list(
            _safe_lom_getattr(clip, "available_envelope_parameters", ()) or ()
        )
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        return {
            "action": action,
            "parameters": [
                _envelope_parameter_summary(context, index, parameter)
                for index, parameter in enumerate(
                    parameters[offset : offset + limit], offset
                )
            ],
            "total": len(parameters),
            "offset": offset,
            "limit": limit,
        }
    if action == "clear-all":
        clip = _resolve_clip(context, params["target"])
        if params.get("confirmation") != "clear-all-session-clip-envelopes":
            raise ProtocolFailure("invalid_params", "Clear-all confirmation is required")
        clear = _safe_lom_getattr(clip, "clear_all_envelopes")
        if not callable(clear):
            _unsupported("Live 11 does not expose clear-all clip envelopes")
        clear()
        return {"action": action, "cleared": True, "verified": True}
    clip, parameter, envelope = _resolve_envelope(context, params["target"])
    value_at_time = _safe_lom_getattr(envelope, "value_at_time")
    if not callable(value_at_time):
        _unsupported("Live 11 does not expose clip envelope sampling")
    if action == "sample":
        count = params["sampleCount"]
        start, end = params["startTime"], params["endTime"]
        samples = []
        for index in range(count):
            time = start if count == 1 else start + (end - start) * index / (count - 1)
            samples.append({"time": time, "value": float(value_at_time(time))})
        return {"action": action, "samples": samples}
    if action == "insert-step":
        minimum = float(_safe_lom_getattr(parameter, "min", 0.0))
        maximum = float(_safe_lom_getattr(parameter, "max", 1.0))
        if params["value"] < minimum or params["value"] > maximum:
            raise ProtocolFailure("invalid_params", "Envelope value is out of range")
        before = float(value_at_time(params["time"]))
        insert = _safe_lom_getattr(envelope, "insert_step")
        if not callable(insert):
            _unsupported("Live 11 does not expose clip envelope step insertion")
        insert(params["time"], params["duration"], params["value"])
        after = float(value_at_time(params["time"]))
        if abs(after - params["value"]) > 1e-5:
            raise ProtocolFailure("conflict", "Envelope step readback failed")
        return {
            "action": action,
            "beforeValue": before,
            "afterValue": after,
            "verified": True,
        }
    if params.get("confirmation") != "clear-session-clip-envelope":
        raise ProtocolFailure("invalid_params", "Envelope clear confirmation is required")
    clear = _safe_lom_getattr(clip, "clear_envelope")
    if not callable(clear):
        _unsupported("Live 11 does not expose clip envelope clearing")
    clear(parameter)
    return {"action": action, "cleared": True, "verified": True}


def _warp_markers(clip):
    markers = list(_safe_lom_getattr(clip, "warp_markers", ()) or ())
    result = []
    for index, marker in enumerate(markers):
        beat_time = float(_safe_lom_getattr(marker, "beat_time"))
        sample_time = float(_safe_lom_getattr(marker, "sample_time"))
        segment_bpm = _safe_lom_getattr(marker, "segment_bpm")
        result.append(
            {
                "beatTime": beat_time,
                "sampleTime": sample_time,
                "segmentBpm": (
                    float(segment_bpm) if _finite(segment_bpm) and segment_bpm > 0 else None
                ),
                "_object": marker,
                "_index": index,
            }
        )
    return result


def _warp_snapshot(context, clip):
    public = [
        {key: value for key, value in marker.items() if not key.startswith("_")}
        for marker in _warp_markers(clip)
    ]
    revision = hashlib.sha256(
        json.dumps(public, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        "clipReference": _clip_reference(context, clip),
        "revision": revision,
        "markers": public,
    }


def _same_marker(left, right):
    return (
        abs(left["beatTime"] - right["beatTime"]) <= 1e-7
        and abs(left["sampleTime"] - right["sampleTime"]) <= 1e-4
    )


def _validate_warp_order(markers):
    for index, marker in enumerate(markers):
        if index and (
            marker["beatTime"] <= markers[index - 1]["beatTime"]
            or marker["sampleTime"] <= markers[index - 1]["sampleTime"]
        ):
            raise ProtocolFailure(
                "invalid_params",
                "Warp markers must remain strictly ordered in beat and sample time",
            )
        if marker["segmentBpm"] is not None and (
            marker["segmentBpm"] <= 0 or marker["segmentBpm"] > 999
        ):
            raise ProtocolFailure("invalid_params", "Warp segment BPM is invalid")


def execute_warp_markers(context, params):
    action = params["action"]
    clip = _resolve_clip(context, params["target"])
    if bool(_safe_lom_getattr(clip, "is_midi_clip", False)):
        raise ProtocolFailure("conflict", "Warp markers require an audio clip")
    before = _warp_snapshot(context, clip)
    if action == "inspect":
        offset, limit = params.get("offset", 0), params.get("limit", 64)
        snapshot = dict(before)
        snapshot["markers"] = before["markers"][offset : offset + limit]
        return {
            "action": action,
            "snapshot": snapshot,
            "total": len(before["markers"]),
            "offset": offset,
            "limit": limit,
        }
    if params["snapshotRevision"] != before["revision"]:
        raise ProtocolFailure("stale_reference", "Warp marker snapshot changed")
    proposed = list(before["markers"])
    if action == "add":
        if any(_same_marker(marker, params["marker"]) for marker in proposed):
            raise ProtocolFailure("conflict", "Warp marker already exists")
        proposed.append(
            {
                "beatTime": params["marker"]["beatTime"],
                "sampleTime": params["marker"]["sampleTime"],
                "segmentBpm": None,
            }
        )
    else:
        matches = [
            index
            for index, marker in enumerate(proposed)
            if _same_marker(marker, params["expectedMarker"])
        ]
        if len(matches) != 1:
            raise ProtocolFailure("stale_reference", "Exact warp marker changed")
        index = matches[0]
        if action == "move":
            proposed[index] = {
                "beatTime": params["marker"]["beatTime"],
                "sampleTime": params["marker"]["sampleTime"],
                "segmentBpm": None,
            }
        else:
            proposed.pop(index)
    proposed.sort(key=lambda marker: marker["beatTime"])
    _validate_warp_order(proposed)
    add = _safe_lom_getattr(clip, "add_warp_marker")
    remove = _safe_lom_getattr(clip, "remove_warp_marker")
    if not callable(add) or not callable(remove):
        _unsupported("Live 11 does not expose tested warp-marker mutation")
    rolled_back = False
    try:
        if action == "add":
            add(params["marker"]["beatTime"])
        else:
            remove(params["expectedMarker"]["beatTime"])
            if action == "move":
                add(params["marker"]["beatTime"])
        after = _warp_snapshot(context, clip)
        if not all(
            any(_same_marker(actual, expected) for actual in after["markers"])
            for expected in proposed
        ):
            raise ProtocolFailure("conflict", "Warp marker mutation readback failed")
    except Exception:
        try:
            current = _warp_snapshot(context, clip)["markers"]
            for marker in current:
                if not any(_same_marker(marker, original) for original in before["markers"]):
                    remove(marker["beatTime"])
            for marker in before["markers"]:
                if not any(_same_marker(marker, current_marker) for current_marker in current):
                    add(marker["beatTime"])
            rolled_back = True
        except Exception:
            pass
        raise
    return {
        "action": action,
        "before": before,
        "after": after,
        "verified": True,
        "rolledBack": rolled_back,
    }


def _device_parameters(device):
    return {
        (_safe_lom_getattr(parameter, "name", "") or "").lower(): parameter
        for parameter in (_safe_lom_getattr(device, "parameters", ()) or ())
    }


def _parameter_state(device):
    result = {}
    for name, parameter in _device_parameters(device).items():
        value = _safe_lom_getattr(parameter, "value")
        if _finite(value):
            result[name[:128]] = float(value)
    return result


def _simpler_state(device):
    sample = _safe_lom_getattr(device, "sample")
    if sample is None:
        _unsupported("Simpler has no loaded sample")
    state = {}
    for public, private in (
        ("start", "start_marker"),
        ("end", "end_marker"),
        ("loopStart", "loop_start"),
        ("loopEnd", "loop_end"),
    ):
        value = _safe_lom_getattr(sample, private)
        if _finite(value):
            state[public] = float(value)
    slices = _safe_lom_getattr(sample, "slices")
    if slices is not None:
        state["slices"] = [float(value) for value in list(slices)[:128]]
    return state


def _ensure_class(device, class_names, label):
    class_name = _safe_lom_getattr(device, "class_name", "") or ""
    if class_name not in class_names:
        raise ProtocolFailure("conflict", "Exact target is not a {0}".format(label))


def execute_special_devices(context, params):
    action = params["action"]
    _track, device = _find_device(context, params["target"])
    if "simpler" in action:
        _ensure_class(device, ("OriginalSimpler", "Simpler"), "Simpler")
        before = _simpler_state(device)
        if action == "inspect-simpler":
            return {"action": action, "state": before}
        sample = _safe_lom_getattr(device, "sample")
        if action == "set-simpler-markers":
            changes = {
                "start_marker": params["start"],
                "end_marker": params["end"],
            }
            if "loopStart" in params:
                changes["loop_start"] = params["loopStart"]
            if "loopEnd" in params:
                changes["loop_end"] = params["loopEnd"]
            old = {name: _safe_lom_getattr(sample, name) for name in changes}
            try:
                for name, value in changes.items():
                    setattr(sample, name, value)
                after = _simpler_state(device)
            except Exception:
                for name, value in old.items():
                    try:
                        setattr(sample, name, value)
                    except Exception:
                        pass
                raise
        else:
            slices = _safe_lom_getattr(sample, "slices")
            if slices is None:
                _unsupported("Live 11 does not expose Simpler slice editing")
            old = list(slices)
            try:
                sample.slices = list(params["slices"])
                after = _simpler_state(device)
            except Exception:
                try:
                    sample.slices = old
                except Exception:
                    pass
                raise
        return {"action": action, "before": before, "after": after, "verified": True}
    if "looper" in action:
        _ensure_class(device, ("Looper",), "Looper")
        before = _parameter_state(device)
        if action == "inspect-looper":
            return {"action": action, "state": before}
        if action == "export-looper":
            _resolve_session_slot(context, params["destination"], require_empty=True)
            _validate_job_track_context(
                params["runtimeContext"],
                [
                    params["target"]["track"]["expectedReference"],
                    params["destination"]["track"]["expectedReference"],
                ],
            )
            export = _safe_lom_getattr(device, "export_to_clip")
            if not callable(export):
                _unsupported(
                    "Live 11 does not expose tested Looper export-to-clip"
                )
            manager = _job_manager(context)
            cancellation = {"requested": False}

            def cancel_export():
                cancellation["requested"] = True

            job = manager.create(
                "looper-export",
                params["runtimeContext"],
                cancel_callback=cancel_export,
            )
            manager.update(job["jobId"], "started", 0.0)

            def perform():
                current = manager.get(job["jobId"])
                if cancellation["requested"] or current["status"] == "cancelled":
                    return
                try:
                    _track, slot = _resolve_session_slot(
                        context, params["destination"], require_empty=True
                    )
                    export(slot)
                    if not bool(_safe_lom_getattr(slot, "has_clip", False)):
                        raise ProtocolFailure(
                            "conflict", "Looper export did not create a clip"
                        )
                    clip = _safe_lom_getattr(slot, "clip")
                    manager.update(
                        job["jobId"],
                        "completed",
                        1.0,
                        result={"clipReference": _clip_reference(context, clip)},
                    )
                except Exception as exc:
                    manager.update(
                        job["jobId"],
                        "failed",
                        1.0,
                        error={"code": "lom_error", "message": str(exc)},
                    )

            context.schedule_message(0, perform)
            return {"action": action, "job": manager.get(job["jobId"])}
        parameters = _device_parameters(device)
        parameter = parameters.get(params["command"])
        if parameter is None:
            _unsupported(
                "Live 11 Looper does not expose tested control '{0}'".format(
                    params["command"]
                )
            )
        minimum = float(_safe_lom_getattr(parameter, "min", 0.0))
        maximum = float(_safe_lom_getattr(parameter, "max", 1.0))
        parameter.value = maximum if params["command"] != "stop" else minimum
        return {
            "action": action,
            "before": before,
            "after": _parameter_state(device),
            "verified": True,
        }
    _ensure_class(device, ("InstrumentVector", "Wavetable"), "Wavetable")
    matrix = _safe_lom_getattr(device, "modulation_matrix")
    if matrix is None:
        _unsupported(
            "This Live 11 Wavetable does not expose the tested modulation API"
        )
    state = {"matrixAvailable": True}
    if action == "inspect-wavetable":
        return {"action": action, "state": state}
    get_amount = _safe_lom_getattr(matrix, "get_modulation_value")
    set_amount = _safe_lom_getattr(matrix, "set_modulation_value")
    if not callable(get_amount) or not callable(set_amount):
        _unsupported("Live 11 Wavetable modulation mutation is unavailable")
    before_amount = float(
        get_amount(params["sourceIndex"], params["targetIndex"])
    )
    before = {
        "sourceIndex": params["sourceIndex"],
        "targetIndex": params["targetIndex"],
        "amount": before_amount,
    }
    set_amount(params["sourceIndex"], params["targetIndex"], params["amount"])
    after = dict(before)
    after["amount"] = float(
        get_amount(params["sourceIndex"], params["targetIndex"])
    )
    if abs(after["amount"] - params["amount"]) > 1e-5:
        set_amount(params["sourceIndex"], params["targetIndex"], before_amount)
        raise ProtocolFailure("conflict", "Wavetable modulation readback failed")
    return {"action": action, "before": before, "after": after, "verified": True}


def execute_jobs(context, params):
    manager = _job_manager(context)
    action = params["action"]
    if action == "get":
        return {"action": action, "job": manager.get(params["jobId"])}
    if action == "cancel":
        job, cancelled = manager.cancel(
            params["jobId"], params["runtimeContext"]["ownerId"]
        )
        return {"action": action, "job": job, "cancelled": cancelled}
    jobs = manager.list()
    offset, limit = params.get("offset", 0), params.get("limit", 64)
    return {
        "action": action,
        "jobs": jobs[offset : offset + limit],
        "total": len(jobs),
        "offset": offset,
        "limit": limit,
    }


def register_workflow_adapter_commands(registry):
    registrations = (
        ("recording.inspect", execute_recording, validate_recording, "inspect", False, False),
        ("recording.set_arrangement_record", execute_recording, validate_recording, "set-arrangement-record", True, False),
        ("recording.set_session_record", execute_recording, validate_recording, "set-session-record", True, False),
        ("recording.set_overdub", execute_recording, validate_recording, "set-overdub", True, False),
        ("recording.set_session_automation_record", execute_recording, validate_recording, "set-session-automation-record", True, False),
        ("recording.set_punch", execute_recording, validate_recording, "set-punch", True, False),
        ("recording.capture_midi", execute_recording, validate_recording, "capture-midi", True, False),
        ("recording.record_session_slot", execute_recording, validate_recording, "record-session-slot", True, True),
        ("grooves.list", execute_grooves, validate_grooves, "list", False, False),
        ("grooves.get", execute_grooves, validate_grooves, "get", False, False),
        ("grooves.inspect_clip", execute_grooves, validate_grooves, "inspect-clip", False, False),
        ("grooves.set_clip_groove", execute_grooves, validate_grooves, "set-clip-groove", True, False),
        ("grooves.clear_clip_groove", execute_grooves, validate_grooves, "clear-clip-groove", True, False),
        ("grooves.set_properties", execute_grooves, validate_grooves, "set-properties", True, False),
        ("grooves.set_global_amount", execute_grooves, validate_grooves, "set-global-amount", True, False),
        ("selection_view.inspect_selection", execute_selection_view, validate_selection_view, "inspect-selection", False, False),
        ("selection_view.inspect_view", execute_selection_view, validate_selection_view, "inspect-view", False, False),
        ("selection_view.select_track", execute_selection_view, validate_selection_view, "select-track", True, False),
        ("selection_view.select_scene", execute_selection_view, validate_selection_view, "select-scene", True, False),
        ("selection_view.select_slot", execute_selection_view, validate_selection_view, "select-slot", True, False),
        ("selection_view.select_clip", execute_selection_view, validate_selection_view, "select-clip", True, False),
        ("selection_view.select_device", execute_selection_view, validate_selection_view, "select-device", True, False),
        ("selection_view.select_chain", execute_selection_view, validate_selection_view, "select-chain", True, False),
        ("selection_view.set_view", execute_selection_view, validate_selection_view, "set-view", True, False),
        ("selection_view.set_follow", execute_selection_view, validate_selection_view, "set-follow", True, False),
        ("selection_view.set_draw_mode", execute_selection_view, validate_selection_view, "set-draw-mode", True, False),
        ("selection_view.set_track_fold", execute_selection_view, validate_selection_view, "set-track-fold", True, False),
        ("selection_view.set_device_collapsed", execute_selection_view, validate_selection_view, "set-device-collapsed", True, False),
        ("live_history.inspect", execute_history, validate_history, "inspect", False, False),
        ("live_history.undo", execute_history, validate_history, "undo", True, False),
        ("live_history.redo", execute_history, validate_history, "redo", True, False),
        ("browser_adapters.preview", execute_browser_adapters, validate_browser_adapters, "preview", True, False),
        ("browser_adapters.stop_preview", execute_browser_adapters, validate_browser_adapters, "stop-preview", True, False),
        ("browser_adapters.hot_swap", execute_browser_adapters, validate_browser_adapters, "hot-swap", True, True),
        ("browser_adapters.insert_adjacent", execute_browser_adapters, validate_browser_adapters, "insert-adjacent", True, True),
        ("browser_adapters.load_empty_drum_pad", execute_browser_adapters, validate_browser_adapters, "load-empty-drum-pad", True, True),
        ("clip_automation.list_envelopes", execute_clip_automation, validate_clip_automation, "list-envelopes", False, False),
        ("clip_automation.sample", execute_clip_automation, validate_clip_automation, "sample", False, False),
        ("clip_automation.insert_step", execute_clip_automation, validate_clip_automation, "insert-step", True, False),
        ("clip_automation.clear_envelope", execute_clip_automation, validate_clip_automation, "clear-envelope", True, False),
        ("clip_automation.clear_all", execute_clip_automation, validate_clip_automation, "clear-all", True, False),
        ("warp_markers.inspect", execute_warp_markers, validate_warp_markers, "inspect", False, False),
        ("warp_markers.add", execute_warp_markers, validate_warp_markers, "add", True, False),
        ("warp_markers.move", execute_warp_markers, validate_warp_markers, "move", True, False),
        ("warp_markers.remove", execute_warp_markers, validate_warp_markers, "remove", True, False),
        ("special_devices.inspect_simpler", execute_special_devices, validate_special_devices, "inspect-simpler", False, False),
        ("special_devices.set_simpler_markers", execute_special_devices, validate_special_devices, "set-simpler-markers", True, False),
        ("special_devices.set_simpler_slices", execute_special_devices, validate_special_devices, "set-simpler-slices", True, False),
        ("special_devices.inspect_looper", execute_special_devices, validate_special_devices, "inspect-looper", False, False),
        ("special_devices.control_looper", execute_special_devices, validate_special_devices, "control-looper", True, False),
        ("special_devices.export_looper", execute_special_devices, validate_special_devices, "export-looper", True, True),
        ("special_devices.inspect_wavetable", execute_special_devices, validate_special_devices, "inspect-wavetable", False, False),
        ("special_devices.set_wavetable_modulation", execute_special_devices, validate_special_devices, "set-wavetable-modulation", True, False),
        ("workflow_jobs.get", execute_jobs, validate_jobs, "get", False, False),
        ("workflow_jobs.list", execute_jobs, validate_jobs, "list", False, False),
        ("workflow_jobs.cancel", execute_jobs, validate_jobs, "cancel", True, False),
    )
    for command, handler, validator, action, mutates, long_running in registrations:
        registry.register(
            command,
            handler,
            mutates=mutates,
            timeout_class="long" if long_running else "normal",
            validator=_route_validator(validator, (action,)),
        )
