import sys
import types
import unittest
from pathlib import Path

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
