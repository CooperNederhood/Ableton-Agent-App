import json
import sys
import unittest
import uuid
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.device_commands import (  # noqa: E402
    _device_reference,
    _parameter_reference,
)
from AbletonAgent.capabilities import build_capability_document  # noqa: E402
from AbletonAgent.event_subscriptions import (  # noqa: E402
    PARAMETER_COALESCE_TICKS,
    LomSubscriptionManager,
    playing_clip_state,
    recording_state,
    register_event_commands,
    triggered_clip_state,
)
from AbletonAgent.identity import build_project_identity  # noqa: E402
from AbletonAgent.registry import CommandRegistry  # noqa: E402
from AbletonAgent.system_commands import _track_reference  # noqa: E402
from simulator import SimulatorState, handle  # noqa: E402


class Listenable(object):
    def __init__(self, properties):
        self._listeners = dict((name, []) for name in properties)
        for name in properties:
            setattr(self, "add_{0}_listener".format(name), self._add(name))
            setattr(self, "remove_{0}_listener".format(name), self._remove(name))

    def _add(self, name):
        return lambda callback: self._listeners[name].append(callback)

    def _remove(self, name):
        return lambda callback: self._listeners[name].remove(callback)

    def emit(self, name):
        for callback in list(self._listeners[name]):
            callback()

    def listener_count(self):
        return sum(len(value) for value in self._listeners.values())


class Parameter(Listenable):
    def __init__(self, name, value=0.25):
        Listenable.__init__(self, ("value",))
        self.name = name
        self.min = 0.0
        self.max = 1.0
        self.value = value
        self.is_quantized = False

    def str_for_value(self, value):
        return "{0:.0f}%".format(value * 100)


class Device(object):
    def __init__(self, parameter):
        self.name = "Operator"
        self.parameters = [parameter]


class Clip(Listenable):
    def __init__(self, name):
        Listenable.__init__(self, ("is_recording",))
        self.name = name
        self.is_recording = False


class Slot(object):
    def __init__(self, clip=None):
        self.clip = clip
        self.has_clip = clip is not None


class Track(Listenable):
    def __init__(self, device):
        Listenable.__init__(
            self, ("playing_slot_index", "fired_slot_index", "arm")
        )
        self.name = "Bass"
        self.color = 0x123456
        self.is_foldable = False
        self.devices = [device]
        self.playing_slot_index = -1
        self.fired_slot_index = -1
        self.arm = False
        self.clip_slots = [Slot(Clip("Verse")), Slot()]


class View(object):
    pass


class Song(Listenable):
    def __init__(self, track):
        Listenable.__init__(self, ("tracks", "record_mode"))
        self.file_path = "/example/Event Test.als"
        self.name = "Event Test"
        self.tracks = [track]
        self.record_mode = False
        self.view = View()
        self.view.selected_track = track
        self.view.selected_parameter = track.devices[0].parameters[0]


class Context(object):
    def __init__(self):
        parameter = Parameter("Filter")
        self.song = Song(Track(Device(parameter)))
        self.project_revision = 7
        self.scheduled = []

    def schedule_message(self, delay, callback):
        self.scheduled.append((delay, callback))


def event_id(suffix):
    return "live-event.00000000-0000-4000-8000-{0:012d}".format(suffix)


class DynamicSubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.context = Context()
        self.published = []
        self.manager = LomSubscriptionManager(
            self.context,
            lambda name, payload, revision=None: self.published.append(
                (name, payload, revision)
            ),
        )

    def params(self, kind, suffix=1):
        track = self.context.song.tracks[0]
        result = {
            "eventId": event_id(suffix),
            "kind": kind,
            "projectId": build_project_identity(self.context.song)["projectId"],
            "index": 0,
            "expectedReference": _track_reference(self.context, track),
            "expectedName": track.name,
        }
        if kind == "parameter.value_changed":
            device = track.devices[0]
            parameter = device.parameters[0]
            result.update({
                "deviceIndex": 0,
                "expectedDeviceReference": _device_reference(
                    self.context, device
                ),
                "expectedDeviceName": device.name,
                "parameterIndex": 0,
                "expectedParameterReference": _parameter_reference(
                    self.context, parameter
                ),
                "expectedParameterName": parameter.name,
            })
        return result

    def test_registers_validated_commands_and_inspects_selection(self):
        registry = CommandRegistry()
        register_event_commands(registry, self.manager)
        self.assertEqual(
            sorted(registry.metadata().keys()),
            [
                "events.clear_subscriptions",
                "events.inspect_selection",
                "events.list_subscriptions",
                "events.subscribe",
                "events.unsubscribe",
            ],
        )
        selection = self.manager.inspect_selection()
        self.assertEqual(selection["track"]["expectedName"], "Bass")
        self.assertEqual(
            selection["parameter"]["expectedParameterName"], "Filter"
        )
        application = type(
            "Application",
            (),
            {"get_version_string": lambda _self: "12.1-test"},
        )()
        capabilities = build_capability_document(
            application, self.context.song, registry
        )["capabilities"]
        self.assertTrue(capabilities["events.parameter.value_changed"])
        self.assertTrue(
            capabilities["events.track.playing_clip_changed"]
        )
        self.assertTrue(
            capabilities["events.track.triggered_clip_changed"]
        )
        self.assertTrue(
            capabilities["events.track.recording_state_changed"]
        )

    def test_typescript_event_command_fixtures_match_python_validation(self):
        fixture_path = (
            REMOTE_SCRIPT_ROOT.parent
            / "packages"
            / "protocol"
            / "contracts"
            / "command-fixtures.json"
        )
        fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
        registry = CommandRegistry()
        register_event_commands(registry, self.manager)
        for name in (
            "events.inspect_selection",
            "events.subscribe",
            "events.unsubscribe",
            "events.list_subscriptions",
            "events.clear_subscriptions",
        ):
            params = fixtures["commands"][name]["request"]["params"]
            self.assertIsNone(registry.get(name).validator(params), name)

    def test_parameter_initial_state_coalescing_delta_and_cleanup(self):
        params = self.params("parameter.value_changed")
        params["observationPolicy"] = {
            "minimumNormalizedDelta": 0.01,
            "throttleMs": 0,
        }
        result = self.manager.subscribe(params)
        parameter = self.context.song.tracks[0].devices[0].parameters[0]
        self.assertEqual(result["initialState"]["state"]["displayValue"], "25%")
        self.assertEqual(parameter.listener_count(), 1)

        parameter.value = 0.255
        parameter.emit("value")
        parameter.value = 0.75
        parameter.emit("value")
        self.assertEqual(len(self.context.scheduled), 1)
        self.assertEqual(self.context.scheduled[0][0], PARAMETER_COALESCE_TICKS)
        self.context.scheduled.pop()[1]()

        self.assertEqual(len(self.published), 1)
        occurrence = self.published[0][1]
        self.assertEqual(occurrence["previous"]["value"], 0.25)
        self.assertEqual(occurrence["current"]["value"], 0.75)
        self.assertEqual(occurrence["current"]["displayValue"], "75%")

        self.manager.unsubscribe(params["eventId"])
        self.assertEqual(parameter.listener_count(), 0)
        self.assertEqual(self.context.song.listener_count(), 0)

    def test_discrete_translation_deduplication_and_invalidation(self):
        params = self.params("track.playing_clip_changed")
        self.manager.subscribe(params)
        track = self.context.song.tracks[0]
        track.emit("playing_slot_index")
        self.assertEqual(self.published, [])

        track.playing_slot_index = -2
        track.emit("playing_slot_index")
        track.playing_slot_index = 0
        track.emit("playing_slot_index")
        self.assertEqual(
            [item[1]["current"]["state"] for item in self.published],
            ["arrangement", "session-clip"],
        )
        self.assertEqual(self.published[-1][1]["current"]["clipName"], "Verse")

        self.context.song.tracks = []
        self.context.song.emit("tracks")
        self.assertEqual(self.published[-1][0], "live_event.invalidated")
        self.assertEqual(
            self.published[-1][1]["reason"], "target-deleted"
        )
        self.assertEqual(self.manager.list_subscriptions()["subscriptions"], [])
        self.assertEqual(track.listener_count(), 0)

    def test_triggered_and_recording_state_composition(self):
        track = self.context.song.tracks[0]
        track.fired_slot_index = -2
        self.assertEqual(triggered_clip_state(track), {"state": "stop"})
        track.fired_slot_index = 0
        self.assertEqual(
            triggered_clip_state(track)["state"], "session-clip"
        )
        track.playing_slot_index = -2
        track.arm = True
        self.context.song.record_mode = True
        self.assertEqual(
            recording_state(self.context.song, track),
            {"recording": True, "source": "arrangement"},
        )
        self.assertEqual(
            playing_clip_state(track), {"state": "arrangement"}
        )

        params = self.params("track.recording_state_changed", suffix=2)
        result = self.manager.subscribe(params)
        self.assertTrue(result["initialState"]["state"]["recording"])
        self.context.song.record_mode = False
        self.context.song.emit("record_mode")
        self.assertFalse(self.published[-1][1]["current"]["recording"])

        self.manager.clear(publish_invalidation=True)
        self.assertEqual(self.published[-1][0], "live_event.invalidated")
        self.assertEqual(
            self.published[-1][1]["reason"], "subscription-cleared"
        )
        self.assertEqual(track.listener_count(), 0)
        self.assertEqual(self.context.song.listener_count(), 0)

    def test_rejects_stale_exact_identity(self):
        params = self.params("track.triggered_clip_changed")
        params["expectedName"] = "Wrong"
        with self.assertRaises(Exception) as raised:
            self.manager.subscribe(params)
        self.assertEqual(raised.exception.code, "stale_reference")


class SimulatorSubscriptionTests(unittest.TestCase):
    def test_parameter_subscription_produces_deterministic_occurrence(self):
        state = SimulatorState()
        track = state.tracks[0]
        device = track["devices"][0]
        parameter = device["parameters"][1]
        subscribe = {
            "protocolVersion": 1,
            "kind": "request",
            "requestId": str(uuid.uuid4()),
            "command": "events.subscribe",
            "params": {
                "eventId": event_id(9),
                "kind": "parameter.value_changed",
                "projectId": "simulated-project",
                "index": 0,
                "expectedReference": track["reference"],
                "expectedName": track["name"],
                "deviceIndex": 0,
                "expectedDeviceReference": device["reference"],
                "expectedDeviceName": device["name"],
                "parameterIndex": 1,
                "expectedParameterReference": parameter["reference"],
                "expectedParameterName": parameter["name"],
            },
        }
        result = handle(subscribe, "token", state)
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["initialState"]["state"]["value"], 0.5)

        mutate = {
            "protocolVersion": 1,
            "kind": "request",
            "requestId": str(uuid.uuid4()),
            "command": "devices.set_parameter",
            "params": {
                "index": 0,
                "expectedReference": track["reference"],
                "expectedName": track["name"],
                "deviceIndex": 0,
                "expectedDeviceReference": device["reference"],
                "expectedDeviceName": device["name"],
                "parameterIndex": 1,
                "expectedParameterReference": parameter["reference"],
                "expectedParameterName": parameter["name"],
                "normalizedValue": 0.75,
            },
        }
        self.assertTrue(handle(mutate, "token", state)["ok"])
        occurrence = state.live_event_messages.popleft()
        self.assertEqual(occurrence["event"], "live_event.occurred")
        self.assertEqual(occurrence["payload"]["sequence"], 0)
        self.assertEqual(occurrence["payload"]["current"]["value"], 0.75)
        self.assertEqual(
            occurrence["payload"]["occurrenceId"],
            str(uuid.uuid5(uuid.NAMESPACE_URL, "{0}:0".format(event_id(9)))),
        )


if __name__ == "__main__":
    unittest.main()
