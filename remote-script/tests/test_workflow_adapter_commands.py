from __future__ import absolute_import, unicode_literals

import types
import unittest
import uuid

from AbletonAgent.core_domain_commands import (
    _clip_reference as _core_clip_reference,
    _scene_reference,
    _track_reference,
)
from AbletonAgent.device_commands import _device_reference
from AbletonAgent.system_commands import (
    _clip_reference as _legacy_clip_reference,
    _track_reference as _legacy_track_reference,
)
from AbletonAgent.workflow_adapter_commands import (
    GLOBAL_HISTORY_WARNING,
    WorkflowJobManager,
    execute_browser_adapters,
    execute_history,
    execute_jobs,
    execute_recording,
    execute_selection_view,
    execute_special_devices,
    register_workflow_adapter_commands,
)


class FakeSlot(object):
    def __init__(self):
        self.has_clip = False
        self.clip = None
        self.stopped = False

    def fire(self, record_length=None, launch_quantization=None):
        del launch_quantization
        self.clip = types.SimpleNamespace(
            name="Recorded Clip",
            length=record_length,
            is_midi_clip=True,
            is_recording=True,
        )
        self.has_clip = True

    def stop(self):
        self.stopped = True


class FakeTrack(object):
    def __init__(self):
        self.name = "MIDI"
        self.can_be_armed = True
        self.arm = True
        self.clip_slots = [FakeSlot()]
        self.arrangement_clips = []
        self.fold_state = False


class FakeSong(object):
    def __init__(self):
        self.record_mode = False
        self.session_record = False
        self.overdub = False
        self.session_automation_record = False
        self.punch_in = False
        self.punch_out = False
        self.tempo = 120.0
        self.can_undo = True
        self.can_redo = False
        self.tracks = [FakeTrack()]
        self.return_tracks = []
        self.master_track = types.SimpleNamespace(name="Master")
        self.scenes = [types.SimpleNamespace(name="Scene 1")]
        self.view = types.SimpleNamespace(
            selected_track=None,
            selected_scene=None,
            highlighted_clip_slot=None,
            detail_clip=None,
            selected_device=None,
        )

    def undo(self):
        self.can_undo = False
        self.can_redo = True

    def redo(self):
        self.can_undo = True
        self.can_redo = False


class FakeContext(object):
    def __init__(self):
        self.song = FakeSong()
        self.project_revision = 0
        self.callbacks = []
        self.events = []
        self.application = types.SimpleNamespace(view=None)

    def schedule_message(self, _ticks, callback):
        self.callbacks.append(callback)

    def publish_event(self, name, payload, revision=None):
        self.events.append((name, payload, revision))


class WorkflowAdapterCommandsTest(unittest.TestCase):
    def test_core_and_legacy_commands_share_track_and_clip_references(self):
        context = FakeContext()
        track = context.song.tracks[0]
        clip = types.SimpleNamespace(name="Clip")
        track.clip_slots[0].clip = clip
        track.clip_slots[0].has_clip = True

        self.assertEqual(
            _legacy_track_reference(context, track),
            _track_reference(context, track),
        )
        self.assertEqual(
            _legacy_clip_reference(context, clip),
            _core_clip_reference(context, clip),
        )

    def test_recording_mutation_verifies_complete_state(self):
        context = FakeContext()
        result = execute_recording(
            context, {"action": "set-arrangement-record", "enabled": True}
        )
        self.assertTrue(result["result"]["verified"])
        self.assertFalse(result["result"]["before"]["arrangementRecord"])
        self.assertTrue(result["result"]["after"]["arrangementRecord"])

    def test_global_history_requires_confirmation_and_warns(self):
        context = FakeContext()
        result = execute_history(
            context,
            {"action": "undo", "confirmation": "global-live-history"},
        )
        self.assertEqual([GLOBAL_HISTORY_WARNING], result["warnings"])
        self.assertTrue(result["verified"])
        self.assertTrue(result["after"]["canRedo"])

    def test_timed_recording_job_preserves_lifecycle_and_trace(self):
        context = FakeContext()
        track = context.song.tracks[0]
        target = {
            "kind": "regular",
            "index": 0,
            "expectedReference": _track_reference(context, track),
            "expectedName": track.name,
        }
        scene = context.song.scenes[0]
        correlation_id = str(uuid.uuid4())
        trace_id = str(uuid.uuid4())
        result = execute_recording(
            context,
            {
                "action": "record-session-slot",
                "target": {
                    "track": target,
                    "sceneIndex": 0,
                    "expectedSceneReference": _scene_reference(context, scene),
                    "expectedSceneName": scene.name,
                    "expectedHasClip": False,
                },
                "durationBeats": 4.0,
                "runtimeContext": {
                    "ownerId": "agent-a",
                    "correlationId": correlation_id,
                    "traceId": trace_id,
                    "trackReferences": [target["expectedReference"]],
                },
            },
        )
        self.assertEqual("running", result["job"]["status"])
        self.assertEqual(correlation_id, result["job"]["correlationId"])
        self.assertEqual(trace_id, result["job"]["traceId"])
        self.assertEqual(
            ["workflow_job.queued", "workflow_job.started", "workflow_job.progress"],
            [event[0] for event in context.events],
        )
        context.callbacks.pop()()
        self.assertEqual(
            "running",
            context._workflow_job_manager.get(result["job"]["jobId"])["status"],
        )
        context.song.tracks[0].clip_slots[0].clip.is_recording = False
        context.callbacks.pop()()
        self.assertEqual("workflow_job.completed", context.events[-1][0])
        self.assertNotIn("result", context.events[-1][1])
        self.assertNotIn("causationId", context.events[-1][1])

    def test_session_slot_rejects_stale_scene_identity(self):
        context = FakeContext()
        track = context.song.tracks[0]
        with self.assertRaisesRegex(Exception, "Scene identity changed"):
            execute_recording(
                context,
                {
                    "action": "record-session-slot",
                    "target": {
                        "track": {
                            "kind": "regular",
                            "index": 0,
                            "expectedReference": _track_reference(context, track),
                            "expectedName": track.name,
                        },
                        "sceneIndex": 0,
                        "expectedSceneReference": str(uuid.uuid4()),
                        "expectedSceneName": "Scene 1",
                        "expectedHasClip": False,
                    },
                    "durationBeats": 4.0,
                    "runtimeContext": {
                        "ownerId": "agent-a",
                        "correlationId": str(uuid.uuid4()),
                        "traceId": str(uuid.uuid4()),
                        "trackReferences": [
                            _track_reference(context, track)
                        ],
                    },
                },
            )

    def test_job_cancellation_is_terminal_and_bounded(self):
        context = FakeContext()
        manager = WorkflowJobManager(context)
        job = manager.create(
            "timed-session-recording",
            {
                "ownerId": "agent-a",
                "correlationId": str(uuid.uuid4()),
                "traceId": str(uuid.uuid4()),
                "trackReferences": [str(uuid.uuid4())],
            },
        )
        manager.update(job["jobId"], "running", 0.5)
        with self.assertRaisesRegex(Exception, "originating agent"):
            manager.cancel(job["jobId"], "agent-b")
        cancelled, changed = manager.cancel(job["jobId"], "agent-a")
        self.assertTrue(changed)
        self.assertEqual("cancelled", cancelled["status"])
        self.assertEqual("workflow_job.cancelled", context.events[-1][0])
        with self.assertRaisesRegex(Exception, "terminal state"):
            manager.update(job["jobId"], "running", 0.75)

    def test_looper_export_cancellation_prevents_scheduled_export(self):
        context = FakeContext()
        track = context.song.tracks[0]
        scene = context.song.scenes[0]
        exported_slots = []

        class FakeLooper(object):
            name = "Looper"
            class_name = "Looper"
            parameters = ()

            def export_to_clip(self, slot):
                exported_slots.append(slot)

        device = FakeLooper()
        track.devices = [device]
        result = execute_special_devices(
            context,
            {
                "action": "export-looper",
                "target": {
                    "track": {
                        "kind": "regular",
                        "index": 0,
                        "expectedReference": _track_reference(context, track),
                        "expectedName": track.name,
                    },
                    "deviceIndex": 0,
                    "expectedDeviceReference": _device_reference(context, device),
                    "expectedDeviceName": device.name,
                    "expectedClassName": device.class_name,
                },
                "destination": {
                    "track": {
                        "kind": "regular",
                        "index": 0,
                        "expectedReference": _track_reference(context, track),
                        "expectedName": track.name,
                    },
                    "sceneIndex": 0,
                    "expectedSceneReference": _scene_reference(context, scene),
                    "expectedSceneName": scene.name,
                    "expectedHasClip": False,
                },
                "runtimeContext": {
                    "ownerId": "agent-a",
                    "correlationId": str(uuid.uuid4()),
                    "traceId": str(uuid.uuid4()),
                    "trackReferences": [
                        _track_reference(context, track)
                    ],
                },
            },
        )
        job_id = result["job"]["jobId"]

        with self.assertRaisesRegex(Exception, "originating agent"):
            execute_jobs(
                context,
                {
                    "action": "cancel",
                    "jobId": job_id,
                    "runtimeContext": {"ownerId": "agent-b"},
                },
            )
        cancelled = execute_jobs(
            context,
            {
                "action": "cancel",
                "jobId": job_id,
                "runtimeContext": {"ownerId": "agent-a"},
            },
        )
        context.callbacks[0]()

        self.assertEqual("cancelled", cancelled["job"]["status"])
        self.assertEqual([], exported_slots)
        self.assertEqual(
            "cancelled",
            context._workflow_job_manager.get(job_id)["status"],
        )

    def test_browser_restores_explicit_null_state_and_verifies_it(self):
        context = FakeContext()

        class Browser(object):
            def __init__(self):
                self.is_previewing = False
                self.hotswap_target = None
                self.filter_type = None

            def stop_preview(self):
                self.hotswap_target = object()
                self.filter_type = 3
                context.song.view.selected_device = object()

        browser = Browser()
        context.application = types.SimpleNamespace(
            browser=browser,
            view=types.SimpleNamespace(device_insert_mode=None),
        )
        result = execute_browser_adapters(context, {"action": "stop-preview"})

        self.assertIsNone(browser.hotswap_target)
        self.assertIsNone(browser.filter_type)
        self.assertIsNone(context.application.view.device_insert_mode)
        self.assertIsNone(context.song.view.selected_device)
        self.assertTrue(result["after"]["selectionRestored"])
        self.assertTrue(result["verified"])

    def test_registry_rejects_actions_on_the_wrong_route(self):
        commands = {}

        class Registry(object):
            def register(self, name, handler, **options):
                commands[name] = (handler, options)

        register_workflow_adapter_commands(Registry())
        inspect_validator = commands["recording.inspect"][1]["validator"]
        mutate_validator = commands["recording.set_arrangement_record"][1][
            "validator"
        ]
        self.assertIsNone(inspect_validator({"action": "inspect"}))
        self.assertIsNotNone(
            inspect_validator({"action": "set-arrangement-record", "enabled": True})
        )
        self.assertIsNone(
            mutate_validator({"action": "set-arrangement-record", "enabled": True})
        )
        self.assertIsNotNone(mutate_validator({"action": "inspect"}))

    def test_track_fold_uses_property_specific_readback(self):
        context = FakeContext()
        track = context.song.tracks[0]
        result = execute_selection_view(
            context,
            {
                "action": "set-track-fold",
                "target": {
                    "kind": "regular",
                    "index": 0,
                    "expectedReference": _track_reference(context, track),
                    "expectedName": "MIDI",
                },
                "folded": True,
            },
        )
        self.assertEqual(False, result["before"])
        self.assertEqual(True, result["after"])
        self.assertTrue(result["verified"])


if __name__ == "__main__":
    unittest.main()
