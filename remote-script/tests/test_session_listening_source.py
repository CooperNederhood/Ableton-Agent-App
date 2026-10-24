import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent import session_listening_source as source_module
from AbletonAgent.core_domain_commands import _clip_reference, _track_reference
from AbletonAgent.errors import ProtocolFailure
from AbletonAgent.registry import CommandRegistry
from AbletonAgent.session_listening_source import (
    inspect_session_listening_source, register_session_listening_source,
)


class CanonicalClipLaunchQuantization:
    q_global = 0
    q_none = 1
    q_8_bars = 2
    q_4_bars = 3
    q_2_bars = 4
    q_bar = 5
    q_half = 6
    q_half_triplet = 7
    q_quarter = 8
    q_quarter_triplet = 9
    q_eighth = 10
    q_eighth_triplet = 11
    q_sixteenth = 12
    q_sixteenth_triplet = 13
    q_thirtysecond = 14


def native_launch_enum(**overrides):
    members = {name: value for name, value in vars(CanonicalClipLaunchQuantization).items()
               if name.startswith("q_")}
    return type("ClipLaunchQuantization", (), {**members, **overrides})


class SessionListeningSourceTest(unittest.TestCase):
    def setUp(self):
        enum_patch = patch.object(
            source_module, "ClipLaunchQuantization", CanonicalClipLaunchQuantization, create=True,
        )
        enum_patch.start()
        self.addCleanup(enum_patch.stop)
        self.clip = types.SimpleNamespace(
            name="Source", is_audio_clip=False, is_midi_clip=True,
            is_playing=False, is_triggered=False, is_recording=False,
            start_time=-4.0, playing_position=0.0, start_marker=0.0,
            end_marker=8.0, loop_start=0.0, loop_end=8.0, looping=True,
            launch_mode=0, launch_quantization=0, legato=False,
        )
        self.track = types.SimpleNamespace(
            name="Track", clip_slots=[types.SimpleNamespace(has_clip=True, clip=self.clip)],
            playing_slot_index=-1, fired_slot_index=-1,
        )
        self.song = types.SimpleNamespace(
            tracks=[self.track], is_playing=False, current_song_time=12.0,
            tempo=120.0, clip_trigger_quantization=4,
            signature_numerator=4, signature_denominator=4,
            record_mode=False, session_record=False, overdub=False,
            session_automation_record=False,
        )
        self.context = types.SimpleNamespace(song=self.song, project_revision=5)
        self.target = {
            "view": "session",
            "track": {
                "kind": "regular", "index": 0,
                "expectedReference": _track_reference(self.context, self.track, bounded=True),
                "expectedName": "Track",
            },
            "sceneIndex": 0,
            "expectedClipReference": _clip_reference(self.context, self.clip, bounded=True),
            "expectedClipName": "Source",
        }
        self.params = {
            "schemaVersion": 1,
            "queryId": "10000000-0000-4000-8000-000000000001",
            "target": self.target,
        }

    def inspect(self):
        return inspect_session_listening_source(self.context, self.params)

    def test_signed_origin_and_readonly_uncertified_metadata(self):
        result = self.inspect()
        self.assertEqual(result["queryId"], self.params["queryId"])
        self.assertEqual(result["target"], self.target)
        self.assertEqual(result["evidence"], "message-rate-only")
        self.assertEqual(result["nativeAlignment"], "unverified")
        self.assertEqual(result["sourceKind"], "midi")
        self.assertEqual(result["positionUnit"], "beats")
        self.assertEqual(result["before"]["startTimeBeats"], -4)
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(result["settings"]["launchQuantization"], 0)
        self.assertEqual(result["settings"]["globalQuantization"], 4)
        self.assertIsNone(result["settings"]["followActionEnabled"])
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.song.current_song_time, 12)
        self.assertFalse(hasattr(self.clip, "fire"))

    def test_audio_units_and_unknown_type_are_not_inferred_from_transport(self):
        self.clip.is_audio_clip, self.clip.is_midi_clip = True, False
        for warping, kind, unit in (
            (True, "warped-audio", "beats"),
            (False, "unwarped-audio", "seconds"),
            (None, "unknown", None),
        ):
            self.clip.warping = warping
            result = self.inspect()
            self.assertEqual((result["sourceKind"], result["positionUnit"]), (kind, unit))
        self.clip.is_audio_clip = True
        self.clip.is_midi_clip = True
        self.assertEqual(self.inspect()["sourceKind"], "unknown")

    def test_start_time_is_not_attributed_to_target_when_another_slot_is_selected(self):
        other = types.SimpleNamespace(name="Other")
        self.track.clip_slots.append(types.SimpleNamespace(has_clip=True, clip=other))
        self.track.playing_slot_index = 1
        self.clip.start_time = 32.0
        state = self.inspect()["before"]
        self.assertNotEqual(state["selectedClipReference"], self.target["expectedClipReference"])
        self.assertEqual(state["startTimeBeats"], 32)
        self.assertFalse(state["targetPlaying"])

    def test_records_queued_state_separately_and_does_not_claim_atomic_reads(self):
        self.track.fired_slot_index = 0
        self.clip.is_triggered = True
        before = self.inspect()["before"]
        self.assertTrue(before["targetTriggered"])
        self.assertFalse(before["targetPlaying"])
        self.assertEqual(before["firedSlotIndex"], 0)
        self.assertEqual(before["playingSlotIndex"], -1)

    def test_unknown_nonfinite_and_invalid_values_remain_unknown(self):
        self.clip.playing_position = float("nan")
        self.clip.start_time = float("inf")
        self.clip.is_playing = 1
        self.clip.launch_mode = True
        self.song.clip_trigger_quantization = 999
        self.track.playing_slot_index = 999
        result = self.inspect()
        for field in ("playingPosition", "startTimeBeats", "targetPlaying", "playingSlotIndex"):
            self.assertIsNone(result["before"][field])
        self.assertIsNone(result["before"]["selectedClipReference"])
        self.assertIsNone(result["settings"]["launchMode"])
        self.assertIsNone(result["settings"]["globalQuantization"])

    def test_replacement_and_movement_fail_exact_identity(self):
        self.track.clip_slots[0].clip = types.SimpleNamespace(name="Source")
        with self.assertRaises(ProtocolFailure) as error:
            self.inspect()
        self.assertEqual(error.exception.code, "stale_reference")
        self.track.clip_slots[0].has_clip = False
        with self.assertRaises(ProtocolFailure) as error:
            self.inspect()
        self.assertEqual(error.exception.code, "not_found")

    def test_target_is_revalidated_after_reading_properties(self):
        target = self.clip
        track = self.track

        class ReplacingClip:
            def __getattr__(self, field):
                if field == "playing_position":
                    track.clip_slots[0].clip = types.SimpleNamespace(name="Replacement")
                return getattr(target, field)

        self.track.clip_slots[0].clip = ReplacingClip()
        self.target["expectedClipReference"] = _clip_reference(
            self.context, self.track.clip_slots[0].clip, bounded=True,
        )
        with self.assertRaises(ProtocolFailure) as error:
            self.inspect()
        self.assertEqual(error.exception.code, "stale_reference")

    def test_strict_validation_and_readonly_registration(self):
        registry = CommandRegistry()
        register_session_listening_source(registry)
        self.assertIn("listening.inspect_session_source", registry.metadata())
        for change in (
            {"schemaVersion": True}, {"queryId": "stale"},
            {"target": {**self.target, "view": "arrangement"}},
            {"target": {**self.target, "sceneIndex": 256}},
            {"fire": True},
        ):
            with self.subTest(change=change), self.assertRaises(ProtocolFailure) as error:
                inspect_session_listening_source(self.context, {**self.params, **change})
            self.assertEqual(error.exception.code, "invalid_params")

    def test_clip_launch_quantization_normalizes_public_enum_names_not_raw_ordinals(self):
        shifted = native_launch_enum(q_global=5, q_bar=0)
        with patch.object(source_module, "ClipLaunchQuantization", shifted):
            for native, normalized in ((5, 0), (0, 5), (1, 1), (14, 14)):
                with self.subTest(native=native):
                    self.clip.launch_quantization = native
                    self.assertEqual(self.inspect()["settings"]["launchQuantization"], normalized)
        self.clip.launch_quantization = 0
        self.assertEqual(self.inspect()["settings"]["launchQuantization"], 0)
        self.clip.launch_quantization = 5
        self.assertEqual(self.inspect()["settings"]["launchQuantization"], 5)

    def test_missing_ambiguous_and_unknown_public_launch_enum_stay_unknown(self):
        for enum in (
            None,
            native_launch_enum(q_global=None),
            native_launch_enum(q_global=5),
            native_launch_enum(q_none="none"),
        ):
            with self.subTest(enum=enum), patch.object(source_module, "ClipLaunchQuantization", enum):
                self.clip.launch_quantization = 5
                self.assertIsNone(self.inspect()["settings"]["launchQuantization"])
        for value in (None, True, 5.0, "5", -1, 15, object()):
            with self.subTest(value=value):
                self.clip.launch_quantization = value
                self.assertIsNone(self.inspect()["settings"]["launchQuantization"])

    def test_all_named_public_members_normalize_under_nonordinal_native_encoding(self):
        expected = {name: value for name, value in vars(CanonicalClipLaunchQuantization).items()
                    if name.startswith("q_")}
        shifted = native_launch_enum(**{name: value + 100 for name, value in expected.items()})
        with patch.object(source_module, "ClipLaunchQuantization", shifted):
            for name, canonical in expected.items():
                with self.subTest(member=name):
                    self.clip.launch_quantization = getattr(shifted, name)
                    self.assertEqual(self.inspect()["settings"]["launchQuantization"], canonical)

    def test_public_enum_objects_are_supported_but_untyped_integer_coercion_is_not(self):
        class NativeEnum:
            def __init__(self, number):
                self.number = number

            def __int__(self):
                return self.number

        for name, value in vars(CanonicalClipLaunchQuantization).items():
            if name.startswith("q_"):
                setattr(NativeEnum, name, NativeEnum(value + 100))
        with patch.object(source_module, "ClipLaunchQuantization", NativeEnum):
            self.clip.launch_quantization = NativeEnum.q_global
            self.assertEqual(self.inspect()["settings"]["launchQuantization"], 0)
            self.clip.launch_quantization = NativeEnum.q_bar
            self.assertEqual(self.inspect()["settings"]["launchQuantization"], 5)
            self.clip.launch_quantization = types.SimpleNamespace(__int__=lambda: 100)
            self.assertIsNone(self.inspect()["settings"]["launchQuantization"])
