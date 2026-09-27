import copy
import sys
import time
import types
import unittest
import uuid
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

import AbletonAgent.capabilities as capability_module  # noqa: E402
from AbletonAgent.capabilities import build_capability_document  # noqa: E402
from AbletonAgent.core_domain_commands import (  # noqa: E402
    ROUTING_SNAPSHOT_LIMIT,
    ROUTING_SNAPSHOT_SECONDS,
)
from AbletonAgent.executor import MainThreadExecutor  # noqa: E402
from AbletonAgent.registry import CommandRegistry  # noqa: E402
from AbletonAgent.system_commands import register_system_commands  # noqa: E402
from simulator import SimulatorState, handle  # noqa: E402
from test_runtime import (  # noqa: E402
    FakeApplication,
    FakeClip,
    FakeContext,
    FakeMidiNoteSpecification,
    FakeMixerDevice,
    FakeParameter,
    FakeTrack,
    request,
)


class CoreScene(object):
    def __init__(self, name):
        self.name = name
        self.color_index = 1
        self.tempo = 120.0
        self.tempo_enabled = False
        self.time_signature_numerator = 4
        self.time_signature_denominator = 4
        self.time_signature_enabled = False
        self.is_triggered = False

    def fire(self):
        self.is_triggered = True


class RoutingOption(object):
    def __init__(self, display_name):
        self.display_name = display_name


class CoreMidiClip(FakeClip):
    def apply_note_modifications(self, notes):
        by_id = dict((note.note_id, note) for note in self.notes)
        for note in notes:
            existing = by_id[note.note_id]
            for attribute in (
                "pitch",
                "start_time",
                "duration",
                "velocity",
                "mute",
                "probability",
                "velocity_deviation",
                "release_velocity",
            ):
                setattr(existing, attribute, getattr(note, attribute))


class WarpMarker(object):
    def __init__(self, beat_time, sample_time):
        self.beat_time = beat_time
        self.sample_time = sample_time


class CoreClipApi(object):
    is_midi_clip = None
    name = None
    length = None
    gain = None
    pitch_coarse = None
    pitch_fine = None
    warping = None
    warp_mode = None
    available_warp_modes = None
    start_marker = None
    end_marker = None
    loop_start = None
    loop_end = None
    looping = None
    ram_mode = None
    warp_markers = None

    def get_all_notes_extended(self):
        return ()

    def add_new_notes(self, _notes):
        return ()

    def apply_note_modifications(self, _notes):
        return None

    def remove_notes_by_id(self, _note_ids):
        return None


class CoreCuePointApi(object):
    name = None
    time = None

    def jump(self):
        return None


class CoreAudioClip(FakeClip):
    def __init__(self):
        super(CoreAudioClip, self).__init__(8.0, midi=False)
        self.name = "Audio"
        self.gain = 0.5
        self.pitch_coarse = 0
        self.pitch_fine = 0
        self.warping = True
        self.warp_mode = 2
        self.available_warp_modes = (0, 1, 2, 3, 4, 6)
        self.start_marker = 0.0
        self.end_marker = 8.0
        self.loop_start = 0.0
        self.loop_end = 8.0
        self.ram_mode = False
        self.file_path = "/samples/test.wav"
        self.sample_length = 384000
        self.sample_rate = 48000
        self.warp_markers = [WarpMarker(0.0, 0.0), WarpMarker(4.0, 2.0)]


class RangeCheckedAudioClip(CoreAudioClip):
    def __init__(self):
        self.assignments = []
        self.fail_after_assignment = None
        super(RangeCheckedAudioClip, self).__init__()
        self.assignments = []

    def _set_bound(self, name, value, other_name, lower):
        other = getattr(self, other_name, None)
        if other is not None:
            valid = value < other if lower else value > other
            if not valid:
                raise RuntimeError("invalid range assignment")
        setattr(self, "_" + name, value)
        self.assignments.append(name)
        if self.fail_after_assignment == name:
            self.fail_after_assignment = None
            raise RuntimeError("setter failed after assignment")

    @property
    def start_marker(self):
        return getattr(self, "_start_marker", None)

    @start_marker.setter
    def start_marker(self, value):
        self._set_bound("start_marker", value, "_end_marker", True)

    @property
    def end_marker(self):
        return getattr(self, "_end_marker", None)

    @end_marker.setter
    def end_marker(self, value):
        self._set_bound("end_marker", value, "_start_marker", False)

    @property
    def loop_start(self):
        return getattr(self, "_loop_start", None)

    @loop_start.setter
    def loop_start(self, value):
        self._set_bound("loop_start", value, "_loop_end", True)

    @property
    def loop_end(self):
        return getattr(self, "_loop_end", None)

    @loop_end.setter
    def loop_end(self, value):
        self._set_bound("loop_end", value, "_loop_start", False)


class IndeterminateRemovalClip(CoreMidiClip):
    def __init__(self, length):
        super(IndeterminateRemovalClip, self).__init__(length)
        self.fail_reads = False

    def get_all_notes_extended(self):
        if self.fail_reads:
            raise RuntimeError("note verification unavailable")
        return super(IndeterminateRemovalClip, self).get_all_notes_extended()

    def remove_notes_by_id(self, note_ids):
        selected = set(note_ids)
        self.notes = [
            note for note in self.notes if note.note_id not in selected
        ]
        self.fail_reads = True
        raise RuntimeError("remove failed after applying")


def target(summary):
    value = {
        "kind": summary["kind"],
        "expectedReference": summary["reference"],
        "expectedName": summary["name"],
    }
    if summary["index"] is not None:
        value["index"] = summary["index"]
    return value


def split_command(command, action):
    if not command.endswith(".execute"):
        return command
    domain = command[:-8]
    inspect_actions = {
        "scenes": ("list", "get"),
        "tracks": ("list", "get"),
        "mixer_routing": ("inspect", "meters", "routing-options"),
        "transport": ("get",),
        "midi_notes": ("query",),
        "audio_clips": ("inspect", "warp-markers"),
    }
    suffix = "inspect" if action in inspect_actions[domain] else "mutate"
    return "{0}.{1}".format(domain, suffix)


class CoreDomainCommandTests(unittest.TestCase):
    def setUp(self):
        self.context = FakeContext()
        self.context.project_revision = 9
        song = self.context.song
        song.scenes = [CoreScene("Intro"), CoreScene("Verse")]
        song.return_tracks = [FakeTrack("Return A", midi=False)]
        song.master_track = FakeTrack("Master", midi=False)
        song.metronome = False
        song.clip_trigger_quantization = 4
        song.midi_recording_quantization = 4
        song.is_ableton_link_enabled = False
        song.back_to_arranger = True
        song.jump_by = types.MethodType(
            lambda current, beats: setattr(
                current,
                "current_song_time",
                max(0.0, current.current_song_time + beats),
            ),
            song,
        )
        song.create_scene = types.MethodType(self._create_scene, song)
        song.duplicate_scene = types.MethodType(self._duplicate_scene, song)
        song.delete_scene = types.MethodType(
            lambda current, index: current.scenes.pop(index), song
        )
        song.create_return_track = types.MethodType(
            self._create_return_track, song
        )
        song.delete_return_track = types.MethodType(
            lambda current, index: current.return_tracks.pop(index), song
        )
        song.duplicate_track = types.MethodType(self._duplicate_track, song)
        for track in song.tracks + song.return_tracks + [song.master_track]:
            self._prepare_track(track)
        midi_clip = CoreMidiClip(8.0)
        midi_clip.name = "MIDI"
        midi_clip.notes = [
            FakeMidiNoteSpecification(
                pitch=60,
                start_time=0.3,
                duration=1.0,
                velocity=0.5,
                mute=False,
                probability=0.7,
                velocity_deviation=-3.25,
                release_velocity=72.5,
            )
        ]
        midi_clip.notes[0].note_id = 10
        song.tracks[0].clip_slots[0].clip = midi_clip
        song.tracks[1].has_midi_input = False
        song.tracks[1].clip_slots[0].clip = CoreAudioClip()
        self.registry = CommandRegistry()
        register_system_commands(self.registry)

    def _create_scene(self, song, index):
        actual = len(song.scenes) if index == -1 else index
        song.scenes.insert(actual, CoreScene("Scene"))

    def _duplicate_scene(self, song, index):
        duplicate = copy.copy(song.scenes[index])
        duplicate.name += " Copy"
        duplicate.is_triggered = False
        song.scenes.insert(index + 1, duplicate)

    def _create_return_track(self, song):
        track = FakeTrack("Return", midi=False)
        self._prepare_track(track)
        song.return_tracks.append(track)

    def _duplicate_track(self, song, index):
        track = FakeTrack(song.tracks[index].name + " Copy")
        self._prepare_track(track)
        song.tracks.insert(index + 1, track)

    def _prepare_track(self, track):
        if track.name == "Drums":
            track.is_foldable = True
        track.color_index = 10
        track.current_monitoring_state = 1
        track.fold_state = False
        track.back_to_arranger = True
        track.input_meter_left = 0.1
        track.input_meter_right = 0.2
        track.output_meter_left = 0.3
        track.output_meter_right = 0.4
        track.stop_all_clips = types.MethodType(
            lambda current, _quantized: setattr(
                current, "playing_slot_index", -1
            ),
            track,
        )
        track.mixer_device.sends = [
            FakeParameter(0.0, name="Send A")
        ]
        track.mixer_device.crossfade_assign = 1
        track.available_input_routing_types = [
            RoutingOption("All Ins"),
            RoutingOption("External MIDI"),
        ]
        track.input_routing_type = (
            track.available_input_routing_types[0]
        )
        track.available_input_routing_channels = [
            RoutingOption("All Channels")
        ]
        track.input_routing_channel = (
            track.available_input_routing_channels[0]
        )
        track.available_output_routing_types = [
            RoutingOption("Master"),
            RoutingOption(track.name),
        ]
        track.output_routing_type = (
            track.available_output_routing_types[0]
        )
        track.available_output_routing_channels = [
            RoutingOption("Track In")
        ]
        track.output_routing_channel = (
            track.available_output_routing_channels[0]
        )
        if track.name == "Master":
            track.mixer_device.crossfader = FakeParameter(
                0.5, name="Crossfader"
            )
            track.mixer_device.cue_volume = FakeParameter(
                0.5, name="Cue Volume"
            )

    def execute(self, command, params):
        command = split_command(command, params.get("action"))
        scheduled = []
        responses = []
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            self.registry,
            self.context,
        )
        executor.submit(request(command, params), responses.append)
        scheduled.pop(0)()
        while not responses and self.context.scheduled:
            _delay, callback = self.context.scheduled.pop(0)
            callback()
        return responses[0]

    def tracks(self):
        return self.execute(
            "tracks.execute", {"action": "list", "limit": 64}
        )["result"]["tracks"]

    def clip_target(self, track_summary, clip, view="session"):
        value = {
            "view": view,
            "track": target(track_summary),
            "expectedClipReference": self.execute(
                "midi_notes.execute"
                if clip.is_midi_clip
                else "audio_clips.execute",
                {
                    "action": "query"
                    if clip.is_midi_clip
                    else "inspect",
                    "target": {
                        "view": "session",
                        "track": target(track_summary),
                        "sceneIndex": 0,
                        "expectedClipReference": self._clip_reference(clip),
                        "expectedClipName": clip.name,
                    },
                },
            )["result"][
                "notes" if clip.is_midi_clip else "clip"
            ]
            and self._clip_reference(clip),
            "expectedClipName": clip.name,
        }
        value["sceneIndex"] = 0
        return value

    def _clip_reference(self, clip):
        command = self.registry.get("audio_clips.inspect")
        core = sys.modules[command.handler.__module__]
        return core._clip_reference(self.context, clip)

    def test_commands_are_registered_strict_and_keep_revision(self):
        for command in (
            "scenes.inspect",
            "scenes.mutate",
            "tracks.inspect",
            "tracks.mutate",
            "mixer_routing.inspect",
            "mixer_routing.mutate",
            "transport.inspect",
            "transport.mutate",
            "midi_notes.inspect",
            "midi_notes.mutate",
            "audio_clips.inspect",
            "audio_clips.mutate",
        ):
            self.assertIsNotNone(self.registry.get(command))
        for command in (
            "scenes.execute",
            "tracks.execute",
            "mixer_routing.execute",
            "transport.execute",
            "midi_notes.execute",
            "audio_clips.execute",
        ):
            self.assertIsNone(self.registry.get(command))
        result = self.execute(
            "scenes.execute", {"action": "list", "unexpected": True}
        )
        self.assertEqual(result["error"]["code"], "invalid_params")
        wrong_group = self.execute(
            "scenes.inspect",
            {"action": "create", "index": -1},
        )
        self.assertEqual(wrong_group["error"]["code"], "invalid_params")
        successful = self.execute("scenes.execute", {"action": "list"})
        self.assertEqual(successful["projectRevision"], 9)
        for domain in (
            "scenes",
            "tracks",
            "mixer_routing",
            "transport",
            "midi_notes",
            "audio_clips",
        ):
            self.assertFalse(
                self.registry.get(domain + ".inspect").mutates
            )
            self.assertTrue(
                self.registry.get(domain + ".mutate").mutates
            )

    def test_every_split_command_rejects_the_other_action_group(self):
        reference = str(uuid.uuid4())
        track_target = {
            "kind": "regular",
            "index": 0,
            "expectedReference": reference,
            "expectedName": "Track",
        }
        clip_target = {
            "view": "session",
            "track": track_target,
            "sceneIndex": 0,
            "expectedClipReference": str(uuid.uuid4()),
            "expectedClipName": "Clip",
        }
        note = {
            "pitch": 60,
            "startTime": 0.0,
            "duration": 1.0,
            "velocity": 100,
            "mute": False,
            "probability": 1.0,
            "velocityDeviation": 0,
            "releaseVelocity": 64,
        }
        wrong_group_cases = (
            ("scenes.inspect", {"action": "create", "index": -1}),
            ("scenes.mutate", {"action": "list"}),
            ("tracks.inspect", {"action": "create-return"}),
            ("tracks.mutate", {"action": "list"}),
            (
                "mixer_routing.inspect",
                {
                    "action": "set-activator",
                    "target": track_target,
                    "active": True,
                },
            ),
            (
                "mixer_routing.mutate",
                {"action": "meters", "target": track_target},
            ),
            ("transport.inspect", {"action": "seek", "time": 1.0}),
            ("transport.mutate", {"action": "get"}),
            (
                "midi_notes.inspect",
                {"action": "add", "target": clip_target, "notes": [note]},
            ),
            (
                "midi_notes.mutate",
                {"action": "query", "target": clip_target},
            ),
            (
                "audio_clips.inspect",
                {
                    "action": "set-gain",
                    "target": clip_target,
                    "gain": 0.5,
                },
            ),
            (
                "audio_clips.mutate",
                {"action": "inspect", "target": clip_target},
            ),
        )
        for command, params in wrong_group_cases:
            with self.subTest(command=command, action=params["action"]):
                result = self.execute(command, params)
                self.assertFalse(result["ok"])
                self.assertEqual(
                    result["error"]["code"], "invalid_params"
                )

    def test_scene_lifecycle_and_exact_identity(self):
        listed = self.execute("scenes.execute", {"action": "list"})["result"]
        intro = listed["scenes"][0]
        stale = dict(
            index=0,
            expectedReference=intro["reference"],
            expectedName="Wrong",
        )
        self.assertEqual(
            self.execute(
                "scenes.execute", {"action": "fire", "target": stale}
            )["error"]["code"],
            "stale_reference",
        )
        renamed = self.execute(
            "scenes.execute",
            {
                "action": "rename",
                "target": {
                    "index": 0,
                    "expectedReference": intro["reference"],
                    "expectedName": intro["name"],
                },
                "name": "Opening",
            },
        )["result"]
        self.assertEqual(renamed["after"]["name"], "Opening")
        current = renamed["after"]
        colored = self.execute(
            "scenes.execute",
            {
                "action": "set-color",
                "target": {
                    "index": 0,
                    "expectedReference": current["reference"],
                    "expectedName": current["name"],
                },
                "colorIndex": 12,
            },
        )["result"]
        self.assertEqual(colored["after"]["colorIndex"], 12)
        current = colored["after"]
        tempo = self.execute(
            "scenes.execute",
            {
                "action": "set-tempo-time-signature",
                "target": {
                    "index": 0,
                    "expectedReference": current["reference"],
                    "expectedName": current["name"],
                },
                "state": {"kind": "tempo", "tempo": 128.0, "enabled": True},
            },
        )["result"]
        self.assertEqual(tempo["after"]["tempo"], 128.0)
        fired = self.execute(
            "scenes.execute",
            {
                "action": "fire",
                "target": {
                    "index": 0,
                    "expectedReference": current["reference"],
                    "expectedName": current["name"],
                },
            },
        )["result"]
        self.assertTrue(fired["scene"]["isTriggered"])
        duplicated = self.execute(
            "scenes.execute",
            {
                "action": "duplicate",
                "target": {
                    "index": 0,
                    "expectedReference": current["reference"],
                    "expectedName": current["name"],
                },
            },
        )["result"]
        self.assertEqual(duplicated["afterSceneCount"], 3)
        created = self.execute(
            "scenes.execute",
            {"action": "create", "index": -1, "name": "Outro"},
        )["result"]
        self.assertEqual(created["afterSceneCount"], 4)
        deleted = self.execute(
            "scenes.execute",
            {
                "action": "delete",
                "target": {
                    "index": 3,
                    "expectedReference": created["scene"]["reference"],
                    "expectedName": "Outro",
                },
            },
        )["result"]
        self.assertEqual(deleted["afterSceneCount"], 3)

    def test_tracks_mixer_routing_and_warnings(self):
        tracks = self.tracks()
        regular = tracks[0]
        return_track = next(item for item in tracks if item["kind"] == "return")
        master = next(item for item in tracks if item["kind"] == "master")
        duplicated = self.execute(
            "tracks.execute",
            {"action": "duplicate", "target": target(regular)},
        )["result"]
        self.assertTrue(duplicated["verified"])
        regular = self.execute(
            "tracks.execute",
            {"action": "get", "target": target(regular)},
        )["result"]["track"]
        for action, field, value in (
            ("set-color", "colorIndex", 15),
            ("set-monitoring", "monitoringState", 2),
            ("set-fold", "folded", True),
        ):
            result = self.execute(
                "tracks.execute",
                {
                    "action": action,
                    "target": target(regular),
                    field: value,
                },
            )
            self.assertTrue(result["result"]["result"]["verified"])
        self.context.song.tracks[0].playing_slot_index = 0
        self.assertTrue(
            self.execute(
                "tracks.execute",
                {
                    "action": "stop-clips",
                    "target": target(regular),
                    "quantized": False,
                },
            )["result"]["result"]["verified"]
        )
        self.context.song.tracks[0].playing_slot_index = 0
        self.context.song.tracks[0].stop_all_clips = types.MethodType(
            lambda current, _quantized: setattr(
                current, "playing_slot_index", -2
            ),
            self.context.song.tracks[0],
        )
        self.assertTrue(
            self.execute(
                "tracks.execute",
                {
                    "action": "stop-clips",
                    "target": target(regular),
                    "quantized": True,
                },
            )["result"]["result"]["verified"]
        )
        self.assertTrue(
            self.execute(
                "tracks.execute",
                {
                    "action": "back-to-arrangement",
                    "target": target(regular),
                },
            )["result"]["result"]["verified"]
        )
        created_return = self.execute(
            "tracks.execute", {"action": "create-return", "name": "FX"}
        )["result"]
        self.assertEqual(created_return["track"]["name"], "FX")
        self.assertTrue(
            self.execute(
                "tracks.execute",
                {
                    "action": "delete",
                    "target": target(created_return["track"]),
                },
            )["result"]["verified"]
        )
        inspected = self.execute(
            "mixer_routing.execute",
            {"action": "inspect", "target": target(regular)},
        )["result"]["mixer"]
        volume = inspected["volume"]
        changed = self.execute(
            "mixer_routing.execute",
            {
                "action": "set-volume",
                "value": {
                    "target": target(regular),
                    "expectedParameterReference": volume["reference"],
                    "expectedParameterName": volume["name"],
                    "normalizedValue": 0.25,
                },
            },
        )["result"]
        self.assertAlmostEqual(
            changed["result"]["after"]["normalizedValue"], 0.25
        )
        pan = inspected["pan"]
        self.assertTrue(
            self.execute(
                "mixer_routing.execute",
                {
                    "action": "set-pan",
                    "value": {
                        "target": target(regular),
                        "expectedParameterReference": pan["reference"],
                        "expectedParameterName": pan["name"],
                        "normalizedValue": 0.75,
                    },
                },
            )["result"]["result"]["verified"]
        )
        send = inspected["sends"][0]
        self.assertTrue(
            self.execute(
                "mixer_routing.execute",
                {
                    "action": "set-send",
                    "target": target(regular),
                    "sendIndex": 0,
                    "expectedParameterReference": send["reference"],
                    "expectedParameterName": send["name"],
                    "normalizedValue": 0.4,
                },
            )["result"]["result"]["verified"]
        )
        self.assertTrue(
            self.execute(
                "mixer_routing.execute",
                {
                    "action": "set-activator",
                    "target": target(regular),
                    "active": False,
                },
            )["result"]["verified"]
        )
        self.assertTrue(
            self.execute(
                "mixer_routing.execute",
                {
                    "action": "set-crossfade-assignment",
                    "target": target(regular),
                    "assignment": 2,
                },
            )["result"]["verified"]
        )
        self.assertIsNotNone(
            self.execute(
                "mixer_routing.execute",
                {"action": "meters", "target": target(regular)},
            )["result"]["outputLeft"]
        )
        master_mixer = self.execute(
            "mixer_routing.execute",
            {"action": "inspect", "target": target(master)},
        )["result"]["mixer"]
        for action, parameter in (
            ("set-master-crossfader", master_mixer["crossfader"]),
            ("set-cue-volume", master_mixer["cueVolume"]),
        ):
            self.assertTrue(
                self.execute(
                    "mixer_routing.execute",
                    {
                        "action": action,
                        "value": {
                            "target": target(master),
                            "expectedParameterReference": parameter["reference"],
                            "expectedParameterName": parameter["name"],
                            "normalizedValue": 0.6,
                        },
                    },
                )["result"]["result"]["verified"]
            )
        options = self.execute(
            "mixer_routing.execute",
            {
                "action": "routing-options",
                "target": target(regular),
                "direction": "input-type",
            },
        )["result"]
        external = next(
            option for option in options["options"] if option["isExternalMidi"]
        )
        assigned = self.execute(
            "mixer_routing.execute",
            {
                "action": "set-routing",
                "target": target(regular),
                "direction": "input-type",
                "snapshotId": options["snapshotId"],
                "optionToken": external["token"],
                "expectedDisplayName": external["displayName"],
            },
        )["result"]
        self.assertTrue(assigned["warnings"])
        self.assertNotIn(
            options["snapshotId"],
            getattr(self.context, "_routing_snapshots", {}),
        )
        stale = dict(
            action="set-routing",
            target=target(regular),
            direction="input-type",
            snapshotId=options["snapshotId"],
            optionToken=external["token"],
            expectedDisplayName="Changed",
        )
        self.assertEqual(
            self.execute("mixer_routing.execute", stale)["error"]["code"],
            "stale_reference",
        )
        self.assertEqual(return_track["kind"], "return")
        self.assertEqual(master["kind"], "master")

    def test_transport_mutations_and_cue_identity(self):
        state = self.execute(
            "transport.execute", {"action": "get"}
        )["result"]
        cue = state["cuePoints"][1]
        jumped = self.execute(
            "transport.execute",
            {
                "action": "jump-to-cue",
                "target": {
                    "expectedReference": cue["reference"],
                    "expectedName": cue["name"],
                    "expectedTime": cue["time"],
                },
            },
        )["result"]
        self.assertEqual(jumped["afterTime"], 16.0)
        changed = self.execute(
            "transport.execute",
            {
                "action": "set-time-signature",
                "numerator": 7,
                "denominator": 8,
            },
        )["result"]
        self.assertEqual(changed["after"]["timeSignature"]["numerator"], 7)
        self.assertTrue(
            self.execute(
                "transport.execute",
                {"action": "set-link", "enabled": True},
            )["result"]["verified"]
        )
        for params in (
            {"action": "seek", "time": 4.0},
            {"action": "jump", "beats": 2.0},
            {"action": "set-metronome", "enabled": True},
            {"action": "set-launch-quantization", "quantization": 8},
            {"action": "set-record-quantization", "quantization": 5},
            {"action": "back-to-arrangement"},
        ):
            self.assertTrue(
                self.execute("transport.execute", params)["result"]["verified"]
            )
        renamed = self.execute(
            "transport.execute",
            {
                "action": "rename-cue",
                "target": {
                    "expectedReference": cue["reference"],
                    "expectedName": cue["name"],
                    "expectedTime": cue["time"],
                },
                "name": "Drop",
            },
        )["result"]
        self.assertEqual(renamed["after"]["name"], "Drop")

    def test_modern_midi_crud_preserves_extended_values(self):
        regular = self.tracks()[0]
        clip = self.context.song.tracks[0].clip_slots[0].clip
        clip_target = {
            "view": "session",
            "track": target(regular),
            "sceneIndex": 0,
            "expectedClipReference": self._clip_reference(clip),
            "expectedClipName": clip.name,
        }
        queried = self.execute(
            "midi_notes.execute",
            {"action": "query", "target": clip_target},
        )["result"]["notes"][0]
        self.assertEqual(queried["velocity"], 0.5)
        self.assertEqual(queried["probability"], 0.7)
        self.assertEqual(queried["velocityDeviation"], -3.25)
        self.assertEqual(queried["releaseVelocity"], 72.5)
        updated = dict(queried)
        updated["velocity"] = 0.0
        updated["velocityDeviation"] = 4.5
        updated["releaseVelocity"] = 63.75
        self.assertTrue(
            self.execute(
                "midi_notes.execute",
                {"action": "update", "target": clip_target, "notes": [updated]},
            )["result"]["verified"]
        )
        added = self.execute(
            "midi_notes.execute",
            {
                "action": "add",
                "target": clip_target,
                "notes": [
                    {
                        "pitch": 64,
                        "startTime": 1.0,
                        "duration": 0.5,
                        "velocity": 0.0,
                        "mute": False,
                        "probability": 0.5,
                        "velocityDeviation": 2.5,
                        "releaseVelocity": 80.25,
                    }
                ],
            },
        )["result"]
        self.assertEqual(added["afterNoteCount"], 2)
        duplicated = self.execute(
            "midi_notes.execute",
            {
                "action": "duplicate",
                "target": clip_target,
                "noteIds": added["affectedNoteIds"],
                "timeOffset": 1.0,
                "pitchOffset": 1,
            },
        )["result"]
        self.assertEqual(duplicated["afterNoteCount"], 3)
        quantized = self.execute(
            "midi_notes.execute",
            {
                "action": "quantize",
                "target": clip_target,
                "noteIds": [queried["noteId"]],
                "gridBeats": 0.25,
                "amount": 1.0,
            },
        )["result"]
        self.assertTrue(quantized["verified"])
        removed = self.execute(
            "midi_notes.execute",
            {
                "action": "remove",
                "target": clip_target,
                "noteIds": added["affectedNoteIds"],
            },
        )["result"]
        self.assertEqual(removed["afterNoteCount"], 2)
        remaining = self.execute(
            "midi_notes.execute",
            {"action": "query", "target": clip_target},
        )["result"]["notes"]
        updated_note = next(
            note for note in remaining if note["noteId"] == queried["noteId"]
        )
        self.assertEqual(updated_note["velocity"], 0.0)
        self.assertEqual(updated_note["velocityDeviation"], 4.5)
        self.assertEqual(updated_note["releaseVelocity"], 63.75)

    def test_audio_properties_and_warp_marker_reads(self):
        audio_track = next(
            item
            for item in self.tracks()
            if item["kind"] == "regular" and item["name"] == "Bass"
        )
        clip = self.context.song.tracks[1].clip_slots[0].clip
        clip_target = {
            "view": "session",
            "track": target(audio_track),
            "sceneIndex": 0,
            "expectedClipReference": self._clip_reference(clip),
            "expectedClipName": clip.name,
        }
        changed = self.execute(
            "audio_clips.execute",
            {
                "action": "set-pitch",
                "target": clip_target,
                "coarse": 12,
                "fine": -5,
            },
        )["result"]
        self.assertEqual(changed["after"]["pitchCoarse"], 12)
        inspected = self.execute(
            "audio_clips.execute",
            {"action": "inspect", "target": clip_target},
        )["result"]["clip"]
        self.assertEqual(inspected["availableWarpModes"], [0, 1, 2, 3, 4, 6])
        for params in (
            {"action": "set-gain", "gain": 0.75},
            {"action": "set-warp", "enabled": False},
            {
                "action": "set-warp-mode",
                "warpMode": 4,
                "expectedAvailableWarpModes": inspected[
                    "availableWarpModes"
                ],
            },
            {
                "action": "set-markers",
                "markers": {
                    "kind": "start-end",
                    "startMarker": 0.5,
                    "endMarker": 7.5,
                },
            },
            {"action": "set-ram-mode", "enabled": True},
        ):
            params["target"] = clip_target
            self.assertTrue(
                self.execute("audio_clips.execute", params)["result"][
                    "verified"
                ]
            )
        markers = self.execute(
            "audio_clips.execute",
            {"action": "warp-markers", "target": clip_target},
        )["result"]
        self.assertEqual(markers["total"], 2)
        self.assertEqual(markers["markers"][1]["beatTime"], 4.0)

    def test_live_11_scalar_domains_are_rejected_by_python_validators(self):
        for params in (
            {"action": "set-launch-quantization", "quantization": 14},
            {"action": "set-record-quantization", "quantization": 9},
        ):
            failed = self.execute("transport.execute", params)
            self.assertEqual(failed["error"]["code"], "invalid_params")

        audio_track = next(
            item
            for item in self.tracks()
            if item["kind"] == "regular" and item["name"] == "Bass"
        )
        clip = self.context.song.tracks[1].clip_slots[0].clip
        failed = self.execute(
            "audio_clips.execute",
            {
                "action": "set-pitch",
                "target": {
                    "view": "session",
                    "track": target(audio_track),
                    "sceneIndex": 0,
                    "expectedClipReference": self._clip_reference(clip),
                    "expectedClipName": clip.name,
                },
                "coarse": 0,
                "fine": 50,
            },
        )
        self.assertEqual(failed["error"]["code"], "invalid_params")

    def test_audio_marker_ranges_choose_valid_orders_and_roll_back(self):
        audio_track = next(
            item
            for item in self.tracks()
            if item["kind"] == "regular" and item["name"] == "Bass"
        )
        clip = RangeCheckedAudioClip()
        self.context.song.tracks[1].clip_slots[0].clip = clip
        clip_target = {
            "view": "session",
            "track": target(audio_track),
            "sceneIndex": 0,
            "expectedClipReference": self._clip_reference(clip),
            "expectedClipName": clip.name,
        }

        moved_right = self.execute(
            "audio_clips.execute",
            {
                "action": "set-markers",
                "target": clip_target,
                "markers": {
                    "kind": "start-end",
                    "startMarker": 10.0,
                    "endMarker": 18.0,
                },
            },
        )
        self.assertTrue(moved_right["ok"])
        self.assertEqual(clip.assignments, ["end_marker", "start_marker"])

        clip.assignments = []
        moved_left = self.execute(
            "audio_clips.execute",
            {
                "action": "set-markers",
                "target": clip_target,
                "markers": {
                    "kind": "start-end",
                    "startMarker": 0.0,
                    "endMarker": 8.0,
                },
            },
        )
        self.assertTrue(moved_left["ok"])
        self.assertEqual(clip.assignments, ["start_marker", "end_marker"])

        clip.assignments = []
        loop_right = self.execute(
            "audio_clips.execute",
            {
                "action": "set-markers",
                "target": clip_target,
                "markers": {
                    "kind": "loop",
                    "loopStart": 10.0,
                    "loopEnd": 18.0,
                    "looping": True,
                },
            },
        )
        self.assertTrue(loop_right["ok"])
        self.assertEqual(clip.assignments, ["loop_end", "loop_start"])

        clip.assignments = []
        loop_left = self.execute(
            "audio_clips.execute",
            {
                "action": "set-markers",
                "target": clip_target,
                "markers": {
                    "kind": "loop",
                    "loopStart": 0.0,
                    "loopEnd": 8.0,
                    "looping": True,
                },
            },
        )
        self.assertTrue(loop_left["ok"])
        self.assertEqual(clip.assignments, ["loop_start", "loop_end"])

        clip.assignments = []
        clip.fail_after_assignment = "loop_start"
        failed = self.execute(
            "audio_clips.execute",
            {
                "action": "set-markers",
                "target": clip_target,
                "markers": {
                    "kind": "loop",
                    "loopStart": 10.0,
                    "loopEnd": 18.0,
                    "looping": False,
                },
            },
        )
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["error"]["details"]["outcome"], "not_applied")
        self.assertEqual((clip.loop_start, clip.loop_end), (0.0, 8.0))
        self.assertEqual(
            clip.assignments,
            ["loop_end", "loop_start", "loop_start", "loop_end"],
        )

    def test_warp_mode_rejects_stale_or_unavailable_selection(self):
        audio_track = next(
            item
            for item in self.tracks()
            if item["kind"] == "regular" and item["name"] == "Bass"
        )
        clip = self.context.song.tracks[1].clip_slots[0].clip
        clip_target = {
            "view": "session",
            "track": target(audio_track),
            "sceneIndex": 0,
            "expectedClipReference": self._clip_reference(clip),
            "expectedClipName": clip.name,
        }
        stale = self.execute(
            "audio_clips.execute",
            {
                "action": "set-warp-mode",
                "target": clip_target,
                "warpMode": 4,
                "expectedAvailableWarpModes": [0, 1, 2, 3, 4],
            },
        )
        self.assertEqual(stale["error"]["code"], "stale_reference")
        invalid = self.execute(
            "audio_clips.execute",
            {
                "action": "set-warp-mode",
                "target": clip_target,
                "warpMode": 5,
                "expectedAvailableWarpModes": [0, 1, 2, 3, 4, 6],
            },
        )
        self.assertEqual(invalid["error"]["code"], "invalid_params")

    def test_midi_remove_reports_indeterminate_when_verification_fails(self):
        track_summary = self.tracks()[0]
        clip = IndeterminateRemovalClip(8.0)
        clip.name = "MIDI"
        note = FakeMidiNoteSpecification(
            pitch=60,
            start_time=0.0,
            duration=1.0,
            velocity=100,
            mute=False,
        )
        note.note_id = 42
        clip.notes = [note]
        self.context.song.tracks[0].clip_slots[0].clip = clip
        clip_target = {
            "view": "session",
            "track": target(track_summary),
            "sceneIndex": 0,
            "expectedClipReference": self._clip_reference(clip),
            "expectedClipName": clip.name,
        }
        failed = self.execute(
            "midi_notes.execute",
            {
                "action": "remove",
                "target": clip_target,
                "noteIds": [42],
            },
        )
        self.assertFalse(failed["ok"])
        self.assertFalse(failed["error"]["retryable"])
        self.assertEqual(
            failed["error"]["details"]["outcome"],
            "applied_indeterminate",
        )

    def test_capabilities_are_per_action_and_fail_closed(self):
        document = build_capability_document(
            FakeApplication(self.context.song),
            self.context.song,
            self.registry,
            note_editing_supported=True,
        )
        capabilities = document["capabilities"]
        self.assertEqual(
            set(capabilities.keys()), set(document["capabilityDetails"].keys())
        )
        self.assertTrue(
            all(
                supported
                == document["capabilityDetails"][name]["supported"]
                for name, supported in capabilities.items()
            )
        )
        self.assertNotIn("scenes.execute", capabilities)
        self.assertNotIn("scenes.inspect", capabilities)
        self.assertNotIn("scenes.mutate", capabilities)
        self.assertTrue(capabilities["scenes.create"])
        self.assertTrue(capabilities["scenes.set_color"])
        self.assertTrue(capabilities["tracks.create_return"])
        self.assertTrue(capabilities["mixer_routing.routing_options"])
        self.assertTrue(capabilities["midi_notes.update"])
        self.assertTrue(capabilities["audio_clips.warp_markers"])
        self.assertEqual(
            "public",
            document["capabilityDetails"]["scenes.create"]["evidence"],
        )
        self.assertEqual(
            capabilities["scenes.create"],
            document["capabilityDetails"]["scenes.create"]["supported"],
        )
        self.assertNotIn("scenes.stop", capabilities)
        self.assertNotIn("tracks.reorder", capabilities)
        self.assertNotIn("midi_notes.expression", capabilities)
        self.assertNotIn("audio_clips.set-warp-markers", capabilities)
        del self.context.song.is_ableton_link_enabled
        document = build_capability_document(
            FakeApplication(self.context.song),
            self.context.song,
            self.registry,
            note_editing_supported=True,
        )
        self.assertFalse(document["capabilities"]["transport.set_link"])

    def test_capabilities_use_live_api_types_when_project_has_no_instances(self):
        self.context.song.cue_points = []
        for track in self.context.song.tracks:
            for slot in track.clip_slots:
                slot.clip = None
            track.arrangement_clips = []
        previous_clip_api = capability_module.LiveClip
        previous_cue_api = capability_module.LiveCuePoint
        capability_module.LiveClip = CoreClipApi
        capability_module.LiveCuePoint = CoreCuePointApi
        try:
            document = build_capability_document(
                FakeApplication(self.context.song),
                self.context.song,
                self.registry,
                note_editing_supported=True,
            )
        finally:
            capability_module.LiveClip = previous_clip_api
            capability_module.LiveCuePoint = previous_cue_api
        capabilities = document["capabilities"]
        self.assertTrue(capabilities["transport.rename_cue"])
        self.assertTrue(capabilities["transport.jump_to_cue"])
        self.assertTrue(capabilities["midi_notes.query"])
        self.assertTrue(capabilities["midi_notes.add"])
        self.assertTrue(capabilities["midi_notes.update"])
        self.assertTrue(capabilities["midi_notes.remove"])
        self.assertTrue(capabilities["audio_clips.inspect"])
        self.assertTrue(capabilities["audio_clips.set_gain"])
        self.assertTrue(capabilities["audio_clips.warp_markers"])

    def test_routing_snapshot_cache_is_purged_bounded_and_consumed(self):
        regular = self.tracks()[0]
        now = time.time()
        expired_id = str(uuid.uuid4())
        snapshots = {
            expired_id: {
                "created": now - ROUTING_SNAPSHOT_SECONDS - 1,
            }
        }
        for index in range(ROUTING_SNAPSHOT_LIMIT + 5):
            snapshots[str(uuid.uuid4())] = {
                "created": now - index * 0.001,
            }
        self.context._routing_snapshots = snapshots
        options = self.execute(
            "mixer_routing.execute",
            {
                "action": "routing-options",
                "target": target(regular),
                "direction": "input-type",
            },
        )["result"]
        cache = self.context._routing_snapshots
        self.assertNotIn(expired_id, cache)
        self.assertLessEqual(len(cache), ROUTING_SNAPSHOT_LIMIT)
        selected = options["options"][0]
        result = self.execute(
            "mixer_routing.execute",
            {
                "action": "set-routing",
                "target": target(regular),
                "direction": "input-type",
                "snapshotId": options["snapshotId"],
                "optionToken": selected["token"],
                "expectedDisplayName": selected["displayName"],
            },
        )
        self.assertTrue(result["ok"])
        self.assertNotIn(
            options["snapshotId"], self.context._routing_snapshots
        )


class SimulatorCoreDomainTests(unittest.TestCase):
    def setUp(self):
        self.state = SimulatorState()
        self.token = "token"

    def execute(self, command, params):
        command = split_command(command, params.get("action"))
        return handle(request(command, params), self.token, self.state)

    def test_simulator_supports_all_twelve_commands_and_strict_validation(self):
        for command in (
            "scenes.inspect",
            "scenes.mutate",
            "tracks.inspect",
            "tracks.mutate",
            "mixer_routing.inspect",
            "mixer_routing.mutate",
            "transport.inspect",
            "transport.mutate",
            "midi_notes.inspect",
            "midi_notes.mutate",
            "audio_clips.inspect",
            "audio_clips.mutate",
        ):
            self.assertNotEqual(
                handle(request(command, {}), self.token, self.state)[
                    "error"
                ]["code"],
                "unknown_command",
            )
        listed = self.execute("scenes.execute", {"action": "list"})
        self.assertTrue(listed["ok"])
        self.assertEqual(
            self.execute(
                "tracks.execute", {"action": "list", "unknown": True}
            )["error"]["code"],
            "invalid_params",
        )
        tracks = self.execute(
            "tracks.execute", {"action": "list"}
        )["result"]["tracks"]
        regular = tracks[0]
        mixer = self.execute(
            "mixer_routing.execute",
            {"action": "inspect", "target": target(regular)},
        )
        self.assertTrue(mixer["ok"])
        self.assertTrue(
            self.execute(
                "transport.execute", {"action": "seek", "time": 8.0}
            )["ok"]
        )
        midi_clip = {
            "reference": str(uuid.uuid4()),
            "name": "Notes",
            "kind": "midi",
            "length": 4.0,
            "notes": [],
            "muted": False,
            "looping": True,
            "isPlaying": False,
            "isTriggered": False,
        }
        self.state.tracks[0]["clips"][0] = midi_clip
        midi_target = {
            "view": "session",
            "track": target(regular),
            "sceneIndex": 0,
            "expectedClipReference": midi_clip["reference"],
            "expectedClipName": midi_clip["name"],
        }
        self.assertTrue(
            self.execute(
                "midi_notes.execute",
                {
                    "action": "add",
                    "target": midi_target,
                    "notes": [
                        {
                            "pitch": 60,
                            "startTime": 0.0,
                            "duration": 1.0,
                            "velocity": 100,
                            "mute": False,
                            "probability": 1.0,
                            "velocityDeviation": 0,
                            "releaseVelocity": 64,
                        }
                    ],
                },
            )["ok"]
        )
        audio_clip = {
            "reference": str(uuid.uuid4()),
            "name": "Audio",
            "kind": "audio",
            "length": 4.0,
            "gain": 0.5,
            "pitchCoarse": 0,
            "pitchFine": 0,
            "warping": True,
            "warpMode": 2,
            "availableWarpModes": [0, 1, 2, 3, 4, 6],
            "startMarker": 0.0,
            "endMarker": 4.0,
            "loopStart": 0.0,
            "loopEnd": 4.0,
            "looping": True,
            "ramMode": False,
            "filePath": None,
            "sampleLength": None,
            "sampleRate": None,
            "warpMarkers": [{"beatTime": 0.0, "sampleTime": 0.0}],
        }
        self.state.tracks[0]["clips"][1] = audio_clip
        audio_target = dict(midi_target)
        audio_target.update(
            {
                "sceneIndex": 1,
                "expectedClipReference": audio_clip["reference"],
                "expectedClipName": audio_clip["name"],
            }
        )
        inspected = self.execute(
            "audio_clips.execute",
            {"action": "inspect", "target": audio_target},
        )
        self.assertTrue(inspected["ok"])
        self.assertEqual(
            inspected["result"]["clip"]["availableWarpModes"],
            [0, 1, 2, 3, 4, 6],
        )
        self.assertTrue(
            self.execute(
                "audio_clips.execute",
                {
                    "action": "set-warp-mode",
                    "target": audio_target,
                    "warpMode": 4,
                    "expectedAvailableWarpModes": [0, 1, 2, 3, 4, 6],
                },
            )["ok"]
        )

    def test_simulator_capabilities_omit_forbidden_operations(self):
        hello = handle(
            request(
                "system.hello",
                {
                    "authenticationToken": self.token,
                    "supportedProtocolVersions": [
                        __import__("AbletonAgent.version", fromlist=["PROTOCOL_VERSION"]).PROTOCOL_VERSION
                    ],
                },
            ),
            self.token,
            self.state,
        )
        capabilities = hello["result"]["capabilities"]
        self.assertTrue(capabilities["scenes.list"])
        self.assertTrue(capabilities["audio_clips.warp_markers"])
        for unsupported in (
            "scenes.stop",
            "tracks.reorder",
            "midi_notes.expression",
            "audio_clips.set-warp-markers",
            "audio_clips.set_warp_markers",
            "audio_clips.import-file",
            "audio_clips.import_file",
            "devices.create_chain",
            "devices.insert_native",
            "devices.replace_simpler",
        ):
            self.assertNotIn(unsupported, capabilities)

    def test_simulator_missing_current_route_returns_stale_reference(self):
        track = self.execute(
            "tracks.execute", {"action": "list"}
        )["result"]["tracks"][0]
        now = time.time()
        expired_id = str(uuid.uuid4())
        self.state.routing_snapshots[expired_id] = {
            "created": now - ROUTING_SNAPSHOT_SECONDS - 1,
        }
        for index in range(ROUTING_SNAPSHOT_LIMIT + 5):
            self.state.routing_snapshots[str(uuid.uuid4())] = {
                "created": now - index * 0.001,
            }
        options = self.execute(
            "mixer_routing.execute",
            {
                "action": "routing-options",
                "target": target(track),
                "direction": "input-type",
            },
        )["result"]
        self.assertNotIn(expired_id, self.state.routing_snapshots)
        self.assertLessEqual(
            len(self.state.routing_snapshots), ROUTING_SNAPSHOT_LIMIT
        )
        self.state.tracks[0]["routing"]["input-type"] = "Missing Route"
        selected = options["options"][0]
        result = self.execute(
            "mixer_routing.execute",
            {
                "action": "set-routing",
                "target": target(track),
                "direction": "input-type",
                "snapshotId": options["snapshotId"],
                "optionToken": selected["token"],
                "expectedDisplayName": selected["displayName"],
            },
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "stale_reference")
        self.state.tracks[0]["routing"]["input-type"] = "All Ins"
        fresh = self.execute(
            "mixer_routing.execute",
            {
                "action": "routing-options",
                "target": target(track),
                "direction": "input-type",
            },
        )["result"]
        selected = fresh["options"][0]
        self.assertTrue(
            self.execute(
                "mixer_routing.execute",
                {
                    "action": "set-routing",
                    "target": target(track),
                    "direction": "input-type",
                    "snapshotId": fresh["snapshotId"],
                    "optionToken": selected["token"],
                    "expectedDisplayName": selected["displayName"],
                },
            )["ok"]
        )
        self.assertNotIn(fresh["snapshotId"], self.state.routing_snapshots)


if __name__ == "__main__":
    unittest.main()
