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
    def __init__(self, value):
        self.value = value


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


class FakeSong(object):
    def __init__(self):
        self.tempo = 124.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.is_playing = True
        self.file_path = "/tmp/example.als"
        self.tracks = [FakeTrack("Drums"), FakeTrack("Bass")]

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


class FakeApplication(object):
    def get_version_string(self):
        return "12.1-test"


class FakeContext(object):
    def __init__(self):
        self.song = FakeSong()
        self.application = FakeApplication()
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
        self.assertEqual(len(document["projectId"]), 24)

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
                "remoteScriptVersion": "0.2.0",
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
