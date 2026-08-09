import os
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.capabilities import build_capability_document  # noqa: E402
from AbletonAgent.executor import MainThreadExecutor  # noqa: E402
from AbletonAgent.messages import PROTOCOL_VERSION, success  # noqa: E402
from AbletonAgent.protocol import FrameDecoder, encode_frame  # noqa: E402
from AbletonAgent.registry import CommandRegistry  # noqa: E402
from AbletonAgent.server import LOOPBACK_HOST, RemoteScriptServer  # noqa: E402
from AbletonAgent.system_commands import register_system_commands  # noqa: E402
from AbletonAgent.token_store import load_or_create_token  # noqa: E402


def request(command, params=None):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "request",
        "requestId": str(uuid.uuid4()),
        "command": command,
        "params": params or {},
    }


class FakeTrack(object):
    def __init__(self, name, midi=True, group=False):
        self.name = name
        self.has_midi_input = midi
        self.is_foldable = group
        self.can_be_armed = not group
        self.color = 10
        self.mute = False
        self.solo = False
        self.arm = True
        self.mixer_device = FakeMixerDevice()
        self.devices = [FakeDevice("Instrument Rack")]
        self.playing_slot_index = -1
        self.clip_slots = [
            FakeClipSlot(self, 0),
            FakeClipSlot(self, 1),
        ]
        self.arrangement_clips = []
        self.fail_arrangement_create_after_mutation = False
        self.fail_arrangement_duplicate_after_mutation = False

    def create_midi_clip(self, start_time, length):
        clip = FakeClip(length, start_time=start_time)
        self.arrangement_clips.append(clip)
        if self.fail_arrangement_create_after_mutation:
            raise RuntimeError("simulated arrangement create failure")
        return clip

    def delete_clip(self, clip):
        self.arrangement_clips.remove(clip)

    def duplicate_clip_to_arrangement(self, source, destination_time):
        clip = FakeClip(
            source.length,
            start_time=destination_time,
            midi=source.is_midi_clip,
        )
        clip.name = source.name
        clip.notes = list(source.notes)
        clip.muted = source.muted
        clip.looping = source.looping
        self.arrangement_clips.append(clip)
        if self.fail_arrangement_duplicate_after_mutation:
            raise RuntimeError("simulated arrangement duplicate failure")
        return clip


class FakeParameter(object):
    def __init__(
        self,
        value,
        name="Parameter",
        minimum=0.0,
        maximum=1.0,
        quantized=False,
        enabled=True,
        value_items=(),
    ):
        self.name = name
        self.original_name = name
        self.min = minimum
        self.max = maximum
        self.is_quantized = quantized
        self.is_enabled = enabled
        self.is_writable = True
        self._value_items = value_items
        self._value = value
        self.fail_next_set_after_mutation = False

    @property
    def value(self):
        return self._value

    @property
    def value_items(self):
        if not self.is_quantized:
            raise RuntimeError(
                "value_items is unavailable for continuous parameters"
            )
        return self._value_items

    @value.setter
    def value(self, value):
        self._value = value
        if self.fail_next_set_after_mutation:
            self.fail_next_set_after_mutation = False
            raise RuntimeError("simulated parameter setter failure")


class FakeChain(object):
    def __init__(self, name, devices=None):
        self.name = name
        self.color = None
        self.devices = list(devices or [])


class FakeDrumPad(object):
    def __init__(self, note, name, chains=None):
        self.note = note
        self.name = name
        self.mute = False
        self.solo = False
        self.chains = list(chains or [])


class FakeDevice(object):
    def __init__(self, name):
        self.name = name
        self.class_name = "InstrumentGroupDevice"
        self.class_display_name = "Instrument Rack"
        self.parameters = [
            FakeParameter(
                1.0,
                name="Device On",
                quantized=True,
                value_items=("Off", "On"),
            ),
            FakeParameter(0.25, name="Dry/Wet"),
            FakeParameter(
                1.0,
                name="Mode",
                minimum=0.0,
                maximum=2.0,
                quantized=True,
                value_items=("A", "B", "C"),
            ),
        ]
        self.can_have_chains = name in ("Instrument Rack", "Drum Rack")
        self.can_have_drum_pads = name == "Drum Rack"
        if name == "Drum Rack":
            kick_chain = FakeChain("Kick", [FakeDevice("Simpler")])
            snare_chain = FakeChain("Snare", [FakeDevice("Simpler")])
            self.chains = [kick_chain, snare_chain]
            self.drum_pads = [
                FakeDrumPad(
                    note,
                    "Kick" if note == 36 else "Snare" if note == 38 else "",
                    [kick_chain]
                    if note == 36
                    else [snare_chain]
                    if note == 38
                    else [],
                )
                for note in range(128)
            ]
        elif self.can_have_chains:
            self.chains = [FakeChain("Main", [FakeDevice("Operator")])]
            self.drum_pads = []
        else:
            self.chains = []
            self.drum_pads = []


class FakeMixerDevice(object):
    def __init__(self):
        self.volume = FakeParameter(0.8)
        self.panning = FakeParameter(0.0)


class FakeClip(object):
    def __init__(self, length, start_time=0.0, midi=True):
        self.length = length
        self.is_midi_clip = midi
        self.start_time = start_time
        self.end_time = start_time + length
        self.name = ""
        self.muted = False
        self.looping = True
        self.notes = []
        self.fail_next_add = False
        self.get_notes_calls = 0
        self.fail_get_notes_call = None
        self.is_playing = False
        self.is_triggered = False
        self._slot = None

    def get_all_notes_extended(self):
        self.get_notes_calls += 1
        if self.get_notes_calls == self.fail_get_notes_call:
            raise RuntimeError("simulated note read failure")
        return tuple(self.notes)

    def remove_notes_by_id(self, note_ids):
        self.notes = [
            note for note in self.notes if note.note_id not in note_ids
        ]

    def add_new_notes(self, notes):
        if self.fail_next_add:
            self.fail_next_add = False
            raise RuntimeError("simulated add failure")
        added_ids = []
        for note in notes:
            note.note_id = len(self.notes) + 1
            self.notes.append(note)
            added_ids.append(note.note_id)
        return tuple(added_ids)

    def stop(self):
        self.is_playing = False
        self.is_triggered = False
        if (
            self._slot is not None
            and self._slot.track.playing_slot_index == self._slot.index
        ):
            self._slot.track.playing_slot_index = -1


class FailingMutedClip(FakeClip):
    def __init__(self, length, start_time=0.0):
        self.fail_muted_set = False
        super(FailingMutedClip, self).__init__(length, start_time)

    def __setattr__(self, key, value):
        if key == "muted" and getattr(self, "fail_muted_set", False):
            self.fail_muted_set = False
            raise RuntimeError("simulated muted setter failure")
        super(FailingMutedClip, self).__setattr__(key, value)


class FakeMidiNoteSpecification(object):
    def __init__(
        self,
        pitch,
        start_time,
        duration,
        velocity,
        mute=False,
        probability=1.0,
        velocity_deviation=0.0,
        release_velocity=64.0,
    ):
        self.pitch = pitch
        self.start_time = start_time
        self.duration = duration
        self.velocity = velocity
        self.mute = mute
        self.probability = probability
        self.velocity_deviation = velocity_deviation
        self.release_velocity = release_velocity
        self.note_id = None


class FakeClipSlot(object):
    def __init__(self, track=None, index=0):
        self.track = track
        self.index = index
        self._clip = None
        self.fail_duplicate_after_mutation = False
        self.fail_fire_after_mutation = False
        self.fire_calls = 0

    @property
    def clip(self):
        return self._clip

    @clip.setter
    def clip(self, value):
        self._clip = value
        if value is not None:
            value._slot = self

    @property
    def has_clip(self):
        return self._clip is not None

    def create_clip(self, length):
        self.clip = FakeClip(length)

    def delete_clip(self):
        if (
            self.track is not None
            and self.track.playing_slot_index == self.index
        ):
            self.track.playing_slot_index = -1
        self.clip = None

    def fire(self):
        if not self.has_clip:
            raise RuntimeError("cannot fire an empty clip slot")
        self.fire_calls += 1
        for slot in self.track.clip_slots:
            if slot.has_clip:
                slot.clip.is_playing = False
                slot.clip.is_triggered = False
        self.clip.is_playing = True
        self.track.playing_slot_index = self.index
        if self.fail_fire_after_mutation:
            self.fail_fire_after_mutation = False
            raise RuntimeError("simulated Session launch failure")

    def stop(self):
        if self.has_clip:
            self.clip.is_playing = False
            self.clip.is_triggered = False
        if (
            self.track is not None
            and self.track.playing_slot_index == self.index
        ):
            self.track.playing_slot_index = -1

    def duplicate_clip_to(self, destination):
        source = self.clip
        duplicated = FakeClip(source.length, midi=source.is_midi_clip)
        duplicated.name = source.name
        duplicated.notes = list(source.notes)
        duplicated.muted = source.muted
        duplicated.looping = source.looping
        destination.clip = duplicated
        if self.fail_duplicate_after_mutation:
            raise RuntimeError("simulated Session duplicate failure")


class FakeUnsupportedClip(object):
    def __init__(self, length):
        self.length = length
        self.name = ""


class FakeUnsupportedClipSlot(FakeClipSlot):
    def create_clip(self, length):
        self.clip = FakeUnsupportedClip(length)


class FakeCreateThenFailClipSlot(FakeClipSlot):
    def create_clip(self, length):
        self.clip = FakeClip(length)
        raise RuntimeError("simulated create failure")


class FakeCuePoint(object):
    def __init__(self, time, name):
        self.time = time
        self.name = name


class FakeSongView(object):
    def __init__(self):
        self.selected_track = None


class FakeSong(object):
    def __init__(self):
        self.tempo = 124.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.is_playing = True
        self.current_song_time = 4.0
        self.file_path = "/tmp/example.als"
        self._loop = False
        self._loop_start = 0.0
        self._loop_length = 16.0
        self.fail_loop_length_set_after_mutation = False
        self.fail_cue_create_after_mutation = False
        self.cue_points = [
            FakeCuePoint(0.0, "Intro"),
            FakeCuePoint(16.0, "Verse"),
        ]
        self.tracks = [FakeTrack("Drums"), FakeTrack("Bass")]
        self.view = FakeSongView()
        self.view.selected_track = self.tracks[0]

    @property
    def loop(self):
        return self._loop

    @loop.setter
    def loop(self, value):
        self._loop = value

    @property
    def loop_start(self):
        return self._loop_start

    @loop_start.setter
    def loop_start(self, value):
        self._loop_start = value

    @property
    def loop_length(self):
        return self._loop_length

    @loop_length.setter
    def loop_length(self, value):
        self._loop_length = value
        if self.fail_loop_length_set_after_mutation:
            self.fail_loop_length_set_after_mutation = False
            raise RuntimeError("simulated loop length failure")

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def create_midi_track(self, index):
        self.tracks.insert(index, FakeTrack("MIDI", midi=True))

    def create_audio_track(self, index):
        self.tracks.insert(index, FakeTrack("Audio", midi=False))

    def delete_track(self, index):
        del self.tracks[index]

    def set_or_delete_cue(self):
        existing = next(
            (
                cue_point
                for cue_point in self.cue_points
                if abs(cue_point.time - self.current_song_time) < 0.000001
            ),
            None,
        )
        if existing is not None:
            self.cue_points.remove(existing)
            return None
        cue_point = FakeCuePoint(
            self.current_song_time, str(len(self.cue_points) + 1)
        )
        self.cue_points.append(cue_point)
        if self.fail_cue_create_after_mutation:
            self.fail_cue_create_after_mutation = False
            raise RuntimeError("simulated cue-point create failure")
        return cue_point


class FakeBrowserItem(object):
    def __init__(
        self,
        name,
        uri,
        children=None,
        loadable=False,
        folder=None,
        device=False,
        source="",
    ):
        self.name = name
        self.uri = uri
        self.children = list(children or [])
        self.is_folder = bool(self.children) if folder is None else folder
        self.is_loadable = loadable
        self.is_device = device
        self.source = source

    def iter_children(self):
        return iter(self.children)


class FakeBrowser(object):
    def __init__(self, song=None):
        self.song = song
        self.hotswap_target = None
        self.fail_after_load = False
        operator = FakeBrowserItem(
            "Operator",
            "ableton://instruments/operator",
            loadable=True,
            device=True,
            source="instrument",
        )
        analog = FakeBrowserItem(
            "Analog",
            "ableton://instruments/analog",
            loadable=True,
            device=True,
            source="instrument",
        )
        instruments_folder = FakeBrowserItem(
            "Synths",
            "ableton://instruments/synths",
            [operator, analog],
            folder=True,
        )
        self.instruments = FakeBrowserItem(
            "Instruments",
            "ableton://instruments",
            [instruments_folder],
            folder=True,
        )
        self.audio_effects = FakeBrowserItem(
            "Audio Effects",
            "ableton://audio-effects",
            [
                FakeBrowserItem(
                    "Echo",
                    "ableton://audio-effects/echo",
                    loadable=True,
                    device=True,
                    source="audio_effect",
                )
            ],
            folder=True,
        )
        self.midi_effects = FakeBrowserItem(
            "MIDI Effects",
            "ableton://midi-effects",
            [
                FakeBrowserItem(
                    "Arpeggiator",
                    "ableton://midi-effects/arpeggiator",
                    loadable=True,
                    device=True,
                    source="midi_effect",
                )
            ],
            folder=True,
        )
        for root, name in (
            ("sounds", "Sounds"),
            ("drums", "Drums"),
            ("max_for_live", "Max for Live"),
            ("plugins", "Plug-ins"),
            ("clips", "Clips"),
            ("samples", "Samples"),
            ("packs", "Packs"),
            ("user_library", "User Library"),
            ("current_project", "Current Project"),
        ):
            setattr(
                self,
                root,
                FakeBrowserItem(
                    name, "ableton://{0}".format(root), folder=True
                ),
            )

    def load_item(self, item):
        if self.song is None or self.song.view.selected_track is None:
            raise RuntimeError("no selected track")
        self.song.view.selected_track.devices.append(FakeDevice(item.name))
        if self.fail_after_load:
            self.fail_after_load = False
            raise RuntimeError("simulated browser load failure")


class FakeApplication(object):
    def __init__(self, song=None):
        self.browser = FakeBrowser(song)

    def get_version_string(self):
        return "12.1-test"


class FakeContext(object):
    def __init__(self):
        self.song = FakeSong()
        self.application = FakeApplication(self.song)
        self.scheduled = []
        self.midi_note_factory = FakeMidiNoteSpecification

    def schedule_message(self, delay, callback):
        self.scheduled.append((delay, callback))


class ExecutorTests(unittest.TestCase):
    def test_executes_registered_commands_only_when_scheduled(self):
        scheduled = []
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        context = FakeContext()
        context.song.tracks[1].has_midi_input = False
        context.song.tracks[1].clip_slots[0].clip = FakeClip(
            2.0, midi=False
        )
        executor = MainThreadExecutor(
            lambda delay, callback: scheduled.append((delay, callback)),
            registry,
            context,
        )

        executor.submit(request("session.inspect"), responses.append)

        self.assertEqual(responses, [])
        self.assertEqual(len(scheduled), 1)
        scheduled[0][1]()
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[0]["result"]["trackCount"], 2)
        self.assertEqual(responses[0]["result"]["tracks"][0]["name"], "Drums")
        self.assertEqual(responses[0]["result"]["tracks"][0]["kind"], "midi")
        self.assertEqual(responses[0]["result"]["clips"][0]["kind"], "audio")
        self.assertIsNone(
            responses[0]["result"]["clips"][0]["noteCount"]
        )

    def test_rejects_unknown_commands(self):
        responses = []
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            CommandRegistry(),
            FakeContext(),
        )

        executor.submit(request("missing.command"), responses.append)

        self.assertEqual(responses[0]["error"]["code"], "unknown_command")

    def test_reports_queue_saturation(self):
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            registry,
            FakeContext(),
            max_queue=1,
        )

        executor.submit(request("system.ping"), responses.append)
        executor.submit(request("system.ping"), responses.append)

        self.assertEqual(responses[0]["error"]["code"], "queue_full")

    def test_close_rejects_queued_work(self):
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, _callback: None,
            registry,
            FakeContext(),
        )
        executor.submit(request("system.ping"), responses.append)

        executor.close()

        self.assertEqual(responses[0]["error"]["code"], "internal_error")
        self.assertTrue(responses[0]["error"]["retryable"])

    def test_tempo_mutation_is_validated_and_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("transport.set_tempo", {"tempo": 130.5}),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(context.song.tempo, 130.5)
        self.assertEqual(
            responses[0]["result"],
            {
                "beforeTempo": 124.0,
                "afterTempo": 130.5,
                "verified": True,
            },
        )

    def test_tempo_mutation_rejects_out_of_range_values(self):
        scheduled = []
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            FakeContext(),
        )

        executor.submit(
            request("transport.set_tempo", {"tempo": 2}),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "invalid_params")

    def test_transport_play_state_is_changed_and_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("transport.set_playing", {"isPlaying": False}),
            responses.append,
        )
        scheduled.pop()()
        delay, verify = context.scheduled.pop()
        self.assertEqual(delay, 1)
        self.assertEqual(responses, [])
        verify()

        self.assertFalse(context.song.is_playing)
        self.assertEqual(
            responses[0]["result"],
            {
                "beforeIsPlaying": True,
                "afterIsPlaying": False,
                "verified": True,
            },
        )

    def test_arrangement_transport_inspection_is_bounded_and_stable(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "transport.inspect_arrangement",
                {"offset": 1, "limit": 1},
            ),
            responses.append,
        )
        scheduled.pop()()
        first_reference = responses[0]["result"]["cuePoints"][0][
            "reference"
        ]
        executor.submit(
            request(
                "transport.inspect_arrangement",
                {"offset": 1, "limit": 1},
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(
            responses[0]["result"]["loop"],
            {"enabled": False, "start": 0.0, "length": 16.0},
        )
        self.assertEqual(responses[0]["result"]["totalCuePoints"], 2)
        self.assertEqual(len(responses[0]["result"]["cuePoints"]), 1)
        self.assertEqual(
            responses[1]["result"]["cuePoints"][0]["reference"],
            first_reference,
        )

    def test_arrangement_loop_update_verifies_and_rolls_back_partial_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "transport.set_arrangement_loop",
                {"enabled": True, "start": 8.0, "length": 24.0},
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(
            responses[0]["result"]["after"],
            {"enabled": True, "start": 8.0, "length": 24.0},
        )

        context.song.fail_loop_length_set_after_mutation = True
        executor.submit(
            request(
                "transport.set_arrangement_loop",
                {"enabled": False, "start": 12.0, "length": 8.0},
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[1]["error"]["code"], "lom_error")
        self.assertEqual(
            {
                "enabled": context.song.loop,
                "start": context.song.loop_start,
                "length": context.song.loop_length,
            },
            {"enabled": True, "start": 8.0, "length": 24.0},
        )

    def test_arrangement_loop_rejects_non_finite_and_out_of_bounds_values(self):
        scheduled = []
        responses = []
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            FakeContext(),
        )

        executor.submit(
            request(
                "transport.set_arrangement_loop",
                {"start": float("nan")},
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "transport.set_arrangement_loop",
                {"start": 1576800, "length": 1},
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "invalid_params")
        self.assertEqual(responses[1]["error"]["code"], "invalid_params")

    def test_cue_point_creation_and_identity_bound_deletion(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.is_playing = False
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "transport.create_cue_point",
                {"time": 32.0, "name": "Chorus"},
            ),
            responses.append,
        )
        scheduled.pop()()
        created = responses[0]["result"]["cuePoint"]
        executor.submit(
            request(
                "transport.delete_cue_point",
                {
                    "expectedReference": created["reference"],
                    "expectedName": "Wrong",
                    "expectedTime": 32.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "transport.delete_cue_point",
                {
                    "expectedReference": created["reference"],
                    "expectedName": "Chorus",
                    "expectedTime": 32.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["beforeCuePointCount"], 2)
        self.assertEqual(responses[1]["error"]["code"], "stale_reference")
        self.assertEqual(responses[2]["result"]["afterCuePointCount"], 2)
        self.assertFalse(
            any(cue.name == "Chorus" for cue in context.song.cue_points)
        )
        self.assertEqual(context.song.current_song_time, 4.0)

    def test_cue_point_creation_rolls_back_after_lom_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.is_playing = False
        context.song.fail_cue_create_after_mutation = True
        before = list(context.song.cue_points)
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "transport.create_cue_point",
                {"time": 32.0, "name": "Chorus"},
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(len(context.song.cue_points), len(before))
        self.assertEqual(context.song.current_song_time, 4.0)
        self.assertTrue(
            all(
                any(current is previous for current in context.song.cue_points)
                for previous in before
            )
        )

    def test_cue_point_mutation_requires_stopped_transport(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "transport.create_cue_point",
                {"time": 32.0, "name": "Chorus"},
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "conflict")
        self.assertEqual(context.song.current_song_time, 4.0)

    def test_track_create_and_delete_are_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("tracks.create", {"kind": "audio", "name": "Vocals"}),
            responses.append,
        )
        scheduled.pop()()
        created_reference = responses[0]["result"]["track"]["reference"]
        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 2,
                    "expectedReference": created_reference,
                    "expectedName": "Vocals",
                    "expectedKind": "audio",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["track"]["name"], "Vocals")
        self.assertEqual(responses[0]["result"]["track"]["kind"], "audio")
        self.assertTrue(responses[0]["result"]["verified"])
        self.assertEqual(responses[1]["result"]["track"]["name"], "Vocals")
        self.assertTrue(responses[1]["result"]["verified"])
        self.assertEqual(len(context.song.tracks), 2)

    def test_track_delete_guards_last_track(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks = [FakeTrack("Only")]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 0,
                    "expectedReference": "00000000-0000-4000-8000-000000000001",
                    "expectedName": "Only",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "conflict")

    def test_track_delete_rejects_stale_identity_and_group_tracks(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0] = FakeTrack("Group", group=True)
        context._track_references = [
            (
                context.song.tracks[0],
                "00000000-0000-4000-8000-000000000001",
            ),
            (
                context.song.tracks[1],
                "00000000-0000-4000-8000-000000000002",
            ),
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 1,
                    "expectedReference": "00000000-0000-4000-8000-000000000099",
                    "expectedName": "Moved Track",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "tracks.delete",
                {
                    "index": 0,
                    "expectedReference": "00000000-0000-4000-8000-000000000001",
                    "expectedName": "Group",
                    "expectedKind": "midi",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "stale_reference")
        self.assertEqual(responses[1]["error"]["code"], "conflict")
        self.assertEqual(len(context.song.tracks), 2)

    def test_track_rename_and_mixer_updates_are_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        reference = "00000000-0000-4000-8000-000000000002"
        context._track_references = [(context.song.tracks[1], reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.set_mixer",
                {
                    "index": 1,
                    "expectedReference": reference,
                    "expectedName": "Bass",
                    "isMuted": True,
                    "volume": 0.6,
                    "pan": 0.25,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "tracks.rename",
                {
                    "index": 1,
                    "expectedReference": reference,
                    "expectedName": "Bass",
                    "name": "Sub Bass",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertTrue(responses[0]["result"]["after"]["isMuted"])
        self.assertEqual(responses[0]["result"]["after"]["volume"], 0.6)
        self.assertEqual(responses[0]["result"]["after"]["pan"], 0.25)
        self.assertEqual(responses[1]["result"]["beforeName"], "Bass")
        self.assertEqual(responses[1]["result"]["afterName"], "Sub Bass")
        self.assertEqual(context.song.tracks[1].name, "Sub Bass")

    def test_track_mixer_rejects_unarmable_track_before_other_changes(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0] = FakeTrack("Group", group=True)
        reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [(context.song.tracks[0], reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "tracks.set_mixer",
                {
                    "index": 0,
                    "expectedReference": reference,
                    "expectedName": "Group",
                    "isMuted": True,
                    "isArmed": True,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(
            responses[0]["error"]["code"], "unsupported_capability"
        )
        self.assertFalse(context.song.tracks[0].mute)

    def test_midi_clip_creation_and_note_replacement_are_verified(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [
            (context.song.tracks[0], track_reference)
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.create_midi",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "length": 4.0,
                    "name": "Beat",
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        clip_reference = responses[0]["result"]["clip"]["reference"]
        outside_note = FakeMidiNoteSpecification(48, 8.0, 0.5, 90)
        outside_note.note_id = 1
        context.song.tracks[0].clip_slots[0].clip.notes = [outside_note]
        executor.submit(
            request(
                "clips.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "allowPerNoteExpressionLoss": True,
                    "notes": [
                        {
                            "pitch": 36,
                            "startTime": 0.0,
                            "duration": 0.25,
                            "velocity": 110,
                        },
                        {
                            "pitch": 38,
                            "startTime": 1.0,
                            "duration": 0.25,
                            "velocity": 100,
                            "mute": False,
                        },
                    ],
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["clip"]["name"], "Beat")
        self.assertEqual(responses[0]["result"]["clip"]["noteCount"], 0)
        self.assertEqual(responses[1]["result"]["beforeNoteCount"], 1)
        self.assertEqual(responses[1]["result"]["afterNoteCount"], 2)
        self.assertTrue(responses[1]["result"]["verified"])

    def test_midi_clip_creation_refuses_occupied_slot(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0].clip_slots[0].create_clip(4.0)
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [
            (context.song.tracks[0], track_reference)
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.create_midi",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "length": 4.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "conflict")

    def test_devices_are_bounded_identity_bound_and_mutated_safely(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [
            (context.song.tracks[0], track_reference)
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        track_target = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
        }

        executor.submit(
            request(
                "devices.inspect",
                dict(track_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        device = responses[-1]["result"]["devices"][0]
        self.assertEqual(responses[-1]["result"]["total"], 1)
        self.assertEqual(device["parameterCount"], 3)
        self.assertTrue(device["enabled"])

        device_target = dict(
            track_target,
            deviceIndex=0,
            expectedDeviceReference=device["reference"],
            expectedDeviceName=device["name"],
        )
        executor.submit(
            request(
                "devices.inspect_parameters",
                dict(device_target, offset=1, limit=2),
            ),
            responses.append,
        )
        scheduled.pop()()
        parameter_page = responses[-1]["result"]
        self.assertEqual(parameter_page["total"], 3)
        self.assertEqual(len(parameter_page["parameters"]), 2)
        dry_wet = parameter_page["parameters"][0]
        mode = parameter_page["parameters"][1]

        executor.submit(
            request(
                "devices.set_parameter",
                dict(
                    device_target,
                    parameterIndex=2,
                    expectedParameterReference=mode["reference"],
                    expectedParameterName="Mode",
                    normalizedValue=0.6,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["result"]["after"]["value"], 1.0)
        self.assertEqual(
            responses[-1]["result"]["after"]["normalizedValue"], 0.5
        )

        executor.submit(
            request(
                "devices.set_enabled",
                dict(device_target, enabled=False),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertFalse(responses[-1]["result"]["afterEnabled"])

        context.song.tracks[0].devices[0].parameters[1].is_enabled = False
        executor.submit(
            request(
                "devices.set_parameter",
                dict(
                    device_target,
                    parameterIndex=1,
                    expectedParameterReference=dry_wet["reference"],
                    expectedParameterName="Dry/Wet",
                    normalizedValue=0.75,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["error"]["code"], "conflict")

        context.song.tracks[0].devices[0].parameters[1].is_enabled = True
        context.song.tracks[0].devices[0].parameters[1].is_writable = False
        executor.submit(
            request(
                "devices.set_parameter",
                dict(
                    device_target,
                    parameterIndex=1,
                    expectedParameterReference=dry_wet["reference"],
                    expectedParameterName="Dry/Wet",
                    normalizedValue=0.75,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["error"]["code"], "conflict")

        executor.submit(
            request(
                "devices.set_parameter",
                dict(
                    device_target,
                    parameterIndex=1,
                    expectedParameterReference=dry_wet["reference"],
                    expectedParameterName="Changed",
                    normalizedValue=0.75,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["error"]["code"], "stale_reference")

        removed = context.song.tracks[0].devices[0]
        context.song.tracks[0].devices.append(FakeDevice("Second"))
        context.song.tracks[0].devices.pop(0)
        executor.submit(
            request(
                "devices.inspect",
                dict(track_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        second = responses[-1]["result"]["devices"][0]
        executor.submit(
            request(
                "devices.inspect_parameters",
                dict(
                    track_target,
                    deviceIndex=0,
                    expectedDeviceReference=second["reference"],
                    expectedDeviceName="Second",
                    offset=0,
                    limit=1,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertFalse(
            any(
                candidate is removed
                for candidate, _reference in context._device_references
            )
        )
        self.assertFalse(
            any(
                parameter in removed.parameters
                for parameter, _reference in context._parameter_references
            )
        )

    def test_device_parameter_rolls_back_partial_setter_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        device_reference = "00000000-0000-4000-8000-000000000040"
        parameter_reference = "00000000-0000-4000-8000-000000000041"
        context._track_references = [(track, track_reference)]
        context._device_references = [(track.devices[0], device_reference)]
        parameter = track.devices[0].parameters[1]
        context._parameter_references = [(parameter, parameter_reference)]
        parameter.fail_next_set_after_mutation = True
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "devices.set_parameter",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "deviceIndex": 0,
                    "expectedDeviceReference": device_reference,
                    "expectedDeviceName": "Instrument Rack",
                    "parameterIndex": 1,
                    "expectedParameterReference": parameter_reference,
                    "expectedParameterName": "Dry/Wet",
                    "normalizedValue": 0.75,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(parameter.value, 0.25)

    def test_rack_chain_and_drum_pad_inspection_is_bounded_and_identity_safe(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.devices[0] = FakeDevice("Drum Rack")
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [(track, track_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        track_target = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
        }
        executor.submit(
            request(
                "devices.inspect",
                dict(track_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        rack = responses[-1]["result"]["devices"][0]
        self.assertTrue(rack["canHaveChains"])
        self.assertTrue(rack["canHaveDrumPads"])
        rack_target = dict(
            track_target,
            deviceIndex=0,
            expectedDeviceReference=rack["reference"],
            expectedDeviceName=rack["name"],
        )

        executor.submit(
            request(
                "devices.inspect_rack_chains",
                dict(rack_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        chain_page = responses[-1]["result"]
        self.assertEqual(chain_page["total"], 2)
        chain = chain_page["chains"][0]
        chain_target = dict(
            rack_target,
            chainIndex=chain["index"],
            expectedChainReference=chain["reference"],
            expectedChainName=chain["name"],
        )
        executor.submit(
            request(
                "devices.inspect_rack_chain_devices",
                dict(chain_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["result"]["total"], 1)
        self.assertEqual(
            responses[-1]["result"]["devices"][0]["name"], "Simpler"
        )

        executor.submit(
            request(
                "devices.inspect_drum_rack_pads",
                dict(rack_target, offset=36, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        pad_page = responses[-1]["result"]
        self.assertEqual(pad_page["total"], 128)
        self.assertEqual(len(pad_page["pads"]), 1)
        pad = pad_page["pads"][0]
        pad_target = dict(
            rack_target,
            padIndex=pad["index"],
            expectedPadReference=pad["reference"],
            expectedPadNote=pad["note"],
            expectedPadName=pad["name"],
        )
        executor.submit(
            request(
                "devices.inspect_drum_pad_chains",
                dict(pad_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        pad_chain = responses[-1]["result"]["chains"][0]
        self.assertEqual(pad_chain["reference"], chain["reference"])
        pad_chain_target = dict(
            pad_target,
            chainIndex=pad_chain["index"],
            expectedChainReference=pad_chain["reference"],
            expectedChainName=pad_chain["name"],
        )
        executor.submit(
            request(
                "devices.inspect_drum_pad_chain_devices",
                dict(pad_chain_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(
            responses[-1]["result"]["devices"][0]["name"], "Simpler"
        )

        executor.submit(
            request(
                "devices.inspect_rack_chain_devices",
                dict(
                    chain_target,
                    expectedChainName="Changed",
                    offset=0,
                    limit=1,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertEqual(responses[-1]["error"]["code"], "stale_reference")

        old_chain = track.devices[0].chains[0]
        old_pad = track.devices[0].drum_pads[36]
        old_nested = old_chain.devices[0]
        track.devices[0] = FakeDevice("Drum Rack")
        executor.submit(
            request(
                "devices.inspect",
                dict(track_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        replacement = responses[-1]["result"]["devices"][0]
        replacement_target = dict(
            track_target,
            deviceIndex=0,
            expectedDeviceReference=replacement["reference"],
            expectedDeviceName=replacement["name"],
        )
        executor.submit(
            request(
                "devices.inspect_rack_chains",
                dict(replacement_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        replacement_chain = responses[-1]["result"]["chains"][0]
        executor.submit(
            request(
                "devices.inspect_rack_chain_devices",
                dict(
                    replacement_target,
                    chainIndex=0,
                    expectedChainReference=replacement_chain["reference"],
                    expectedChainName=replacement_chain["name"],
                    offset=0,
                    limit=1,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "devices.inspect_drum_rack_pads",
                dict(replacement_target, offset=0, limit=1),
            ),
            responses.append,
        )
        scheduled.pop()()
        self.assertFalse(
            any(
                candidate is old_chain
                for candidate, _reference in context._chain_references
            )
        )
        self.assertFalse(
            any(
                candidate is old_pad
                for candidate, _reference in context._pad_references
            )
        )
        self.assertFalse(
            any(
                candidate is old_nested
                for candidate, _reference in context._chain_device_references
            )
        )

    def test_midi_clip_creation_rolls_back_when_summary_is_unsupported(self):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0].clip_slots[0] = FakeUnsupportedClipSlot()
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [
            (context.song.tracks[0], track_reference)
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.create_midi",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "length": 4.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(
            responses[0]["error"]["code"], "unsupported_capability"
        )
        self.assertFalse(context.song.tracks[0].clip_slots[0].has_clip)

    def test_midi_clip_creation_rolls_back_when_create_raises_after_mutation(
        self,
    ):
        scheduled = []
        responses = []
        context = FakeContext()
        context.song.tracks[0].clip_slots[0] = FakeCreateThenFailClipSlot()
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [
            (context.song.tracks[0], track_reference)
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.create_midi",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "length": 4.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertFalse(context.song.tracks[0].clip_slots[0].has_clip)

    def test_midi_note_replacement_restores_originals_after_add_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.clip_slots[0].create_clip(4.0)
        clip = track.clip_slots[0].clip
        original = FakeMidiNoteSpecification(48, 0.0, 0.5, 90)
        original.note_id = 1
        clip.notes = [original]
        clip.fail_next_add = True
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(clip, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "allowPerNoteExpressionLoss": True,
                    "notes": [
                        {
                            "pitch": 36,
                            "startTime": 0.0,
                            "duration": 0.25,
                            "velocity": 110,
                        }
                    ],
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(len(clip.notes), 1)
        self.assertEqual(clip.notes[0].pitch, 48)

    def test_midi_note_replacement_requires_expression_loss_opt_in(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.clip_slots[0].create_clip(4.0)
        clip = track.clip_slots[0].clip
        original = FakeMidiNoteSpecification(48, 0.0, 0.5, 90)
        original.note_id = 1
        clip.notes = [original]
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(clip, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "allowPerNoteExpressionLoss": False,
                    "notes": [],
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "conflict")
        self.assertEqual(len(clip.notes), 1)

    def test_midi_note_replacement_restores_originals_after_read_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.clip_slots[0].create_clip(4.0)
        clip = track.clip_slots[0].clip
        original = FakeMidiNoteSpecification(48, 0.0, 0.5, 90)
        original.note_id = 1
        clip.notes = [original]
        clip.fail_get_notes_call = 3
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(clip, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "allowPerNoteExpressionLoss": True,
                    "notes": [
                        {
                            "pitch": 36,
                            "startTime": 0.0,
                            "duration": 0.25,
                            "velocity": 110,
                        }
                    ],
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(len(clip.notes), 1)
        self.assertEqual(clip.notes[0].pitch, 48)

    def test_session_clip_launch_duplicate_properties_and_delete_are_verified(
        self,
    ):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.clip_slots[0].create_clip(4.0)
        source = track.clip_slots[0].clip
        source.name = "Beat"
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(source, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        target = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
            "sceneIndex": 0,
            "expectedClipReference": clip_reference,
        }

        executor.submit(
            request("clips.launch", target),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "clips.duplicate",
                dict(
                    target,
                    destinationTrackIndex=0,
                    expectedDestinationTrackReference=track_reference,
                    expectedDestinationTrackName="Drums",
                    destinationSceneIndex=1,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        duplicated_reference = responses[1]["result"]["clip"]["reference"]
        executor.submit(
            request(
                "clips.set_properties",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 1,
                    "expectedClipReference": duplicated_reference,
                    "name": "Beat Copy",
                    "muted": True,
                    "looping": False,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "clips.delete",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 1,
                    "expectedClipReference": duplicated_reference,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(request("clips.launch", target), responses.append)
        scheduled.pop()()

        self.assertTrue(responses[0]["result"]["after"]["targetIsPlaying"])
        self.assertEqual(
            responses[1]["result"]["sourceClip"]["reference"],
            clip_reference,
        )
        self.assertEqual(
            responses[2]["result"]["after"],
            {"name": "Beat Copy", "muted": True, "looping": False},
        )
        self.assertEqual(responses[3]["result"]["beforeClipCount"], 2)
        self.assertEqual(responses[3]["result"]["afterClipCount"], 1)
        self.assertFalse(track.clip_slots[1].has_clip)
        self.assertEqual(responses[4]["result"]["before"], responses[4]["result"]["after"])
        self.assertEqual(track.clip_slots[0].fire_calls, 1)

    def test_session_audio_clip_duplication_and_properties_are_supported(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[1]
        track.has_midi_input = False
        track.clip_slots[0].clip = FakeClip(8.0, midi=False)
        source = track.clip_slots[0].clip
        source.name = "Vocal"
        track_reference = "00000000-0000-4000-8000-000000000002"
        clip_reference = "00000000-0000-4000-8000-000000000020"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(source, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "clips.duplicate",
                {
                    "index": 1,
                    "expectedReference": track_reference,
                    "expectedName": "Bass",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "destinationTrackIndex": 1,
                    "expectedDestinationTrackReference": track_reference,
                    "expectedDestinationTrackName": "Bass",
                    "destinationSceneIndex": 1,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        duplicated_reference = responses[0]["result"]["clip"]["reference"]
        executor.submit(
            request(
                "clips.set_properties",
                {
                    "index": 1,
                    "expectedReference": track_reference,
                    "expectedName": "Bass",
                    "sceneIndex": 1,
                    "expectedClipReference": duplicated_reference,
                    "name": "Vocal Copy",
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["clip"]["kind"], "audio")
        self.assertIsNone(responses[0]["result"]["clip"]["noteCount"])
        self.assertEqual(responses[1]["result"]["after"]["name"], "Vocal Copy")

    def test_session_clip_mutations_restore_safe_before_state_on_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.clip_slots[0].create_clip(4.0)
        previous = track.clip_slots[0].clip
        track.clip_slots[0].fire()
        track.clip_slots[1].clip = FailingMutedClip(4.0)
        target = track.clip_slots[1].clip
        target.name = "Before"
        track.clip_slots[1].fail_fire_after_mutation = True
        track.clip_slots[1].fail_duplicate_after_mutation = True
        track_reference = "00000000-0000-4000-8000-000000000001"
        destination_track_reference = (
            "00000000-0000-4000-8000-000000000002"
        )
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [
            (track, track_reference),
            (context.song.tracks[1], destination_track_reference),
        ]
        context._clip_references = [(target, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        target_params = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
            "sceneIndex": 1,
            "expectedClipReference": clip_reference,
        }

        executor.submit(
            request("clips.launch", target_params),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "clips.duplicate",
                dict(
                    target_params,
                    destinationTrackIndex=1,
                    expectedDestinationTrackReference=(
                        destination_track_reference
                    ),
                    expectedDestinationTrackName="Bass",
                    destinationSceneIndex=0,
                ),
            ),
            responses.append,
        )
        scheduled.pop()()
        target.fail_muted_set = True
        executor.submit(
            request(
                "clips.set_properties",
                dict(target_params, name="After", muted=True),
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertTrue(previous.is_playing)
        self.assertEqual(track.playing_slot_index, 0)
        self.assertEqual(responses[1]["error"]["code"], "lom_error")
        self.assertFalse(context.song.tracks[1].clip_slots[0].has_clip)
        self.assertEqual(responses[2]["error"]["code"], "lom_error")
        self.assertEqual(target.name, "Before")
        self.assertFalse(target.muted)

    def test_arrangement_midi_clip_creation_guards_overlap(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [(track, track_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        params = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
            "startTime": 8.0,
            "length": 4.0,
            "name": "Verse",
        }

        executor.submit(
            request("arrangement.create_midi_clip", params),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request("arrangement.create_midi_clip", params),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["clip"]["startTime"], 8.0)
        self.assertEqual(responses[0]["result"]["clip"]["endTime"], 12.0)
        self.assertTrue(responses[0]["result"]["verified"])
        self.assertEqual(responses[1]["error"]["code"], "conflict")
        self.assertEqual(len(track.arrangement_clips), 1)

        executor.submit(
            request("arrangement.inspect", {"offset": 0, "limit": 10}),
            responses.append,
        )
        scheduled.pop()()
        clip_reference = responses[2]["result"]["clips"][0]["reference"]
        executor.submit(
            request(
                "arrangement.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "expectedClipReference": clip_reference,
                    "expectedStartTime": 8.0,
                    "allowPerNoteExpressionLoss": False,
                    "notes": [
                        {
                            "pitch": 60,
                            "startTime": 0.0,
                            "duration": 1.0,
                            "velocity": 100,
                        }
                    ],
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "arrangement.replace_notes",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "expectedClipReference": clip_reference,
                    "expectedStartTime": 8.0,
                    "allowPerNoteExpressionLoss": True,
                    "notes": [
                        {
                            "pitch": 64,
                            "startTime": 4.0,
                            "duration": 1.0,
                            "velocity": 100,
                        }
                    ],
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "arrangement.delete_clip",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "expectedClipReference": clip_reference,
                    "expectedStartTime": 8.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[2]["result"]["total"], 1)
        self.assertEqual(responses[2]["result"]["clips"][0]["kind"], "midi")
        self.assertEqual(responses[3]["result"]["beforeNoteCount"], 0)
        self.assertEqual(responses[3]["result"]["afterNoteCount"], 1)
        self.assertEqual(responses[4]["error"]["code"], "invalid_params")
        self.assertEqual(responses[5]["result"]["beforeClipCount"], 1)
        self.assertEqual(responses[5]["result"]["afterClipCount"], 0)
        self.assertEqual(track.arrangement_clips, [])

    def test_arrangement_creation_rolls_back_when_create_raises(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        track.fail_arrangement_create_after_mutation = True
        track_reference = "00000000-0000-4000-8000-000000000001"
        context._track_references = [(track, track_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "arrangement.create_midi_clip",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "startTime": 8.0,
                    "length": 4.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(track.arrangement_clips, [])

    def test_arrangement_duplication_guards_audio_overlap_and_identity(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        midi_source = FakeClip(4.0)
        midi_source.name = "MIDI Source"
        audio_source = FakeClip(2.0, midi=False)
        audio_source.name = "Audio Source"
        track.clip_slots[0].clip = midi_source
        track.clip_slots[1].clip = audio_source
        track_reference = "00000000-0000-4000-8000-000000000001"
        midi_reference = "00000000-0000-4000-8000-000000000010"
        audio_reference = "00000000-0000-4000-8000-000000000011"
        context._track_references = [(track, track_reference)]
        context._clip_references = [
            (midi_source, midi_reference),
            (audio_source, audio_reference),
        ]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        for scene_index, clip_reference, destination_time in (
            (0, midi_reference, 8.0),
            (1, audio_reference, 16.0),
        ):
            executor.submit(
                request(
                    "arrangement.duplicate_clip",
                    {
                        "index": 0,
                        "expectedReference": track_reference,
                        "expectedName": "Drums",
                        "sceneIndex": scene_index,
                        "expectedClipReference": clip_reference,
                        "destinationTime": destination_time,
                    },
                ),
                responses.append,
            )
            scheduled.pop()()

        executor.submit(
            request(
                "arrangement.duplicate_clip",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": midi_reference,
                    "destinationTime": 9.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "arrangement.duplicate_clip",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": audio_reference,
                    "destinationTime": 24.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["result"]["sourceClip"]["kind"], "midi")
        self.assertEqual(responses[0]["result"]["beforeClipCount"], 0)
        self.assertEqual(responses[0]["result"]["afterClipCount"], 1)
        self.assertEqual(
            responses[1]["error"]["code"], "unsupported_capability"
        )
        self.assertEqual(responses[2]["error"]["code"], "conflict")
        self.assertEqual(responses[3]["error"]["code"], "stale_reference")
        self.assertEqual(len(track.arrangement_clips), 1)

    def test_arrangement_duplication_rolls_back_after_lom_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        source = FakeClip(4.0)
        track.clip_slots[0].clip = source
        track.fail_arrangement_duplicate_after_mutation = True
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000010"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(source, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request(
                "arrangement.duplicate_clip",
                {
                    "index": 0,
                    "expectedReference": track_reference,
                    "expectedName": "Drums",
                    "sceneIndex": 0,
                    "expectedClipReference": clip_reference,
                    "destinationTime": 8.0,
                },
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(responses[0]["error"]["code"], "lom_error")
        self.assertEqual(track.arrangement_clips, [])

    def test_arrangement_clip_properties_verify_and_restore_on_failure(self):
        scheduled = []
        responses = []
        context = FakeContext()
        track = context.song.tracks[0]
        clip = FailingMutedClip(4.0, 8.0)
        clip.name = "Before"
        track.arrangement_clips = [clip]
        track_reference = "00000000-0000-4000-8000-000000000001"
        clip_reference = "00000000-0000-4000-8000-000000000020"
        context._track_references = [(track, track_reference)]
        context._clip_references = [(clip, clip_reference)]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )
        identity = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": "Drums",
            "expectedClipReference": clip_reference,
            "expectedStartTime": 8.0,
        }

        executor.submit(
            request(
                "arrangement.set_clip_properties",
                dict(identity, name="After", muted=True, looping=False),
            ),
            responses.append,
        )
        scheduled.pop()()
        executor.submit(
            request(
                "arrangement.set_clip_properties",
                identity,
            ),
            responses.append,
        )
        scheduled.pop()()
        clip.fail_muted_set = True
        executor.submit(
            request(
                "arrangement.set_clip_properties",
                dict(identity, name="Should Roll Back", muted=False),
            ),
            responses.append,
        )
        scheduled.pop()()
        del clip.looping
        executor.submit(
            request(
                "arrangement.set_clip_properties",
                dict(identity, looping=True),
            ),
            responses.append,
        )
        scheduled.pop()()

        self.assertEqual(
            responses[0]["result"]["before"],
            {"name": "Before", "muted": False, "looping": True},
        )
        self.assertEqual(
            responses[0]["result"]["after"],
            {"name": "After", "muted": True, "looping": False},
        )
        self.assertEqual(responses[1]["error"]["code"], "invalid_params")
        self.assertEqual(responses[2]["error"]["code"], "lom_error")
        self.assertEqual(clip.name, "After")
        self.assertTrue(clip.muted)
        self.assertEqual(
            responses[3]["error"]["code"], "unsupported_capability"
        )

    def test_arrangement_inspection_serializes_only_requested_page(self):
        scheduled = []
        responses = []
        context = FakeContext()
        first = FakeClip(4.0, 0.0)
        second = FakeClip(4.0, 8.0)
        second.fail_get_notes_call = 1
        context.song.tracks[0].arrangement_clips = [first, second]
        registry = CommandRegistry()
        register_system_commands(registry)
        executor = MainThreadExecutor(
            lambda _delay, callback: scheduled.append(callback),
            registry,
            context,
        )

        executor.submit(
            request("arrangement.inspect", {"offset": 0, "limit": 1}),
            responses.append,
        )
        scheduled.pop()()

        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[0]["result"]["total"], 2)
        self.assertEqual(len(responses[0]["result"]["clips"]), 1)
        self.assertEqual(first.get_notes_calls, 1)
        self.assertEqual(second.get_notes_calls, 0)


class BrowserCommandTests(unittest.TestCase):
    def setUp(self):
        self.context = FakeContext()
        self.registry = CommandRegistry()
        register_system_commands(self.registry)

    def execute(self, command, params=None):
        return self.registry.get(command).execute(self.context, params or {})

    def test_inspection_and_search_are_bounded_and_deterministic(self):
        roots = self.execute("browser.inspect_roots")
        instruments = next(
            root for root in roots["roots"] if root["root"] == "instruments"
        )
        page = self.execute(
            "browser.inspect_children",
            {
                "expectedItemReference": instruments["reference"],
                "expectedItemRoot": instruments["root"],
                "expectedItemPath": instruments["path"],
                "expectedItemName": instruments["name"],
                "expectedItemUri": instruments["uri"],
                "offset": 0,
                "limit": 1,
            },
        )
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["name"], "Synths")

        first = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 2,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )
        second = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 2,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )
        self.assertEqual(first["visitedNodes"], 4)
        self.assertEqual(first["items"][0]["name"], "Operator")
        self.assertEqual(
            first["items"][0]["reference"],
            second["items"][0]["reference"],
        )

        limited = self.execute(
            "browser.search",
            {
                "query": "not-present",
                "roots": ["instruments"],
                "maxNodes": 1,
                "maxResults": 2,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )
        self.assertTrue(limited["truncated"])
        self.assertEqual(limited["stopReason"], "node_limit")
        shallow = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 2,
                "maxDepth": 0,
                "maxDurationMs": 100,
            },
        )
        self.assertTrue(shallow["truncated"])
        self.assertEqual(shallow["stopReason"], "depth_limit")

    def test_loads_only_exact_built_in_items_to_exact_regular_track(self):
        track = self.context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        self.context._track_references = [(track, track_reference)]
        item = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 1,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )["items"][0]
        result = self.execute(
            "browser.load_item",
            {
                "index": 0,
                "expectedReference": track_reference,
                "expectedName": track.name,
                "expectedItemReference": item["reference"],
                "expectedItemRoot": item["root"],
                "expectedItemPath": item["path"],
                "expectedItemName": item["name"],
                "expectedItemUri": item["uri"],
            },
        )
        self.assertTrue(result["verified"])
        self.assertEqual(result["before"]["deviceCount"], 1)
        self.assertEqual(result["after"]["deviceCount"], 2)
        self.assertEqual(result["addedDevices"][0]["name"], "Operator")

    def test_rejects_external_plugins_and_stale_browser_paths(self):
        roots = self.execute("browser.inspect_roots")["roots"]
        plugins = next(root for root in roots if root["root"] == "plugins")
        plugins_item = self.context.application.browser.plugins
        plugins_item.children.append(
            FakeBrowserItem(
                "External Synth",
                "ableton://plugins/external-synth",
                loadable=True,
            )
        )
        child = self.execute(
            "browser.inspect_children",
            {
                "expectedItemReference": plugins["reference"],
                "expectedItemRoot": plugins["root"],
                "expectedItemPath": plugins["path"],
                "expectedItemName": plugins["name"],
                "expectedItemUri": plugins["uri"],
                "offset": 0,
                "limit": 1,
            },
        )["items"][0]
        track = self.context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        self.context._track_references = [(track, track_reference)]
        params = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": track.name,
            "expectedItemReference": child["reference"],
            "expectedItemRoot": child["root"],
            "expectedItemPath": child["path"],
            "expectedItemName": child["name"],
            "expectedItemUri": child["uri"],
        }
        with self.assertRaisesRegex(Exception, "Only trusted built-in device"):
            self.execute("browser.load_item", params)
        plugins_item.children[0].name = "Changed"
        with self.assertRaisesRegex(Exception, "path name changed"):
            self.execute("browser.load_item", params)

    def test_browser_reference_cache_is_bounded_and_prunes_old_items(self):
        browser = self.context.application.browser
        browser.instruments.children = [
            FakeBrowserItem(
                "Item {0}".format(index),
                "ableton://instruments/item-{0}".format(index),
                loadable=True,
            )
            for index in range(520)
        ]
        bounded = self.execute(
            "browser.search",
            {
                "query": "not-present",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 4,
                "maxDepth": 2,
                "maxDurationMs": 100,
            },
        )
        self.assertEqual(bounded["visitedNodes"], 8)
        self.assertTrue(bounded["truncated"])
        self.assertEqual(bounded["stopReason"], "node_limit")
        roots = self.execute("browser.inspect_roots")["roots"]
        instruments = next(
            root for root in roots if root["root"] == "instruments"
        )
        first_reference = None
        for offset in range(0, 520, 64):
            page = self.execute(
                "browser.inspect_children",
                {
                    "expectedItemReference": instruments["reference"],
                    "expectedItemRoot": instruments["root"],
                    "expectedItemPath": instruments["path"],
                    "expectedItemName": instruments["name"],
                    "expectedItemUri": instruments["uri"],
                    "offset": offset,
                    "limit": 64,
                },
            )
            if offset == 0:
                first_reference = page["items"][0]["reference"]
        self.assertLessEqual(
            len(self.context._browser_reference_cache), 512
        )
        first_again = self.execute(
            "browser.inspect_children",
            {
                "expectedItemReference": instruments["reference"],
                "expectedItemRoot": instruments["root"],
                "expectedItemPath": instruments["path"],
                "expectedItemName": instruments["name"],
                "expectedItemUri": instruments["uri"],
                "offset": 0,
                "limit": 1,
            },
        )["items"][0]
        self.assertNotEqual(first_again["reference"], first_reference)

    def test_surfaces_indeterminate_load_after_partial_lom_failure(self):
        track = self.context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        self.context._track_references = [(track, track_reference)]
        item = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 1,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )["items"][0]
        self.context.application.browser.fail_after_load = True
        params = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": track.name,
            "expectedItemReference": item["reference"],
            "expectedItemRoot": item["root"],
            "expectedItemPath": item["path"],
            "expectedItemName": item["name"],
            "expectedItemUri": item["uri"],
        }
        with self.assertRaises(Exception) as raised:
            self.execute("browser.load_item", params)
        self.assertEqual(raised.exception.code, "lom_error")
        self.assertEqual(
            raised.exception.details["outcome"], "indeterminate"
        )
        self.assertEqual(raised.exception.details["before"]["deviceCount"], 1)
        self.assertEqual(raised.exception.details["after"]["deviceCount"], 2)

    def test_rejects_active_hotswap_and_incompatible_track(self):
        item = self.execute(
            "browser.search",
            {
                "query": "operator",
                "roots": ["instruments"],
                "maxNodes": 8,
                "maxResults": 1,
                "maxDepth": 3,
                "maxDurationMs": 100,
            },
        )["items"][0]
        track = self.context.song.tracks[0]
        track_reference = "00000000-0000-4000-8000-000000000001"
        self.context._track_references = [(track, track_reference)]
        params = {
            "index": 0,
            "expectedReference": track_reference,
            "expectedName": track.name,
            "expectedItemReference": item["reference"],
            "expectedItemRoot": item["root"],
            "expectedItemPath": item["path"],
            "expectedItemName": item["name"],
            "expectedItemUri": item["uri"],
        }
        self.context.application.browser.hotswap_target = object()
        with self.assertRaisesRegex(Exception, "hotswap"):
            self.execute("browser.load_item", params)
        self.context.application.browser.hotswap_target = None
        track.has_midi_input = False
        with self.assertRaisesRegex(Exception, "requires a MIDI track"):
            self.execute("browser.load_item", params)


class CapabilityAndTokenTests(unittest.TestCase):
    def test_capabilities_reflect_registry(self):
        registry = CommandRegistry()
        register_system_commands(registry)
        document = build_capability_document(
            FakeApplication(),
            FakeSong(),
            registry,
            note_editing_supported=True,
        )

        self.assertEqual(document["liveVersion"], "12.1-test")
        self.assertTrue(document["capabilities"]["session.inspect"])
        self.assertTrue(
            document["capabilities"]["arrangement.create_midi_clip"]
        )
        self.assertTrue(document["capabilities"]["clips.launch"])
        self.assertTrue(document["capabilities"]["clips.duplicate"])
        self.assertTrue(document["capabilities"]["clips.delete"])
        self.assertTrue(document["capabilities"]["clips.set_properties"])
        self.assertTrue(
            document["capabilities"]["transport.inspect_arrangement"]
        )
        self.assertTrue(
            document["capabilities"]["transport.set_arrangement_loop"]
        )
        self.assertTrue(
            document["capabilities"]["transport.create_cue_point"]
        )
        self.assertTrue(
            document["capabilities"]["transport.delete_cue_point"]
        )
        self.assertTrue(
            document["capabilities"]["devices.inspect_rack_chains"]
        )
        self.assertTrue(
            document["capabilities"]["devices.inspect_rack_chain_devices"]
        )
        self.assertTrue(
            document["capabilities"]["devices.inspect_drum_rack_pads"]
        )
        self.assertTrue(
            document["capabilities"]["devices.inspect_drum_pad_chains"]
        )
        self.assertTrue(
            document["capabilities"][
                "devices.inspect_drum_pad_chain_devices"
            ]
        )
        self.assertTrue(document["capabilities"]["browser.inspect_roots"])
        self.assertTrue(document["capabilities"]["browser.inspect_children"])
        self.assertTrue(document["capabilities"]["browser.search"])
        self.assertTrue(document["capabilities"]["browser.load_item"])
        self.assertEqual(len(document["projectId"]), 24)

        legacy_transport_song = FakeSong()
        del legacy_transport_song.cue_points
        del legacy_transport_song._loop_length
        legacy_transport_document = build_capability_document(
            FakeApplication(),
            legacy_transport_song,
            registry,
            note_editing_supported=True,
        )
        self.assertFalse(
            legacy_transport_document["capabilities"][
                "transport.inspect_arrangement"
            ]
        )
        self.assertFalse(
            legacy_transport_document["capabilities"][
                "transport.set_arrangement_loop"
            ]
        )
        self.assertFalse(
            legacy_transport_document["capabilities"][
                "transport.create_cue_point"
            ]
        )
        self.assertFalse(
            legacy_transport_document["capabilities"][
                "transport.delete_cue_point"
            ]
        )

        legacy_song = FakeSong()
        legacy_song.tracks = [object()]
        legacy_document = build_capability_document(
            FakeApplication(),
            legacy_song,
            registry,
            note_editing_supported=False,
        )
        self.assertFalse(
            legacy_document["capabilities"]["arrangement.create_midi_clip"]
        )
        self.assertFalse(
            legacy_document["capabilities"]["arrangement.inspect"]
        )
        self.assertFalse(
            legacy_document["capabilities"]["arrangement.delete_clip"]
        )
        self.assertFalse(
            legacy_document["capabilities"]["arrangement.replace_notes"]
        )
        self.assertFalse(
            legacy_document["capabilities"]["arrangement.duplicate_clip"]
        )
        self.assertFalse(
            legacy_document["capabilities"][
                "arrangement.set_clip_properties"
            ]
        )
        self.assertFalse(legacy_document["capabilities"]["clips.launch"])
        self.assertFalse(legacy_document["capabilities"]["clips.duplicate"])
        self.assertFalse(legacy_document["capabilities"]["clips.delete"])
        self.assertFalse(
            legacy_document["capabilities"]["clips.set_properties"]
        )

        class InspectOnlyTrack(object):
            arrangement_clips = []

        inspect_document = build_capability_document(
            FakeApplication(),
            type("Song", (), {"tracks": [InspectOnlyTrack()], "name": "Test"})(),
            registry,
            note_editing_supported=False,
        )
        self.assertTrue(
            inspect_document["capabilities"]["arrangement.inspect"]
        )
        self.assertFalse(
            inspect_document["capabilities"]["arrangement.create_midi_clip"]
        )
        self.assertFalse(
            inspect_document["capabilities"]["arrangement.delete_clip"]
        )
        self.assertFalse(
            inspect_document["capabilities"]["arrangement.replace_notes"]
        )
        self.assertFalse(
            inspect_document["capabilities"]["arrangement.duplicate_clip"]
        )
        self.assertTrue(
            inspect_document["capabilities"][
                "arrangement.set_clip_properties"
            ]
        )

        empty_document = build_capability_document(
            FakeApplication(),
            type("Song", (), {"tracks": [], "name": "Empty"})(),
            registry,
            note_editing_supported=False,
        )
        self.assertTrue(
            empty_document["capabilities"]["arrangement.inspect"]
        )

        class BrowserlessApplication(object):
            def get_version_string(self):
                return "11-test"

        browserless_document = build_capability_document(
            BrowserlessApplication(),
            FakeSong(),
            registry,
            note_editing_supported=True,
        )
        self.assertFalse(
            browserless_document["capabilities"]["browser.inspect_roots"]
        )
        self.assertFalse(
            browserless_document["capabilities"]["browser.load_item"]
        )

    def test_token_is_created_once(self):
        with tempfile.TemporaryDirectory() as directory:
            first = load_or_create_token(directory)
            second = load_or_create_token(directory)

            self.assertEqual(first, second)
            self.assertEqual(len(first), 64)
            self.assertTrue(
                os.path.exists(os.path.join(directory, ".ableton-agent-token"))
            )


class ImmediateExecutor(object):
    def submit(self, incoming, callback):
        callback(success(incoming, {"pong": True}))


class ServerTests(unittest.TestCase):
    token = "server-test-token-that-is-at-least-thirty-two-chars"

    def setUp(self):
        self.server = RemoteScriptServer(
            ImmediateExecutor(),
            self.token,
            {
                "selectedProtocolVersion": PROTOCOL_VERSION,
                "liveVersion": "12.1-test",
                "remoteScriptVersion": "0.3.0",
                "projectId": "test-project",
                "capabilities": {"system.ping": True},
                "limits": {
                    "maxFrameBytes": 4 * 1024 * 1024,
                    "maxBatchItems": 128,
                },
            },
            port=0,
        )
        self.server.start()
        self.client = socket.create_connection(
            (LOOPBACK_HOST, self.server.port), timeout=1.0
        )
        self.client.settimeout(1.0)
        self.decoder = FrameDecoder()

    def tearDown(self):
        self.client.close()
        self.server.stop()

    def exchange(self, incoming):
        self.client.sendall(encode_frame(incoming))
        while True:
            messages = self.decoder.push(self.client.recv(65536))
            if messages:
                return messages[0]

    def test_requires_authenticated_hello_then_dispatches(self):
        hello = self.exchange(
            request(
                "system.hello",
                {
                    "authenticationToken": self.token,
                    "supportedProtocolVersions": [PROTOCOL_VERSION],
                    "appVersion": "test",
                    "eventSubscriptions": [],
                },
            )
        )
        ping = self.exchange(request("system.ping"))

        self.assertTrue(hello["ok"])
        self.assertEqual(hello["result"]["projectId"], "test-project")
        self.assertEqual(ping["result"], {"pong": True})

    def test_rejects_commands_before_authentication(self):
        response = self.exchange(request("system.ping"))

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "authentication_failed")

    def test_server_runs_on_background_thread(self):
        self.assertNotEqual(self.server._thread.ident, threading.current_thread().ident)

    def test_send_failure_does_not_escape_outbound_flush(self):
        class FailingClient(object):
            def sendall(self, _payload):
                raise OSError("client disconnected")

        self.server._enqueue({"message": "will fail"})

        self.assertFalse(self.server._flush_outbound(FailingClient()))


if __name__ == "__main__":
    unittest.main()
