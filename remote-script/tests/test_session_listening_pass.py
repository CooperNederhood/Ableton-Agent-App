import copy
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.capabilities import build_capability_document
from AbletonAgent.core_domain_commands import _clip_reference, _track_reference
from AbletonAgent.device_commands import _device_reference
from AbletonAgent.errors import ProtocolFailure
from AbletonAgent.executor import MainThreadExecutor
from AbletonAgent.identity import build_live_identity
from AbletonAgent.registry import CommandRegistry
from AbletonAgent.protocol import FrameDecoder, encode_frame
from AbletonAgent.session_listening_pass import (
    clear_session_listening_pass, register_session_listening_pass, session_listening_pass,
    validate_session_listening_pass, session_listening_pass_supported,
)
from simulator import handle
import test_session_listening_source as source_fixtures
from AbletonAgent import session_listening_source as source_module


OWNER = "10000000-0000-4000-8000-000000000001"
PASS = "10000000-0000-4000-8000-000000000002"


class Observable(types.SimpleNamespace):
    def __init__(self, **fields):
        super().__init__(**fields)
        self.callbacks = {}

    def __getattr__(self, field):
        for prefix in ("add_", "remove_"):
            if field.startswith(prefix) and field.endswith("_listener"):
                key = field[len(prefix):-len("_listener")]
                if key not in vars(self):
                    raise AttributeError(field)
                if prefix == "add_":
                    return lambda callback: self.callbacks.setdefault(key, []).append(callback)
                return lambda callback: self.callbacks[key].remove(callback)
        raise AttributeError(field)

    def change(self, field, value):
        setattr(self, field, value)
        callbacks = list(self.callbacks.get(field, []))
        if field in ("is_playing", "is_triggered", "is_recording"):
            callbacks += self.callbacks.get("playing_status", [])
        for callback in list(callbacks):
            callback()


class SessionListeningPassTest(unittest.TestCase):
    def setUp(self):
        enum_patch = patch.object(
            source_module, "ClipLaunchQuantization", source_fixtures.CanonicalClipLaunchQuantization,
        )
        enum_patch.start()
        self.addCleanup(enum_patch.stop)
        self.now = 0.0
        self.pending = []
        self.clip = Observable(
            name="Source", is_audio_clip=False, is_midi_clip=True, warping=None,
            is_playing=False, is_triggered=False, is_recording=False, playing_status=0,
            start_time=-4.0, playing_position=0.0, start_marker=0.0, end_marker=8.0,
            loop_start=0.0, loop_end=8.0, looping=True, launch_mode=0,
            launch_quantization=0, legato=False, follow_action_enabled=None,
        )
        self.clip.add_start_time_listener = None
        self.clip.remove_start_time_listener = None
        self.device = Observable(
            name="Listener", class_name="MxDeviceAudioEffect", is_active=True,
        )
        self.slot = Observable(has_clip=True, clip=self.clip)
        self.track = Observable(
            name="Track", clip_slots=[self.slot], devices=[self.device],
            playing_slot_index=-1, fired_slot_index=-1,
        )
        self.song = Observable(
            tracks=[self.track], return_tracks=[], master_track=None, is_playing=False,
            current_song_time=12.0, tempo=120.0, clip_trigger_quantization=4,
            signature_numerator=4, signature_denominator=4,
            record_mode=False, session_record=False, overdub=False,
            session_automation_record=False,
        )
        self.context = types.SimpleNamespace(
            song=self.song, project_revision=5,
            schedule_message=lambda ticks, callback: self.pending.append(callback),
        )
        self.target = {
            "view": "session", "sceneIndex": 0,
            "track": {
                "kind": "regular", "index": 0, "expectedName": "Track",
                "expectedReference": _track_reference(self.context, self.track, bounded=True),
            },
            "expectedClipReference": _clip_reference(self.context, self.clip, bounded=True),
            "expectedClipName": "Source",
        }
        self.binding = {
            "track": self.target["track"], "deviceIndex": 0,
            "expectedDeviceReference": _device_reference(self.context, self.device, bounded=True),
            "expectedDeviceName": "Listener", "expectedClassName": "MxDeviceAudioEffect",
        }
        self.params = {
            "schemaVersion": 1, "action": "prepare", "ownerId": OWNER, "passId": PASS,
            "expectedLiveSetId": "set", "expectedProjectRevision": 5,
            "target": self.target, "listener": self.binding, "durationBeats": 4,
            "timingAnchor": {"globalBeat": 12.0},
        }
        self.fires = 0
        self.clip.fire = self.fire

    def call(self, action="prepare", **changes):
        params = self.params if action == "prepare" else {
            "schemaVersion": 1, "action": action, "ownerId": OWNER, "passId": PASS,
        }
        return session_listening_pass(
            self.context, {**params, **changes},
            identity_builder=lambda song: {"liveSetId": "set"}, clock=lambda: self.now,
        )

    def fire(self):
        self.fires += 1
        self.song.change("is_playing", True)
        self.track.change("fired_slot_index", 0)
        self.clip.change("is_triggered", True)

    def activate(self, origin=16.0):
        self.song.current_song_time = origin
        self.clip.change("start_time", origin)
        self.track.change("playing_slot_index", 0)
        self.clip.change("is_playing", True)
        self.clip.change("is_triggered", False)
        self.track.change("fired_slot_index", -1)

    def launch(self):
        result = self.call("launch")
        self.results, self.errors, self.progress = [], [], []
        result.start(self.results.append, self.errors.append, self.progress.append)

    def tick(self):
        callbacks, self.pending = self.pending, []
        for callback in callbacks:
            callback()

    def assert_denied(self):
        with self.assertRaises(ProtocolFailure):
            self.call()
        self.assertEqual(self.fires, 0)
        self.assert_no_monitors()

    def assert_no_monitors(self):
        for obj in (self.song, self.track, self.clip, self.slot, self.device):
            self.assertTrue(all(not entries for entries in obj.callbacks.values()))

    def test_prepare_launch_midi_and_warped_audio_origin_and_leave_running(self):
        for kind in ("midi", "audio"):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == "audio":
                    self.clip.is_midi_clip, self.clip.is_audio_clip, self.clip.warping = False, True, True
                prepared = self.call()
                self.assertEqual(prepared["status"], "prepared")
                self.assertIn("message-rate", prepared["limitations"][0])
                self.launch()
                self.assertEqual(self.call("inspect")["status"], "queued")
                self.assertIsNone(self.call("inspect")["sourceEpoch"])
                self.activate()
                self.tick()
                self.assertEqual(self.errors, [])
                self.assertEqual(self.results[0]["status"], "playing")
                self.assertEqual(self.results[0]["sourceEpoch"]["startTimeBeats"], 16)
                self.assertEqual(self.results[0]["nativeAlignment"], "unverified")
                self.assertEqual(self.fires, 1)
                released = self.call("release", reason="completed")
                self.assertEqual(released["cleanupPolicy"], "leave-running")
                self.assertTrue(self.song.is_playing)
                self.assert_no_monitors()

    def test_denies_unsafe_or_unknown_settings_without_fire(self):
        for obj, field, value in (
            ("song", "is_playing", True), ("song", "record_mode", True),
            ("song", "overdub", None), ("song", "session_record", None),
            ("song", "session_automation_record", True),
            ("song", "tempo", None), ("song", "tempo", 1.0),
            ("song", "current_song_time", None), ("song", "signature_denominator", None),
            ("song", "signature_numerator", 3), ("song", "clip_trigger_quantization", 5),
            ("clip", "launch_quantization", 4), ("clip", "launch_quantization", 5),
            ("clip", "legato", True),
            ("clip", "start_marker", 1), ("clip", "loop_start", 1),
            ("clip", "loop_end", 3), ("clip", "end_marker", 3),
            ("clip", "follow_action_enabled", True), ("clip", "launch_mode", 1),
            ("clip", "is_recording", None), ("clip", "is_triggered", True),
            ("clip", "is_triggered", None), ("clip", "start_time", None),
            ("clip", "playing_position", None), ("clip", "end_marker", None),
            ("clip", "is_playing", None), ("clip", "looping", None),
            ("track", "fired_slot_index", 0),
        ):
            with self.subTest(obj=obj, field=field, value=value):
                self.setUp()
                setattr(getattr(self, obj), field, value)
                self.assert_denied()
        self.setUp()
        self.clip.is_audio_clip, self.clip.is_midi_clip, self.clip.warping = True, False, False
        self.assert_denied()

    def test_binding_revision_set_anchor_and_required_monitor_refusals(self):
        for change in (
            {"expectedLiveSetId": "other"}, {"expectedProjectRevision": 4},
            {"timingAnchor": {"globalBeat": 11}},
            {"listener": {**self.binding, "expectedDeviceName": "Other"}},
        ):
            with self.subTest(change=change):
                self.setUp()
                self.params.update(change)
                self.assert_denied()
        self.setUp()
        self.clip.add_playing_status_listener = None
        self.assert_denied()

    def test_observed_edits_switch_retrigger_wrap_and_replacement_invalidate(self):
        for obj, field, value in (
            ("song", "tempo", 121), ("song", "record_mode", True),
            ("song", "clip_trigger_quantization", 0),
            ("clip", "legato", True), ("clip", "start_time", 20.0),
            ("clip", "is_triggered", True), ("track", "playing_slot_index", 1),
            ("slot", "clip", Observable(name="Replacement")),
            ("device", "is_active", False),
        ):
            with self.subTest(field=field):
                self.setUp()
                self.call()
                self.launch()
                self.activate()
                self.tick()
                getattr(self, obj).change(field, value)
                self.assertEqual(self.call("inspect")["status"], "invalidated")
                self.assertTrue(self.song.is_playing)
                self.call("release", reason="cancelled")
                self.assert_no_monitors()
        self.setUp()
        self.call()
        self.launch()
        self.activate()
        self.tick()
        self.clip.change("playing_position", 2)
        self.song.current_song_time = 18
        self.tick()
        self.clip.change("playing_position", 0)
        self.assertEqual(self.call("inspect")["status"], "invalidated")

    def test_cancel_before_dispatch_and_after_dispatch_never_retracts_fire(self):
        self.call()
        deferred = self.call("launch")
        self.call("release", reason="cancelled")
        results, errors = [], []
        deferred.start(results.append, errors.append)
        self.assertEqual(self.fires, 0)
        self.assertEqual(results[0]["mutationState"], "not-attempted")
        self.assert_no_monitors()
        self.setUp()
        self.call()
        self.launch()
        released = self.call("release", reason="cancelled")
        self.tick()
        self.assertEqual(released["mutationState"], "indeterminate")
        self.assertEqual(self.fires, 1)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(len(self.results), 1)
        self.assert_no_monitors()

    def test_unverified_timeout_partial_fire_exception_expiry_and_old_pass(self):
        self.call()
        self.launch()
        self.now = 6
        self.tick()
        self.assertEqual(self.results[0]["status"], "unverified")
        self.assertEqual(self.results[0]["mutationState"], "indeterminate")
        self.assertTrue(self.song.is_playing)
        self.now = 41
        self.tick()
        self.assert_no_monitors()
        with self.assertRaises(ProtocolFailure):
            self.call("inspect")
        self.setUp()
        self.call()
        def broken_fire():
            self.fire()
            raise RuntimeError("partial")
        self.clip.fire = broken_fire
        self.launch()
        self.assertEqual(self.errors[0].details["mutationState"], "indeterminate")
        self.assertEqual(self.call("inspect")["status"], "invalidated")
        self.assertTrue(self.song.is_playing)
        self.call("release", reason="cancelled")
        self.assert_no_monitors()

    def test_single_pass_disconnect_and_stale_actions(self):
        self.call()
        with self.assertRaises(ProtocolFailure):
            self.call()
        with self.assertRaises(ProtocolFailure):
            self.call("release", reason="cancelled", passId=OWNER)
        clear_session_listening_pass(self.context)
        self.assert_no_monitors()
        with self.assertRaises(ProtocolFailure):
            self.call("launch")
        self.params["passId"] = "10000000-0000-4000-8000-000000000003"
        self.call()
        old = self.call("release", reason="cancelled")
        self.assertEqual(old["passId"], PASS)
        self.assertEqual(old["status"], "cancelled")
        current = self.call("inspect", passId=self.params["passId"])
        self.assertEqual(current["status"], "prepared")
        clear_session_listening_pass(self.context)

    def test_release_is_idempotent_nonlaunching_and_retains_origin_and_dirty_reason(self):
        self.call()
        self.launch()
        self.activate()
        self.tick()
        self.clip.change("legato", True)
        invalid = self.call("inspect")
        first = self.call("release", reason="cancelled")
        second = self.call("release", reason="cancelled")
        self.assertEqual(first, second)
        self.assertEqual(second["sourceEpoch"], invalid["sourceEpoch"])
        self.assertEqual(second["reason"], invalid["reason"])
        self.assertEqual(self.fires, 1)
        self.assertTrue(self.song.is_playing)
        self.assert_no_monitors()

    def test_release_before_deferred_dispatch_is_repeatable_and_fences_every_receipt(self):
        self.call()
        deferred = self.call("launch")
        first = self.call("release", reason="cancelled")
        self.assertEqual(self.call("release", reason="cancelled"), first)
        results, errors = [], []
        deferred.start(results.append, errors.append)
        self.tick()
        self.assertEqual(self.fires, 0)
        self.assertEqual(errors, [])
        self.assertEqual(results[0]["mutationState"], "not-attempted")
        first["limitations"].clear()
        self.assertTrue(self.call("release", reason="cancelled")["limitations"])
        with self.assertRaises(ProtocolFailure):
            self.call()
        self.assert_no_monitors()

    def test_release_receipt_cache_is_bounded_and_old_owner_cannot_release_current_pass(self):
        for index in range(40):
            self.params["passId"] = "10000000-0000-4000-8000-{0:012d}".format(index + 10)
            self.call()
            self.call("release", passId=self.params["passId"], reason="completed")
        self.assertLessEqual(len(self.context._session_listening_pass_releases), 32)
        with self.assertRaises(ProtocolFailure):
            self.call("release", reason="cancelled", ownerId=PASS)

    def test_delayed_origin_is_never_substituted_with_acceptance_time(self):
        self.call()
        self.launch()
        self.track.change("playing_slot_index", 0)
        self.clip.change("is_playing", True)
        self.clip.change("is_triggered", False)
        self.track.change("fired_slot_index", -1)
        self.tick()
        self.assertIsNone(self.call("inspect")["sourceEpoch"])
        self.assertEqual(self.results, [])
        self.song.current_song_time = 16
        self.clip.change("start_time", 16)
        self.tick()
        self.assertEqual(self.results[0]["sourceEpoch"]["startTimeBeats"], 16)
        self.assertEqual(self.results[0]["status"], "playing")
        self.assertEqual(
            [event["phase"] for event in self.progress],
            ["session_launch_accepted", "session_launch_queued"],
        )

    def test_owned_launch_may_reset_stopped_position_once_before_observed_epoch(self):
        self.clip.playing_position = 6
        self.call()
        self.launch()
        self.activate()
        self.assertIsNone(self.call("inspect")["sourceEpoch"])
        self.clip.change("playing_position", 0)
        self.tick()
        self.assertEqual(self.results[0]["status"], "playing")
        self.assertEqual(self.results[0]["sourceEpoch"]["startTimeBeats"], 16)
        self.clip.change("playing_position", 1)
        self.song.current_song_time = 17
        self.clip.change("playing_position", 0)
        self.assertEqual(self.call("inspect")["status"], "invalidated")

    def test_monitors_latch_transient_changes_before_reversion(self):
        for obj, field, first, restored in (
            ("clip", "legato", True, False),
            ("song", "tempo", 121, 120),
            ("clip", "is_triggered", True, False),
            ("track", "playing_slot_index", 1, 0),
        ):
            with self.subTest(field=field):
                self.setUp()
                self.call()
                self.launch()
                self.activate()
                self.tick()
                getattr(self, obj).change(field, first)
                getattr(self, obj).change(field, restored)
                self.assertEqual(self.call("inspect")["status"], "invalidated")
                self.assertTrue(self.song.is_playing)

    def test_expired_or_cancelled_at_acceptance_before_fire_is_not_dispatched(self):
        self.call()
        deferred = self.call("launch")
        self.now = 41
        results, errors = [], []
        deferred.start(results.append, errors.append)
        self.assertEqual(self.fires, 0)
        self.assertEqual(results[0]["status"], "expired")
        self.assert_no_monitors()
        self.setUp()
        self.call()
        deferred = self.call("launch")
        results = []
        deferred.start(
            results.append, errors.append,
            lambda event: self.call("release", reason="cancelled"),
        )
        self.assertEqual(self.fires, 0)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["mutationState"], "not-attempted")
        self.assert_no_monitors()

    def test_monitor_subscription_failure_removes_every_prior_registration(self):
        self.clip.add_playing_status_listener = lambda callback: (_ for _ in ()).throw(RuntimeError("missing"))
        self.assert_denied()
        self.assertIsNone(self.context._session_listening_pass)

    def test_failed_monitor_removal_is_tracked_and_retryable_without_transport_change(self):
        original = self.clip.remove_playing_position_listener
        attempts = []
        def remove(callback):
            attempts.append(callback)
            if len(attempts) == 1:
                raise RuntimeError("Transient removal failure")
            original(callback)
        self.clip.remove_playing_position_listener = remove
        self.call()
        self.launch()
        with self.assertRaises(ProtocolFailure):
            self.call("release", reason="cancelled")
        self.assertEqual(len(self.context._session_listening_pass.registrations), 1)
        self.assertTrue(self.song.is_playing)
        self.call("release", reason="cancelled")
        self.assertEqual(len(attempts), 2)
        self.assert_no_monitors()

    def test_scheduler_failure_cleans_up_and_reports_partial_launch_without_rollback(self):
        self.call()
        self.launch()
        self.context.schedule_message = lambda ticks, callback: (_ for _ in ()).throw(RuntimeError("closed"))
        self.tick()
        self.assertEqual(self.results[0]["status"], "invalidated")
        self.assertEqual(self.results[0]["mutationState"], "indeterminate")
        self.assertEqual(self.results[0]["cleanupPolicy"], "leave-running")
        self.assertTrue(self.song.is_playing)
        self.assert_no_monitors()

    def test_changed_source_identity_is_retained_as_message_rate_diagnostic(self):
        other = Observable(name="Other")
        self.track.clip_slots.append(Observable(has_clip=True, clip=other))
        self.call()
        self.launch()
        self.activate()
        self.tick()
        self.track.change("playing_slot_index", 1)
        result = self.call("inspect")
        self.assertEqual(result["status"], "invalidated")
        self.assertEqual(
            result["lastObservedSource"]["selectedClipReference"],
            _clip_reference(self.context, other, bounded=True),
        )
        self.assertEqual(result["sourceEpoch"]["startTimeBeats"], 16)
        self.assertEqual(result["nativeAlignment"], "unverified")

    def test_known_disabled_follow_actions_are_reported_without_unknown_promotion(self):
        self.clip.follow_action_enabled = False
        result = self.call()
        self.assertEqual(result["followActionState"], "known-disabled")
        self.assertEqual(len(result["limitations"]), 1)

    def test_global_none_uses_actual_epoch_and_duration_boundary_is_in_seconds(self):
        self.song.clip_trigger_quantization = 0
        self.song.tempo = 8
        self.call()
        self.launch()
        self.activate(origin=12)
        self.tick()
        self.assertEqual(self.results[0]["sourceEpoch"]["startTimeBeats"], 12)
        self.call("release", reason="completed")
        self.assertTrue(self.song.is_playing)

    def test_capture_must_finish_strictly_before_wrap_or_natural_end(self):
        for looping, field in (
            (True, "loop_end"), (True, "end_marker"),
            (False, "loop_end"), (False, "end_marker"),
        ):
            with self.subTest(looping=looping, field=field):
                self.setUp()
                self.clip.looping = looping
                setattr(self.clip, field, self.params["durationBeats"])
                with self.assertRaises(ProtocolFailure) as failure:
                    self.call()
                self.assertIn("strictly before", failure.exception.message)
                self.assertEqual(self.params["durationBeats"], 4)
                self.assertEqual(self.fires, 0)
                self.assert_no_monitors()

    def test_capability_requires_real_monitor_primitives_and_simulator_refuses(self):
        self.assertTrue(session_listening_pass_supported(self.song))
        registry = CommandRegistry()
        register_session_listening_pass(registry)
        application = types.SimpleNamespace(get_version_string=lambda: "11.3.43")
        with patch("AbletonAgent.capabilities.build_live_identity", return_value={"liveSetId": "set"}):
            document = build_capability_document(application, self.song, registry)
        self.assertTrue(document["capabilities"]["listening.prepare_session_pass"])
        self.clip.add_playing_status_listener = None
        self.assertFalse(session_listening_pass_supported(self.song))
        result = handle({
            "kind": "request", "requestId": OWNER,
            "command": "listening.prepare_session_pass", "params": self.params,
        }, "token", types.SimpleNamespace())
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        self.assertEqual(result["error"]["details"]["mutationState"], "not-attempted")

    def test_get_only_start_time_is_polled_without_claiming_notification_coverage(self):
        add = Mock(side_effect=RuntimeError("start_time is get-only"))
        remove = Mock(side_effect=RuntimeError("start_time is get-only"))
        self.clip.add_start_time_listener, self.clip.remove_start_time_listener = add, remove
        self.assertTrue(session_listening_pass_supported(self.song))
        prepared = self.call()
        self.assertIn("Clip.start_time is polled", prepared["limitations"][0])
        self.assertIn("changes between observations may be missed", prepared["limitations"][0])
        self.assertNotIn("start_time", self.clip.callbacks)
        self.launch()
        self.activate()
        self.tick()
        self.assertEqual(self.results[0]["sourceEpoch"]["startTimeBeats"], 16)
        self.clip.start_time = 20
        self.tick()
        invalid = self.call("inspect")
        self.assertEqual(invalid["status"], "invalidated")
        self.assertEqual(invalid["sourceEpoch"]["startTimeBeats"], 16)
        self.assertEqual(invalid["lastObservedSource"]["startTimeBeats"], 20)
        self.assertEqual(invalid["nativeAlignment"], "unverified")
        self.call("release", reason="cancelled")
        add.assert_not_called()
        remove.assert_not_called()
        self.assertTrue(self.song.is_playing)
        self.assert_no_monitors()

    def test_explicit_inspect_detects_polled_epoch_change_without_any_source_callback(self):
        self.call()
        self.launch()
        self.activate()
        self.tick()
        self.clip.start_time = 20
        self.assertEqual(self.call("inspect")["status"], "invalidated")
        self.assertTrue(self.song.is_playing)

    def test_origin_becoming_unreadable_invalidates_without_discarding_actual_origin_ledger(self):
        self.call()
        self.launch()
        self.activate()
        self.tick()
        self.clip.start_time = None
        self.tick()
        result = self.call("inspect")
        self.assertEqual(result["status"], "invalidated")
        self.assertEqual(result["sourceEpoch"]["startTimeBeats"], 16)
        self.assertIsNone(result["lastObservedSource"]["startTimeBeats"])
        self.assertTrue(self.song.is_playing)
        self.call("release", reason="cancelled")
        self.assert_no_monitors()

    def test_unreadable_origin_and_missing_real_listener_infrastructure_still_refuse(self):
        for field in ("playing_status", "playing_position"):
            with self.subTest(field=field):
                self.setUp()
                setattr(self.clip, "add_" + field + "_listener", None)
                self.assertFalse(session_listening_pass_supported(self.song))
                self.assert_denied()
        self.setUp()
        self.clip.start_time = None
        self.assert_denied()

    def test_public_global_enum_admits_shifted_native_value_but_raw_one_bar_does_not(self):
        enum = source_fixtures.native_launch_enum(q_global=5, q_bar=0)
        with patch.object(source_module, "ClipLaunchQuantization", enum):
            self.clip.launch_quantization = 5
            self.assertEqual(self.call()["status"], "prepared")
            self.call("release", reason="cancelled")
        self.setUp()
        with patch.object(source_module, "ClipLaunchQuantization", enum):
            self.clip.launch_quantization = 0
            self.assert_denied()
        self.setUp()
        with patch.object(source_module, "ClipLaunchQuantization", None):
            self.assert_denied()

    def test_strict_schema_and_mutation_registration(self):
        registry = CommandRegistry()
        register_session_listening_pass(registry)
        self.assertNotIn("listening.session_pass", registry.metadata())
        for action in ("prepare", "launch", "inspect", "release"):
            command = registry.get("listening." + action + "_session_pass")
            self.assertIsNotNone(command)
            self.assertEqual(command.mutates, action == "launch")
            self.assertIsNotNone(command.validator({
                "schemaVersion": 1, "action": "launch" if action != "launch" else "inspect",
                "ownerId": OWNER, "passId": PASS,
            }))
        for change in (
            {"durationBeats": 5}, {"durationBeats": 0}, {"durationBeats": True},
            {"ownerId": "owner"}, {"audio": "body"}, {"nativeAlignment": "verified"},
            {"target": {**self.target, "view": "arrangement"}},
        ):
            self.assertIsNotNone(validate_session_listening_pass({**self.params, **change}))
        self.assertIsNone(validate_session_listening_pass(copy.deepcopy(self.params)))

    def test_executor_observational_actions_never_advance_project_revision(self):
        registry = CommandRegistry()
        register_session_listening_pass(registry)
        executor = MainThreadExecutor(self.context.schedule_message, registry, self.context)
        self.params["expectedLiveSetId"] = build_live_identity(self.song)["liveSetId"]
        responses = []
        for action in ["prepare"] + ["inspect"] * 10 + ["release"]:
            params = self.params if action == "prepare" else {
                "schemaVersion": 1, "action": action, "ownerId": OWNER, "passId": PASS,
                **({"reason": "cancelled"} if action == "release" else {}),
            }
            executor.submit({
                "requestId": OWNER, "command": "listening." + action + "_session_pass",
                "params": params,
            }, responses.append)
            executor.drain()
        self.assertEqual(len(responses), 12)
        self.assertTrue(all(response["ok"] for response in responses))
        self.assertEqual(self.context.project_revision, 5)
        self.assertEqual({response["projectRevision"] for response in responses}, {5})
        self.assertEqual(self.fires, 0)
        self.assert_no_monitors()

    def test_launch_does_not_waive_unrelated_revision_change_after_prepare(self):
        self.call()
        self.context.project_revision += 1
        self.launch()
        self.assertEqual(self.fires, 0)
        self.assertEqual(self.errors[0].code, "conflict")
        self.assertEqual(self.errors[0].details["mutationState"], "not-attempted")

    def test_generated_granular_requests_validate_and_round_trip_without_audio_bodies(self):
        path = Path(__file__).resolve().parents[2] / "packages/protocol/contracts/command-fixtures.json"
        fixtures = json.loads(path.read_text(encoding="utf-8"))["commands"]
        registry = CommandRegistry()
        register_session_listening_pass(registry)
        for action in ("prepare", "launch", "inspect", "release"):
            name = "listening." + action + "_session_pass"
            with self.subTest(command=name):
                messages = fixtures[name]
                self.assertIsNone(registry.get(name).validator(messages["request"]["params"]))
                self.assertEqual(registry.get(name).mutates, action == "launch")
                for phase in ("request", "success", "failure"):
                    message = messages[phase]
                    self.assertEqual(FrameDecoder().push(encode_frame(message)), [message])
                    self.assertNotIn("audio", message.get("params", {}))
                    self.assertNotIn("audio", message.get("result", {}))
