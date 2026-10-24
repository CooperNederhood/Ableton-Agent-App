"""One bounded, message-rate guarded Session launch; never owns transport or DSP."""

import copy
import time

from .core_domain_commands import _integer, _name, _number, _resolve_clip, _resolve_track, _strict, _uuid
from .device_commands import _resolve_identity, _device_reference
from .errors import ProtocolFailure
from .executor import DeferredResult
from .identity import build_live_identity
from .listening_commands import _attest_path, _placement_collection
from .listening_playback import _listener, _overdub_state
from .session_listening_source import _state, inspect_session_listening_source, validate_session_listening_source
from .system_commands import _safe_lom_getattr


LIMITATIONS = (
    "Source monitoring is message-rate only. Clip.start_time is polled on callbacks, "
    "ticks and inspections, not subscribed; changes between observations may be missed. "
    "No guaranteed/sample-accurate continuity, native alignment or transport ownership.",
)
FOLLOW_LIMITATION = (
    "Follow-action state is unknown, not independently known disabled; admitted only "
    "under pass-owned message-rate source-change monitoring."
)
PASS_SECONDS = 40.0
LAUNCH_SECONDS = 5.0
RELEASE_RECEIPTS = 32
SESSION_PASS_COMMANDS = {
    "listening.prepare_session_pass": "prepare",
    "listening.launch_session_pass": "launch",
    "listening.inspect_session_pass": "inspect",
    "listening.release_session_pass": "release",
}
SESSION_SONG_SETTINGS = (
    "tempo", "signature_numerator", "signature_denominator", "clip_trigger_quantization",
    "record_mode", "session_record", "session_automation_record", "overdub", "tracks",
)
SESSION_CLIP_SETTINGS = (
    "name", "launch_mode", "launch_quantization", "legato",
    "start_marker", "end_marker", "loop_start", "loop_end", "looping",
)
# The Max 8/Live 11 public LOM lists start_time as get-only. Its required
# origin read is polled in every observation, not treated as a notification.
SESSION_CLIP_DYNAMIC = ("playing_position", "playing_status")


def _monitor_available(obj, field):
    return all(callable(_safe_lom_getattr(obj, prefix + field + "_listener"))
               for prefix in ("add_", "remove_"))


def session_listening_pass_supported(song):
    """Primitive detection only; admission still attests every exact binding."""
    if not all(_monitor_available(song, field) for field in SESSION_SONG_SETTINGS + ("is_playing",)):
        return False
    for track in _safe_lom_getattr(song, "tracks", ())[:256]:
        if not all(_monitor_available(track, field) for field in (
            "name", "clip_slots", "devices", "playing_slot_index", "fired_slot_index",
        )):
            continue
        for slot in _safe_lom_getattr(track, "clip_slots", ())[:256]:
            clip = _safe_lom_getattr(slot, "clip")
            if (_monitor_available(slot, "has_clip") and clip is not None
                    and callable(_safe_lom_getattr(clip, "fire"))
                    and all(_monitor_available(clip, field)
                            for field in SESSION_CLIP_SETTINGS + SESSION_CLIP_DYNAMIC)):
                return True
    return False


def validate_session_listening_pass(params):
    common = ("schemaVersion", "action", "ownerId", "passId")
    if not isinstance(params, dict):
        return "Invalid Session pass parameters"
    action = params.get("action")
    extra = {
        "prepare": ("expectedLiveSetId", "expectedProjectRevision", "target",
                    "listener", "durationBeats", "timingAnchor"),
        "launch": (), "inspect": (), "release": ("reason",),
    }
    if action not in extra or not _strict(params, common + extra[action]):
        return "Invalid Session pass action or fields"
    if not (_integer(params["schemaVersion"], 1, 1)
            and _uuid(params["ownerId"]) and _uuid(params["passId"])):
        return "Invalid Session pass version or UUIDs"
    if action == "release" and params["reason"] not in ("completed", "cancelled"):
        return "Invalid Session pass release reason"
    if action == "prepare" and not (
        _name(params["expectedLiveSetId"], required=True)
        and _integer(params["expectedProjectRevision"], 0)
        and validate_session_listening_source({
            "schemaVersion": 1, "queryId": params["passId"], "target": params["target"],
        }) is None
        and _listener(params["listener"])
        and params["listener"]["deviceIndex"] < 32
        and params["listener"]["track"] == params["target"]["track"]
        and _number(params["durationBeats"], positive=True)
        and params["durationBeats"] <= 4
        and _strict(params["timingAnchor"], ("globalBeat",))
        and _number(params["timingAnchor"]["globalBeat"], 0, 1576800)
    ):
        return "Invalid Session pass exact identities, binding, duration or anchor"
    return None


def validate_session_pass_action(params, action):
    error = validate_session_listening_pass(params)
    if error:
        return error
    if params["action"] != action:
        return "Session pass action does not match the granular command"
    return None


def _fail(message, code="conflict"):
    raise ProtocolFailure(code, message, details={
        "mutationState": "not-attempted", "cleanupPolicy": "leave-running",
    })


def _release_receipt(context, params):
    for receipt in getattr(context, "_session_listening_pass_releases", ()):
        if receipt["ownerId"] == params["ownerId"] and receipt["passId"] == params["passId"]:
            return receipt
    return None


class _Pass(object):
    def __init__(self, context, params, identity_builder, clock):
        self.context, self.params = context, copy.deepcopy(params)
        self.identity_builder, self.clock = identity_builder, clock
        self.created = clock()
        self.expires = self.created + PASS_SECONDS
        self.status, self.reason = "prepared", None
        self.invalidation_reason = None
        self.mutation = "not-attempted"
        self.epoch = None
        self.registrations = []
        self.closed = False
        self.last_position = None
        self.last_dynamic = None
        self.transition_counts = {}
        self.launch_deadline = None
        self.pending_launch = None
        self.monitor_ticks = 0
        self.track = _resolve_track(context, params["target"]["track"], bounded=True)
        self.clip = _resolve_clip(context, params["target"], scan_limit=256)
        self.slot = self.track.clip_slots[params["target"]["sceneIndex"]]
        self.admission()
        self.baseline = self.snapshot()
        self.source_kind = self.baseline["sourceKind"]
        self.follow_unknown = self.baseline["settings"]["followActionEnabled"] is None
        self.last_dynamic = self.baseline["after"]
        self.last_source = self.baseline["after"]

    def listener(self):
        target = self.params["listener"]
        track = _resolve_track(self.context, target["track"], bounded=True)
        device = _resolve_identity(
            _placement_collection(track, "devices", 32),
            {"index": target["deviceIndex"], "expectedReference": target["expectedDeviceReference"],
             "expectedName": target["expectedDeviceName"]},
            lambda value: _device_reference(self.context, value, bounded=True), "Listener",
        )
        attested, _path = _attest_path(self.context, track, device)
        if attested != target or target["expectedClassName"] != "MxDeviceAudioEffect":
            _fail("Session listener identity/class/placement changed")
        if _safe_lom_getattr(device, "is_active") is not True:
            _fail("Session listener must be independently enabled")
        return device

    def snapshot(self):
        return inspect_session_listening_source(self.context, {
            "schemaVersion": 1, "queryId": self.params["passId"], "target": self.params["target"],
        })

    def common_guards(self):
        song = self.context.song
        if self.identity_builder(song)["liveSetId"] != self.params["expectedLiveSetId"]:
            _fail("Session pass Live Set identity changed")
        self.listener()
        for field in ("record_mode", "session_record", "session_automation_record"):
            if _safe_lom_getattr(song, field) is not False:
                _fail("Session pass requires known recording-off: " + field)
        if _overdub_state(song) is not False:
            _fail("Session pass requires known overdub-off")
        return self.snapshot()

    def admission(self):
        if self.context.project_revision != self.params["expectedProjectRevision"]:
            _fail("Session pass project revision changed")
        evidence = self.common_guards()
        settings, state = evidence["settings"], evidence["after"]
        if state["transportPlaying"] is not False:
            _fail("Session pass requires known stopped transport")
        if (state["targetPlaying"] is not False or state["targetTriggered"] is not False
                or state["targetRecording"] is not False):
            _fail("Session target must be known stopped, unqueued and recording-off")
        if state["globalBeat"] != self.params["timingAnchor"]["globalBeat"]:
            _fail("Session pass stopped timing anchor changed")
        # No Arrangement-selection, insert-marker or Session-override guards.
        for track in _placement_collection(self.context.song, "tracks", 256):
            if _safe_lom_getattr(track, "fired_slot_index") != -1:
                _fail("Session pass pending launch is present or unknown")
        if state["playingSlotIndex"] is None:
            _fail("Session playing slot is unknown")
        if state["startTimeBeats"] is None or state["playingPosition"] is None:
            _fail("Required polled Session origin/position is unavailable")
        if evidence["sourceKind"] not in ("midi", "warped-audio"):
            _fail("Only known MIDI or warped audio Session sources are admitted")
        if any(settings[field] is None for field in settings if field != "followActionEnabled"):
            _fail("Session source required setting is unknown")
        if self.params["durationBeats"] >= min(settings["endMarker"], settings["loopEnd"]):
            _fail(
                "Session capture must finish strictly before loop end and end marker; "
                "message-rate monitoring cannot qualify exact wrap/natural-end boundary equality"
            )
        if not (
            settings["signatureNumerator"] == settings["signatureDenominator"] == 4
            and settings["globalQuantization"] in (0, 4)
            and settings["launchQuantization"] == settings["launchMode"] == 0
            and settings["legato"] is False and settings["followActionEnabled"] is not True
            and settings["startMarker"] == settings["loopStart"] == 0
            and self.params["durationBeats"] * 60 / settings["tempoBpm"] <= 30
        ):
            _fail("Session source launch settings, first-iteration range or duration are unsafe")
        if not callable(_safe_lom_getattr(self.clip, "fire")):
            _fail("Session Clip.fire is unavailable", "unsupported_capability")

    def subscribe(self):
        song = self.context.song
        groups = (
            (song, SESSION_SONG_SETTINGS),
            (self.track, ("name", "clip_slots", "devices")),
            (self.slot, ("has_clip",)),
            (self.listener(), ("is_active", "name")),
            (self.clip, SESSION_CLIP_SETTINGS),
        )
        for obj, fields in groups:
            for field in fields:
                self.add_monitor(obj, field, static=True)
        if self.source_kind == "warped-audio":
            self.add_monitor(self.clip, "warping", static=True)
        # Public Clip playing_status reports playing/trigger changes. Recording
        # and origin reads remain required on every observation.
        # Nullable follow_action_enabled is not a listenable public API on Live 11.
        for obj, fields in (
            (song, ("is_playing",)),
            (self.track, ("playing_slot_index", "fired_slot_index")),
            (self.clip, SESSION_CLIP_DYNAMIC),
        ):
            for field in fields:
                self.add_monitor(obj, field, static=False)

    def add_monitor(self, obj, field, static):
        add = _safe_lom_getattr(obj, "add_" + field + "_listener")
        remove = _safe_lom_getattr(obj, "remove_" + field + "_listener")
        if not callable(add) or not callable(remove):
            _fail("Required public Session monitor unavailable: " + field, "unsupported_capability")

        def changed():
            if self.closed or self.status in ("invalidated", "expired"):
                return
            if static:
                self.observe()
                self.invalidate("Observed Session source/settings/listener edit: " + field)
            else:
                self.observe()

        try:
            add(changed)
        except (RuntimeError, AttributeError) as error:
            raise ProtocolFailure("unsupported_capability", "Could not subscribe Session monitor: " + field,
                                  details={"mutationState": "not-attempted",
                                           "cleanupPolicy": "leave-running"}) from error
        self.registrations.append((obj, field, remove, changed))

    def invalidate(self, reason):
        if self.invalidation_reason is None:
            self.invalidation_reason = reason
        self.status, self.reason = "invalidated", self.invalidation_reason

    def observe(self):
        if self.closed or self.status in ("invalidated", "expired", "released", "cancelled"):
            return
        try:
            # Retain bounded changed-source evidence even if exact target or
            # listener re-resolution subsequently refuses the pass.
            self.last_source = _state(self.context, self.track, self.clip)
            evidence = self.common_guards()
            if (evidence["settings"] != self.baseline["settings"]
                    or evidence["sourceKind"] != self.source_kind):
                _fail("Session source fingerprint changed")
            state = evidence["after"]
            if state["targetRecording"] is not False:
                _fail("Session target recording became unsafe or unknown")
            required = ("transportPlaying", "globalBeat", "startTimeBeats", "playingPosition",
                        "targetPlaying", "targetTriggered", "playingSlotIndex", "firedSlotIndex")
            if any(state[field] is None for field in required):
                _fail("Required Session state became unknown")
            if self.mutation == "not-attempted":
                if state != self.baseline["after"]:
                    _fail("Session source changed before the one owned launch")
                return
            previous = self.last_dynamic
            scene = self.params["target"]["sceneIndex"]
            if state["firedSlotIndex"] not in (-1, scene):
                _fail("Another Session launch was observed")
            # Only one forward launch transition is permitted; never waive all
            # callbacks/revisions while the owned quantized launch is pending.
            for field, limit in (
                ("transportPlaying", 1), ("targetPlaying", 1), ("targetTriggered", 2),
                ("playingSlotIndex", 1), ("firedSlotIndex", 2), ("startTimeBeats", 1),
            ):
                if previous[field] != state[field]:
                    count = self.transition_counts.get(field, 0) + 1
                    self.transition_counts[field] = count
                    if count > limit:
                        _fail("Session source retrigger/transition observed: " + field)
                    if field in ("transportPlaying", "targetPlaying") and state[field] is not True:
                        _fail("Session playback stopped during pass")
                    if field == "playingSlotIndex" and state[field] != scene:
                        _fail("Session source switched during launch")
            if self.epoch is not None:
                if not (state["transportPlaying"] is True and state["targetPlaying"] is True
                        and state["targetTriggered"] is False and state["playingSlotIndex"] == scene
                        and state["firedSlotIndex"] == -1
                        and state["selectedClipReference"] == self.params["target"]["expectedClipReference"]
                        and state["startTimeBeats"] == self.epoch["startTimeBeats"]):
                    _fail("Session active source identity or epoch changed")
            position = state["playingPosition"]
            if self.epoch is not None:
                if (self.last_position is not None and position < self.last_position
                        or position < 0 or position >= self.baseline["settings"]["loopEnd"]):
                    _fail("Session source wrap or invalid first-iteration position observed")
                self.last_position = position
            self.last_dynamic = state
            if (self.epoch is None and state["transportPlaying"] is True
                    and state["targetPlaying"] is True and state["targetTriggered"] is False
                    and state["playingSlotIndex"] == scene and state["firedSlotIndex"] == -1
                    and state["selectedClipReference"] == self.params["target"]["expectedClipReference"]):
                origin = state["startTimeBeats"]
                anchor = self.params["timingAnchor"]["globalBeat"]
                quantized = self.baseline["settings"]["globalQuantization"] == 4
                # Public reads/callbacks need not become visible atomically.
                # A stale start_time never becomes an epoch by acceptance time;
                # wait boundedly for the actual independently readable origin.
                if anchor <= origin <= anchor + (4 if quantized else 0) and origin <= state["globalBeat"]:
                    elapsed = state["globalBeat"] - origin
                    end = min(self.baseline["settings"]["loopEnd"], self.baseline["settings"]["endMarker"])
                    if elapsed >= end:
                        _fail("Session first iteration elapsed before source readback")
                    # The stopped clip can retain its previous position until
                    # our own launch resets it. Do not mistake that one reset
                    # for a retrigger/wrap, or accept stale position as onset.
                    if 0 <= position < end and position <= elapsed + 0.25:
                        self.epoch = {
                            "startTimeBeats": origin,
                            "clipReference": state["selectedClipReference"],
                            "observedGlobalBeat": state["globalBeat"],
                        }
                        self.last_position = position
                        self.status, self.mutation = "playing", "observed-playing"
            elif self.epoch is None and state["targetTriggered"] is True:
                self.status = "queued"
        except ProtocolFailure as error:
            self.invalidate(error.message)
        except (RuntimeError, AttributeError, IndexError) as error:
            self.invalidate("Session source observation failed: " + type(error).__name__)

    def result(self):
        return {
            "schemaVersion": 1, "ownerId": self.params["ownerId"], "passId": self.params["passId"],
            "status": self.status, "mutationState": self.mutation, "reason": self.reason,
            "cleanupPolicy": "leave-running", "evidence": "message-rate-only",
            "nativeAlignment": "unverified", "sourceEpoch": self.epoch,
            "lastObservedSource": copy.deepcopy(self.last_source),
            "followActionState": "unknown" if self.follow_unknown else "known-disabled",
            "limitations": list(LIMITATIONS) + ([FOLLOW_LIMITATION] if self.follow_unknown else []),
            "durationBeats": self.params["durationBeats"],
            "expiresInMs": min(40000, max(0, int((self.expires - self.clock()) * 1000))),
        }

    def settle_launch(self):
        if self.pending_launch is not None:
            success, _failure = self.pending_launch
            self.pending_launch = None
            success(self.result())

    def close(self, status, reason=None):
        if status == "invalidated":
            self.invalidate(reason)
        self.status, self.reason, self.closed = status, self.invalidation_reason or reason, True
        failures = []
        registrations, self.registrations = self.registrations, []
        for obj, field, remove, callback in reversed(registrations):
            try:
                remove(callback)
            except (RuntimeError, AttributeError):
                failures.append((obj, field, remove, callback))
        self.registrations = failures
        if failures:
            self.reason = "Session monitor removal failed; cleanup must be retried"
            raise ProtocolFailure("lom_error", self.reason, details={
                "mutationState": self.mutation, "cleanupPolicy": "leave-running",
            })
        if getattr(self.context, "_session_listening_pass", None) is self:
            self.context._session_listening_pass = None
        receipts = getattr(self.context, "_session_listening_pass_releases", [])
        receipts.append(copy.deepcopy(self.result()))
        self.context._session_listening_pass_releases = receipts[-RELEASE_RECEIPTS:]
        self.settle_launch()

    def poll(self):
        if self.closed:
            return
        self.monitor_ticks += 1
        if self.clock() >= self.expires or self.monitor_ticks >= 1200:
            self.close("expired", "Bounded Session pass expired")
            return
        self.observe()
        if self.pending_launch is not None:
            if self.status in ("playing", "invalidated"):
                self.settle_launch()
            elif self.clock() >= self.launch_deadline or self.monitor_ticks >= self.launch_tick_deadline:
                self.status, self.reason = "unverified", "Owned launch onset not observed before timeout"
                self.settle_launch()
        try:
            self.context.schedule_message(1, self.poll)
        except (RuntimeError, AttributeError):
            self.close("invalidated", "Session source monitor scheduling failed; playback left unchanged")

    def launch(self):
        if self.status != "prepared":
            _fail("Session pass is not prepared for its one launch")

        def begin(success, failure, progress):
            if not self.closed and self.clock() >= self.expires:
                self.close("expired", "Bounded Session pass expired before dispatch")
            if self.closed:
                success(self.result())
                return
            if self.status != "prepared":
                failure(ProtocolFailure("conflict", "Session pass no longer prepared", details={
                    "mutationState": self.mutation, "cleanupPolicy": "leave-running",
                }))
                return
            try:
                self.admission()
                self.observe()
                if self.status != "prepared":
                    _fail("Session source changed before dispatch")
                self.status = "accepted"
                self.launch_deadline = self.clock() + LAUNCH_SECONDS
                self.launch_tick_deadline = self.monitor_ticks + 120
                self.pending_launch = (success, failure)
                if progress is not None:
                    progress({"phase": "session_launch_accepted"})
                if self.closed:
                    return
                if self.status != "accepted":
                    self.settle_launch()
                    return
                self.mutation = "indeterminate"
                self.clip.fire()
                self.observe()
                if progress is not None:
                    progress({"phase": "session_launch_" + self.status})
                if self.status in ("playing", "invalidated"):
                    self.settle_launch()
            except (ProtocolFailure, RuntimeError, AttributeError) as error:
                self.pending_launch = None
                self.invalidate("Session launch failed; playback is left unchanged")
                failure(ProtocolFailure(
                    error.code if isinstance(error, ProtocolFailure) else "lom_error",
                    self.reason, details={
                        "mutationState": self.mutation, "cleanupPolicy": "leave-running",
                    },
                ))
        return DeferredResult(begin, supports_progress=True)


def clear_session_listening_pass(context):
    """Connection/shutdown hook; never retracts a dispatched fire or stops playback."""
    active = getattr(context, "_session_listening_pass", None)
    if active is not None:
        active.close("cancelled", "Connection released")


def session_listening_pass(context, params, identity_builder=build_live_identity, clock=time.monotonic):
    error = validate_session_listening_pass(params)
    if error:
        _fail(error, "invalid_params")
    active = getattr(context, "_session_listening_pass", None)
    if active is not None and active.clock() >= active.expires:
        active.close("expired", "Bounded Session pass expired")
        active = None
    receipt = _release_receipt(context, params)
    if params["action"] == "release" and receipt is not None:
        return copy.deepcopy(receipt)
    if params["action"] == "prepare":
        if active is not None:
            _fail("Only one active Session pass is permitted per connection context")
        if receipt is not None:
            _fail("Session pass identity was already closed; prepare requires a fresh pass UUID")
        if not callable(getattr(context, "schedule_message", None)):
            _fail("Session monitor scheduler unavailable", "unsupported_capability")
        active = _Pass(context, params, identity_builder, clock)
        context._session_listening_pass = active
        try:
            active.subscribe()
            active.observe()
            if active.status != "prepared":
                _fail("Session source changed while subscribing")
            context.schedule_message(1, active.poll)
        except (ProtocolFailure, RuntimeError, AttributeError):
            active.close("invalidated", "Session pass preparation failed")
            raise
        return active.result()
    if (active is None or active.params["ownerId"] != params["ownerId"]
            or active.params["passId"] != params["passId"]):
        _fail("Session pass is stale or belongs to another owner")
    if params["action"] == "release":
        active.close("cancelled" if params["reason"] == "cancelled" else "released")
    elif params["action"] == "launch":
        return active.launch()
    else:
        active.observe()
    return active.result()


def register_session_listening_pass(registry):
    registry.register(
        "listening.prepare_session_pass", session_listening_pass,
        capability="listening.prepare_session_pass",
        validator=lambda params: validate_session_pass_action(params, "prepare"),
    )
    registry.register(
        "listening.launch_session_pass", session_listening_pass, mutates=True,
        capability="listening.launch_session_pass",
        validator=lambda params: validate_session_pass_action(params, "launch"),
    )
    registry.register(
        "listening.inspect_session_pass", session_listening_pass,
        capability="listening.inspect_session_pass",
        validator=lambda params: validate_session_pass_action(params, "inspect"),
    )
    registry.register(
        "listening.release_session_pass", session_listening_pass,
        capability="listening.release_session_pass",
        validator=lambda params: validate_session_pass_action(params, "release"),
    )
