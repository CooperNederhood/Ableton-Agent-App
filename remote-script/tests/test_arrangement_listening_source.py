import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from AbletonAgent.arrangement_listening_source import inspect_arrangement_listening_source
from AbletonAgent.core_domain_commands import _track_reference
from AbletonAgent.errors import ProtocolFailure


class ArrangementListeningSourceTest(unittest.TestCase):
    def setUp(self):
        self.clip = types.SimpleNamespace(
            name="Source", is_audio_clip=True, start_time=0., end_time=16.,
            file_path="/owned/source.aif", sample_rate=48000., sample_length=360000.,
            is_recording=False, warping=True, looping=True, start_marker=0.,
            end_marker=16., loop_start=0., loop_end=16., gain=1., pitch_coarse=0, pitch_fine=0)
        self.track = types.SimpleNamespace(name="Track", arrangement_clips=[self.clip],
            clip_slots=[], arm=True, current_monitoring_state=2, back_to_arranger=False,
            playing_slot_index=-1, fired_slot_index=-1)
        self.song = types.SimpleNamespace(tracks=[self.track], is_playing=False,
            current_song_time=72., tempo=128., loop=False, record_mode=False,
            session_record=False, overdub=False, session_automation_record=False,
            back_to_arranger=False, file_path="/owned/prepared.als")
        self.context = types.SimpleNamespace(song=self.song, project_revision=3)
        self.params = dict(schemaVersion=1, queryId="10000000-0000-4000-8000-000000000001",
            track=dict(kind="regular", index=0, expectedName="Track",
                expectedReference=_track_reference(self.context, self.track, bounded=True)),
            range=dict(startBeat=0., endBeat=16.))

    def inspect(self):
        return inspect_arrangement_listening_source(self.context, self.params)

    def midi_source(self):
        self.clip.is_audio_clip, self.clip.is_midi_clip = False, True
        self.clip.length = 16.
        self.notes = [
            types.SimpleNamespace(pitch=64, start_time=6., duration=.25, velocity=100, mute=False),
            types.SimpleNamespace(pitch=60, start_time=1., duration=.5, velocity=90, mute=True),
        ]
        self.clip.get_all_notes_extended = Mock(side_effect=lambda: tuple(self.notes))
        parameter = types.SimpleNamespace(
            name="Device On", value=1., min=0., max=1.,
            is_quantized=True, is_enabled=True, value_items=("Off", "On"),
        )
        self.instrument = types.SimpleNamespace(
            name="Instrument", class_name="Operator", class_display_name="Operator",
            is_active=True, can_have_chains=False, can_have_drum_pads=False,
            parameters=[parameter],
        )
        self.track.devices = [self.instrument]

    def test_complete_midi_notes_chain_and_exact_subrange_are_readonly(self):
        self.midi_source()
        self.song.current_song_time = 16.
        self.params["range"] = dict(startBeat=4., endBeat=8.)
        result = self.inspect()
        midi = result["clips"][0]["midi"]
        self.assertEqual(result["range"], dict(startBeat=4., endBeat=8.))
        self.assertEqual((result["clips"][0]["startBeat"], result["clips"][0]["endBeat"]), (0., 16.))
        self.assertEqual([note["startTime"] for note in midi["notes"]], [1., 6.])
        self.assertEqual(midi["clip"]["reference"], result["clips"][0]["clipId"])
        self.assertEqual(midi["totalNotes"], 2)
        self.assertFalse(midi["truncated"])
        self.assertTrue(all(result["clips"][0][key] is None for key in (
            "filePath", "sampleRate", "sampleLength", "warped", "gain", "pitchCoarse", "pitchFine",
        )))
        self.assertEqual(result["instrumentChain"]["before"], result["instrumentChain"]["after"])
        self.assertEqual(result["instrumentChain"]["devices"][0]["device"]["className"], "Operator")
        self.assertEqual(result["instrumentChain"]["devices"][0]["parameters"][0]["value"], 1.)
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(result["before"]["currentBeat"], 16.)
        self.assertEqual(self.song.current_song_time, 16.)
        self.assertFalse(self.song.is_playing)
        self.assertFalse(hasattr(self.clip, "fire"))

    def test_midi_note_and_instrument_bounds_fail_without_partial_evidence(self):
        self.midi_source()
        self.notes *= 1025
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.notes = self.notes[:1]
        self.track.devices = [self.instrument] * 9
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.track.devices = [self.instrument]
        self.instrument.parameters *= 257
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.assertFalse(self.song.is_playing)

    def test_midi_source_read_does_not_repeat_the_deep_session_rack_audit(self):
        self.midi_source()
        rack = types.SimpleNamespace(**vars(self.instrument))
        rack.name, rack.class_name = "Rack", "InstrumentGroupDevice"
        rack.can_have_chains = True
        rack.chains = [types.SimpleNamespace(name="Voice", devices=[self.instrument])]
        rack.return_chains = []
        self.track.devices = [rack]
        with patch("AbletonAgent.device_commands._instrument_tree",
                   side_effect=AssertionError("Deep rack audit repeated")):
            result = self.inspect()
        self.assertNotIn("instrumentTree", result["instrumentChain"]["before"])
        self.assertEqual(result["instrumentChain"]["before"], result["instrumentChain"]["after"])
        self.assertEqual(result["instrumentChain"]["devices"][0]["device"]["className"],
                         "InstrumentGroupDevice")

    def test_midi_note_bound_applies_to_the_whole_overlapping_query(self):
        self.midi_source()
        self.notes = [self.notes[0]] * 1025
        second = types.SimpleNamespace(**vars(self.clip))
        second.start_time, second.end_time = 16., 32.
        self.track.arrangement_clips.append(second)
        self.params["range"]["endBeat"] = 32.
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.assertFalse(self.song.is_playing)

    def test_changed_instrument_inventory_is_not_complete_material_evidence(self):
        self.midi_source()
        self.track.devices = []
        before = dict(devices=[], total=0, offset=0, limit=8)
        after = dict(before, total=1)
        with patch("AbletonAgent.arrangement_listening_source.inspect_devices",
                   side_effect=[before, after]):
            with self.assertRaises(ProtocolFailure):
                self.inspect()
        self.assertFalse(self.song.is_playing)

    def test_nonoverlapping_midi_is_not_read_and_boundary_overlap_is_exclusive(self):
        self.midi_source()
        self.params["range"] = dict(startBeat=16., endBeat=20.)
        result = self.inspect()
        self.assertEqual(result["clips"], [])
        self.assertNotIn("instrumentChain", result)
        self.clip.get_all_notes_extended.assert_not_called()

    def test_replaced_midi_during_note_read_is_not_reported_as_the_loaded_source(self):
        self.midi_source()
        def replaced():
            self.track.arrangement_clips = []
            return self.notes
        self.clip.get_all_notes_extended.side_effect = replaced
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.assertFalse(self.song.is_playing)

    def test_exact_loaded_source_and_global_reads_are_readonly(self):
        result = self.inspect()
        self.assertEqual(result["evidence"], "message-rate-only")
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(result["before"]["currentBeat"], 72.)
        self.assertEqual(result["before"]["targetMonitoring"], 2)
        self.assertEqual(result["clips"][0]["sampleRate"], 48000.)
        self.assertEqual(result["projectPath"], "/owned/prepared.als")
        self.assertTrue(self.track.arm)
        self.assertFalse(self.song.is_playing)
        self.assertFalse(hasattr(self.clip, "fire"))

    def test_unavailable_record_and_monitor_reads_are_not_false(self):
        del self.song.session_record
        self.track.current_monitoring_state = object()
        result = self.inspect()
        self.assertIsNone(result["before"]["sessionRecord"])
        self.assertIsNone(result["before"]["targetMonitoring"])

    def test_session_override_is_not_arrangement(self):
        self.track.back_to_arranger = True
        self.assertFalse(self.inspect()["before"]["arrangementEligible"])

    def test_clip_inventory_and_target_are_bounded(self):
        self.track.arrangement_clips = [self.clip] * 257
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.track.arrangement_clips = [self.clip]
        self.track.name = "Changed"
        with self.assertRaises(ProtocolFailure):
            self.inspect()

    def test_invalid_range_and_unknown_source_do_not_mutate(self):
        self.params["range"]["endBeat"] = 0.
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.params["range"]["endBeat"] = 16.
        self.clip.is_audio_clip = False
        with self.assertRaises(ProtocolFailure):
            self.inspect()
        self.assertEqual(self.song.current_song_time, 72.)


if __name__ == "__main__":
    unittest.main()
