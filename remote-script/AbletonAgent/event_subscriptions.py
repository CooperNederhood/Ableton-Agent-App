"""Dynamic, identity-bound Live Object Model event subscriptions."""

from __future__ import absolute_import, unicode_literals

import datetime
import math
import re
import uuid

from .device_commands import (
    _device_reference,
    _normalized_value,
    _parameter_bounds,
    _parameter_reference,
    _resolve_device,
    _resolve_parameter,
)
from .errors import ProtocolFailure
from .identity import build_live_identity
from .system_commands import _resolve_track, _same_lom_object, _track_reference

try:
    STRING_TYPES = (basestring,)
except NameError:
    STRING_TYPES = (str,)

PARAMETER_COALESCE_TICKS = 2
PARAMETER_MINIMUM_NORMALIZED_DELTA = 0.001
MAX_DYNAMIC_SUBSCRIPTIONS = 256

PARAMETER_VALUE_CHANGED = "parameter.value_changed"
TRACK_PLAYING_CLIP_CHANGED = "track.playing_clip_changed"
TRACK_TRIGGERED_CLIP_CHANGED = "track.triggered_clip_changed"
TRACK_RECORDING_STATE_CHANGED = "track.recording_state_changed"
SUPPORTED_EVENT_KINDS = (
    PARAMETER_VALUE_CHANGED,
    TRACK_PLAYING_CLIP_CHANGED,
    TRACK_TRIGGERED_CLIP_CHANGED,
    TRACK_RECORDING_STATE_CHANGED,
)

_EVENT_ID = re.compile(
    r"^live-event\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _safe_getattr(value, name, default=None):
    try:
        return getattr(value, name)
    except (AttributeError, RuntimeError):
        return default


def _now():
    return datetime.datetime.utcnow().isoformat() + "Z"


def _track_color(track):
    color = _safe_getattr(track, "color")
    if isinstance(color, int) and not isinstance(color, bool) and color >= 0:
        return "#{0:06X}".format(color & 0xFFFFFF)
    if isinstance(color, STRING_TYPES) and color:
        return color[:64]
    return None


def _track_metadata(track):
    result = {"name": (_safe_getattr(track, "name", "") or "")[:128]}
    color = _track_color(track)
    if color is not None:
        result["color"] = color
    return result


def _clip_name(track, slot_index):
    slots = _safe_getattr(track, "clip_slots", ()) or ()
    if slot_index < 0 or slot_index >= len(slots):
        return None
    slot = slots[slot_index]
    if not bool(_safe_getattr(slot, "has_clip", False)):
        return None
    name = _safe_getattr(_safe_getattr(slot, "clip"), "name", "") or ""
    return name[:128] if name else None


def playing_clip_state(track):
    index = _safe_getattr(track, "playing_slot_index", -1)
    if index == -2:
        return {"state": "arrangement"}
    if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
        state = {"state": "session-clip", "slotIndex": index}
        name = _clip_name(track, index)
        if name:
            state["clipName"] = name
        return state
    return {"state": "stopped"}


def triggered_clip_state(track):
    index = _safe_getattr(track, "fired_slot_index", -1)
    if index == -2:
        return {"state": "stop"}
    if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
        state = {"state": "session-clip", "slotIndex": index}
        name = _clip_name(track, index)
        if name:
            state["clipName"] = name
        return state
    return {"state": "none"}


def recording_state(song, track):
    index = _safe_getattr(track, "playing_slot_index", -1)
    if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
        slots = _safe_getattr(track, "clip_slots", ()) or ()
        clip = (
            _safe_getattr(slots[index], "clip")
            if index < len(slots)
            else None
        )
        return {
            "recording": bool(_safe_getattr(clip, "is_recording", False)),
            "source": "session-clip",
        }
    if index == -2:
        return {
            "recording": bool(
                _safe_getattr(song, "record_mode", False)
                and _safe_getattr(track, "arm", False)
            ),
            "source": "arrangement",
        }
    return {"recording": False, "source": "track"}


def parameter_value_state(parameter):
    minimum, maximum, value = _parameter_bounds(parameter)
    display = None
    formatter = _safe_getattr(parameter, "str_for_value")
    if callable(formatter):
        try:
            display = formatter(value)
        except Exception:
            display = None
    if display is None and bool(_safe_getattr(parameter, "is_quantized", False)):
        try:
            items = parameter.value_items
            item_index = int(round(value - minimum))
            if 0 <= item_index < len(items):
                display = items[item_index]
        except Exception:
            display = None
    if display is None:
        display = "{0:.6g}".format(value)
    return {
        "normalizedValue": _normalized_value(minimum, maximum, value),
        "value": value,
        "displayValue": str(display)[:256],
    }


def _summary(kind, current):
    if kind == PARAMETER_VALUE_CHANGED:
        return "Parameter changed to {0}".format(current["displayValue"])
    if kind == TRACK_PLAYING_CLIP_CHANGED:
        return "Track playback changed to {0}".format(current["state"])
    if kind == TRACK_TRIGGERED_CLIP_CHANGED:
        return "Track trigger changed to {0}".format(current["state"])
    return "Track recording {0}".format(
        "started" if current["recording"] else "stopped"
    )


class _Subscription(object):
    def __init__(
        self,
        event_id,
        kind,
        track,
        target,
        state,
        device=None,
        parameter=None,
        observation_policy=None,
    ):
        self.event_id = event_id
        self.kind = kind
        self.track = track
        self.device = device
        self.parameter = parameter
        self.target = target
        self.state = state
        self.registrations = []
        self.flush_scheduled = False
        self.pending_state = None
        policy = observation_policy or {}
        self.minimum_delta = max(
            PARAMETER_MINIMUM_NORMALIZED_DELTA,
            float(policy.get(
                "minimumNormalizedDelta",
                PARAMETER_MINIMUM_NORMALIZED_DELTA,
            )),
        )
        throttle_ms = int(policy.get("throttleMs", 0))
        self.coalesce_ticks = max(
            PARAMETER_COALESCE_TICKS,
            int(math.ceil(throttle_ms / 100.0)),
        )


class LomSubscriptionManager(object):
    def __init__(self, context, publish_event, logger=None):
        self._context = context
        self._publish_event = publish_event
        self._logger = logger or (lambda _message: None)
        self._subscriptions = {}
        self._sequence = 0
        self._collection_registration = None

    def inspect_selection(self):
        view = _safe_getattr(self._context.song, "view")
        track = _safe_getattr(view, "selected_track")
        tracks = list(_safe_getattr(self._context.song, "tracks", ()) or ())
        if track is None or bool(_safe_getattr(track, "is_foldable", False)):
            return {"track": None, "parameter": None}
        index = next(
            (
                candidate_index
                for candidate_index, candidate in enumerate(tracks)
                if _same_lom_object(candidate, track)
            ),
            None,
        )
        if index is None:
            return {"track": None, "parameter": None}
        track_target = {
            "index": index,
            "expectedReference": _track_reference(self._context, track),
            "expectedName": _safe_getattr(track, "name", "") or "",
        }
        selected_parameter = _safe_getattr(view, "selected_parameter")
        parameter_target = None
        for device_index, device in enumerate(
            _safe_getattr(track, "devices", ()) or ()
        ):
            for parameter_index, parameter in enumerate(
                _safe_getattr(device, "parameters", ()) or ()
            ):
                if _same_lom_object(parameter, selected_parameter):
                    parameter_target = dict(track_target)
                    parameter_target.update({
                        "deviceIndex": device_index,
                        "expectedDeviceReference": _device_reference(
                            self._context, device
                        ),
                        "expectedDeviceName": (
                            _safe_getattr(device, "name", "") or ""
                        ),
                        "parameterIndex": parameter_index,
                        "expectedParameterReference": _parameter_reference(
                            self._context, parameter
                        ),
                        "expectedParameterName": (
                            _safe_getattr(parameter, "name", "") or ""
                        ),
                    })
                    break
            if parameter_target is not None:
                break
        return {"track": track_target, "parameter": parameter_target}

    def subscribe(self, params):
        event_id = params["eventId"]
        if event_id in self._subscriptions:
            raise ProtocolFailure(
                "conflict", "Event ID is already subscribed"
            )
        if len(self._subscriptions) >= MAX_DYNAMIC_SUBSCRIPTIONS:
            raise ProtocolFailure(
                "conflict", "Dynamic subscription limit reached"
            )
        live_set_id = build_live_identity(self._context.song)["liveSetId"]
        if params["liveSetId"] != live_set_id:
            raise ProtocolFailure(
                "stale_reference", "Live Set identity changed before subscribe"
            )
        kind = params["kind"]
        track = _resolve_track(self._context, params)
        parameter = None
        device = None
        if kind == PARAMETER_VALUE_CHANGED:
            _track, device, _devices = _resolve_device(self._context, params)
            parameter, _parameters = _resolve_parameter(
                self._context, device, params
            )
        target = self._resolved_target(track, device, parameter)
        state = self._read_state(kind, track, parameter)
        subscription = _Subscription(
            event_id,
            kind,
            track,
            target,
            state,
            device=device,
            parameter=parameter,
            observation_policy=params.get("observationPolicy"),
        )
        try:
            self._install(subscription)
        except Exception:
            self._remove_registrations(subscription)
            raise
        self._subscriptions[event_id] = subscription
        self._ensure_collection_listener()
        return self._descriptor(subscription, include_initial=True)

    def unsubscribe(self, event_id):
        subscription = self._subscriptions.pop(event_id, None)
        if subscription is None:
            raise ProtocolFailure("not_found", "Subscription was not found")
        self._remove_registrations(subscription)
        self._remove_collection_listener_if_unused()
        return {"eventId": event_id, "unsubscribed": True}

    def list_subscriptions(self):
        return {
            "subscriptions": [
                self._descriptor(self._subscriptions[event_id])
                for event_id in sorted(self._subscriptions)
            ]
        }

    def clear(self, publish_invalidation=False, reason="subscription-cleared"):
        event_ids = sorted(self._subscriptions)
        subscriptions = list(self._subscriptions.values())
        self._subscriptions = {}
        for subscription in subscriptions:
            self._remove_registrations(subscription)
            if publish_invalidation:
                self._invalidate(subscription, reason)
        self._remove_collection_listener_if_unused()
        return {"clearedEventIds": event_ids}

    def stop(self):
        self.clear()

    def _read_state(self, kind, track, parameter):
        if kind == PARAMETER_VALUE_CHANGED:
            return parameter_value_state(parameter)
        if kind == TRACK_PLAYING_CLIP_CHANGED:
            return playing_clip_state(track)
        if kind == TRACK_TRIGGERED_CLIP_CHANGED:
            return triggered_clip_state(track)
        return recording_state(self._context.song, track)

    def _resolved_target(self, track, device=None, parameter=None):
        target = {
            "trackReference": _track_reference(self._context, track),
            "track": _track_metadata(track),
        }
        if device is not None:
            target["deviceReference"] = _device_reference(
                self._context, device
            )
        if parameter is not None:
            target["parameterReference"] = _parameter_reference(
                self._context, parameter
            )
        return target

    def _descriptor(self, subscription, include_initial=False):
        resolution = {
            "status": "resolved",
            "liveSetId": build_live_identity(
                self._context.song
            )["liveSetId"],
        }
        resolution.update(subscription.target)
        result = {
            "eventId": subscription.event_id,
            "kind": subscription.kind,
            "target": subscription.target,
            "state": subscription.state,
            "resolution": resolution,
        }
        if include_initial:
            result["initialState"] = {
                "kind": subscription.kind,
                "state": subscription.state,
            }
        return result

    def _register(self, subscription, target, property_name, callback):
        add = _safe_getattr(
            target, "add_{0}_listener".format(property_name)
        )
        if not callable(add):
            return False
        try:
            add(callback)
            subscription.registrations.append(
                (target, property_name, callback)
            )
            return True
        except Exception as exc:
            self._logger(
                "Failed to add dynamic {0} listener: {1}".format(
                    property_name, exc
                )
            )
            return False

    def _install(self, subscription):
        if subscription.kind == PARAMETER_VALUE_CHANGED:
            if not self._register(
                subscription,
                subscription.parameter,
                "value",
                lambda: self._on_parameter(subscription),
            ):
                raise ProtocolFailure(
                    "unsupported_capability",
                    "Parameter value listeners are unavailable",
                )
            self._register(
                subscription,
                subscription.track,
                "devices",
                lambda: self._revalidate_subscription(subscription),
            )
            self._register(
                subscription,
                subscription.device,
                "parameters",
                lambda: self._revalidate_subscription(subscription),
            )
            return
        property_name = (
            "playing_slot_index"
            if subscription.kind in (
                TRACK_PLAYING_CLIP_CHANGED,
                TRACK_RECORDING_STATE_CHANGED,
            )
            else "fired_slot_index"
        )
        if not self._register(
            subscription,
            subscription.track,
            property_name,
            lambda: self._on_discrete(subscription),
        ):
            raise ProtocolFailure(
                "unsupported_capability",
                "Required track listener is unavailable",
            )
        if subscription.kind == TRACK_RECORDING_STATE_CHANGED:
            self._install_recording_fallbacks(subscription)

    def _install_recording_fallbacks(self, subscription):
        track = subscription.track
        index = _safe_getattr(track, "playing_slot_index", -1)
        slots = _safe_getattr(track, "clip_slots", ()) or ()
        if isinstance(index, int) and index >= 0 and index < len(slots):
            clip = _safe_getattr(slots[index], "clip")
            if clip is not None:
                self._register(
                    subscription,
                    clip,
                    "is_recording",
                    lambda: self._on_discrete(subscription),
                )
        self._register(
            subscription,
            track,
            "arm",
            lambda: self._on_discrete(subscription),
        )
        self._register(
            subscription,
            self._context.song,
            "record_mode",
            lambda: self._on_discrete(subscription),
        )

    def _on_parameter(self, subscription):
        if subscription.event_id not in self._subscriptions:
            return
        try:
            pending = parameter_value_state(subscription.parameter)
        except Exception:
            self._drop_invalid(subscription, "target-deleted")
            return
        subscription.pending_state = pending
        if subscription.flush_scheduled:
            return
        subscription.flush_scheduled = True
        self._context.schedule_message(
            subscription.coalesce_ticks,
            lambda: self._flush_parameter(subscription),
        )

    def _flush_parameter(self, subscription):
        subscription.flush_scheduled = False
        current = subscription.pending_state
        subscription.pending_state = None
        if (
            current is None
            or subscription.event_id not in self._subscriptions
        ):
            return
        if (
            abs(
                current["normalizedValue"]
                - subscription.state["normalizedValue"]
            )
            < subscription.minimum_delta
        ):
            return
        self._publish_occurrence(subscription, current)

    def _on_discrete(self, subscription):
        if subscription.event_id not in self._subscriptions:
            return
        if subscription.kind == TRACK_RECORDING_STATE_CHANGED:
            self._remove_registrations(subscription)
            try:
                self._install(subscription)
            except ProtocolFailure:
                self._drop_invalid(subscription, "target-deleted")
                return
        try:
            current = self._read_state(
                subscription.kind,
                subscription.track,
                subscription.parameter,
            )
        except Exception:
            self._drop_invalid(subscription, "target-deleted")
            return
        if current != subscription.state:
            self._publish_occurrence(subscription, current)

    def _publish_occurrence(self, subscription, current):
        previous = subscription.state
        subscription.state = current
        payload = {
            "occurrenceId": str(uuid.uuid4()),
            "eventId": subscription.event_id,
            "kind": subscription.kind,
            "sequence": self._sequence,
            "projectRevision": self._context.project_revision,
            "observedAt": _now(),
            "target": subscription.target,
            "previous": previous,
            "current": current,
            "summary": _summary(subscription.kind, current),
        }
        self._sequence += 1
        self._publish_event(
            "live_event.occurred",
            payload,
            self._context.project_revision,
        )

    def _invalidate(self, subscription, reason):
        self._publish_event(
            "live_event.invalidated",
            {
                "eventId": subscription.event_id,
                "observedAt": _now(),
                "projectRevision": self._context.project_revision,
                "reason": reason,
            },
            self._context.project_revision,
        )

    def _drop_invalid(self, subscription, reason):
        if self._subscriptions.pop(subscription.event_id, None) is None:
            return
        self._remove_registrations(subscription)
        self._invalidate(subscription, reason)
        self._remove_collection_listener_if_unused()

    def _remove_registrations(self, subscription):
        registrations = list(reversed(subscription.registrations))
        subscription.registrations = []
        for target, property_name, callback in registrations:
            remove = _safe_getattr(
                target, "remove_{0}_listener".format(property_name)
            )
            if not callable(remove):
                continue
            try:
                remove(callback)
            except Exception as exc:
                self._logger(
                    "Failed to remove dynamic {0} listener: {1}".format(
                        property_name, exc
                    )
                )

    def _ensure_collection_listener(self):
        if self._collection_registration is not None:
            return
        add = _safe_getattr(self._context.song, "add_tracks_listener")
        if not callable(add):
            return
        callback = self._revalidate
        try:
            add(callback)
            self._collection_registration = callback
        except Exception:
            self._collection_registration = None

    def _remove_collection_listener_if_unused(self):
        if self._subscriptions or self._collection_registration is None:
            return
        remove = _safe_getattr(self._context.song, "remove_tracks_listener")
        if callable(remove):
            try:
                remove(self._collection_registration)
            except Exception:
                pass
        self._collection_registration = None

    def _revalidate(self):
        tracks = list(_safe_getattr(self._context.song, "tracks", ()) or ())
        for subscription in list(self._subscriptions.values()):
            if not any(
                _same_lom_object(subscription.track, track)
                for track in tracks
            ):
                self._drop_invalid(subscription, "target-deleted")
            else:
                self._revalidate_subscription(subscription)

    def _revalidate_subscription(self, subscription):
        if subscription.event_id not in self._subscriptions:
            return
        if subscription.kind != PARAMETER_VALUE_CHANGED:
            return
        devices = _safe_getattr(subscription.track, "devices", ()) or ()
        if not any(
            _same_lom_object(subscription.device, device)
            for device in devices
        ):
            self._drop_invalid(subscription, "target-replaced")
            return
        parameters = _safe_getattr(subscription.device, "parameters", ()) or ()
        if not any(
            _same_lom_object(subscription.parameter, parameter)
            for parameter in parameters
        ):
            self._drop_invalid(subscription, "target-replaced")


def _validate_event_id(value):
    return (
        isinstance(value, STRING_TYPES)
        and _EVENT_ID.match(value) is not None
    )


def _validate_subscribe(params):
    if not isinstance(params, dict):
        return "params must be an object"
    kind = params.get("kind")
    if kind not in SUPPORTED_EVENT_KINDS:
        return "kind must be a supported Live event kind"
    required = set([
        "eventId",
        "kind",
        "liveSetId",
        "index",
        "expectedReference",
        "expectedName",
    ])
    accepted = set(required)
    if kind == PARAMETER_VALUE_CHANGED:
        accepted.add("observationPolicy")
        accepted.update([
            "deviceIndex",
            "expectedDeviceReference",
            "expectedDeviceName",
            "parameterIndex",
            "expectedParameterReference",
            "expectedParameterName",
        ])
        required.update(accepted - set(["observationPolicy"]))
    if set(params.keys()) - accepted or not required.issubset(params.keys()):
        return "subscribe parameters do not match the event kind"
    if not _validate_event_id(params.get("eventId")):
        return "eventId must be a canonical Live event ID"
    if (
        not isinstance(params.get("liveSetId"), STRING_TYPES)
        or not params["liveSetId"]
    ):
        return "liveSetId must be a non-empty string"
    try:
        _resolve_validator = {
            "index": params["index"],
            "expectedReference": params["expectedReference"],
            "expectedName": params["expectedName"],
        }
        message = _validate_exact_track(_resolve_validator)
        if message:
            return message
    except KeyError:
        return "track identity is required"
    if kind == PARAMETER_VALUE_CHANGED:
        for key in ("deviceIndex", "parameterIndex"):
            value = params.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                return "{0} must be a non-negative integer".format(key)
        for key in (
            "expectedDeviceReference",
            "expectedParameterReference",
        ):
            try:
                uuid.UUID(params.get(key))
            except (AttributeError, TypeError, ValueError):
                return "{0} must be a UUID".format(key)
        for key in ("expectedDeviceName", "expectedParameterName"):
            if (
                not isinstance(params.get(key), STRING_TYPES)
                or not params[key]
            ):
                return "{0} must be a non-empty string".format(key)
        policy = params.get("observationPolicy")
        if policy is not None:
            if not isinstance(policy, dict) or set(policy.keys()) - set([
                "minimumNormalizedDelta",
                "throttleMs",
            ]):
                return "observationPolicy has unsupported fields"
            delta = policy.get(
                "minimumNormalizedDelta",
                PARAMETER_MINIMUM_NORMALIZED_DELTA,
            )
            throttle = policy.get("throttleMs", 0)
            if (
                isinstance(delta, bool)
                or not isinstance(delta, (int, float))
                or math.isnan(delta)
                or math.isinf(delta)
                or delta < 0
                or delta > 1
            ):
                return "minimumNormalizedDelta must be between 0 and 1"
            if (
                isinstance(throttle, bool)
                or not isinstance(throttle, int)
                or throttle < 0
                or throttle > 60000
            ):
                return "throttleMs must be between 0 and 60000"
    return None


def _validate_exact_track(params):
    index = params.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "index must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedReference must be a UUID"
    if (
        not isinstance(params.get("expectedName"), STRING_TYPES)
        or not params["expectedName"]
    ):
        return "expectedName must be a non-empty string"
    return None


def _no_params(params):
    return None if not params else "Command does not accept parameters"


def _event_id_params(params):
    if (
        not isinstance(params, dict)
        or set(params.keys()) != set(["eventId"])
        or not _validate_event_id(params.get("eventId"))
    ):
        return "eventId must be the only parameter and use canonical format"
    return None


def register_event_commands(registry, manager):
    registry.register(
        "events.inspect_selection",
        lambda _context, _params: manager.inspect_selection(),
        capability="events.inspect_selection",
        validator=_no_params,
    )
    registry.register(
        "events.subscribe",
        lambda _context, params: manager.subscribe(params),
        capability="events.subscribe",
        validator=_validate_subscribe,
    )
    registry.register(
        "events.unsubscribe",
        lambda _context, params: manager.unsubscribe(params["eventId"]),
        capability="events.unsubscribe",
        validator=_event_id_params,
    )
    registry.register(
        "events.list_subscriptions",
        lambda _context, _params: manager.list_subscriptions(),
        capability="events.list_subscriptions",
        validator=_no_params,
    )
    registry.register(
        "events.clear_subscriptions",
        lambda _context, _params: manager.clear(
            publish_invalidation=True
        ),
        capability="events.clear_subscriptions",
        validator=_no_params,
    )
