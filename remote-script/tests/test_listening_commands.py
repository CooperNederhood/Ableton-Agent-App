import types
import unittest
import json
from pathlib import Path

from AbletonAgent.core_domain_commands import _track_reference
from AbletonAgent.device_commands import _device_reference
from AbletonAgent.errors import ProtocolFailure
from AbletonAgent.listening_commands import (
    inspect_listening_context, register_listening_commands, validate_listening_context,
)
from AbletonAgent.registry import CommandRegistry


def audio_clip(name, start=0, end=8):
    return types.SimpleNamespace(
        name=name, start_time=start, end_time=end, is_audio_clip=True,
        is_playing=True, is_recording=False, file_path="/Music/source.wav",
        gain=0.7, pitch_coarse=0, pitch_fine=0, warping=True, warp_mode=0,
        start_marker=0, end_marker=8, loop_start=0, loop_end=8,
        looping=True, muted=False, length=8, sample_length=441000,
        sample_rate=44100,
    )


class ListeningCommandsTest(unittest.TestCase):
    def setUp(self):
        self.listener = types.SimpleNamespace(
            name="Listener", class_name="MxDeviceAudioEffect", is_active=True,
            parameters=[types.SimpleNamespace(name="Device On", value=1.0)],
        )
        self.track = types.SimpleNamespace(
            name="Audio", devices=[self.listener], clip_slots=[],
            arrangement_clips=[audio_clip("Arrangement")],
            playing_slot_index=-2, back_to_arranger=False,
            mute=False, solo=False, arm=False, current_monitoring_state=2,
            mixer_device=types.SimpleNamespace(
                volume=types.SimpleNamespace(value=0.8),
                panning=types.SimpleNamespace(value=0), crossfader_assign=1,
            ),
        )
        self.song = types.SimpleNamespace(
            tracks=[self.track], return_tracks=[],
            master_track=types.SimpleNamespace(name="Master", devices=[]),
            is_playing=False, current_song_time=4.0, tempo=120.0,
            record_mode=False, session_record=False, overdub=False,
            session_automation_record=False,
        )
        self.context = types.SimpleNamespace(song=self.song, project_revision=7)
        self.target = {
            "track": {
                "kind": "regular", "index": 0,
                "expectedReference": _track_reference(self.context, self.track),
                "expectedName": "Audio",
            },
            "deviceIndex": 0,
            "expectedDeviceReference": _device_reference(self.context, self.listener),
            "expectedDeviceName": "Listener", "expectedClassName": "MxDeviceAudioEffect",
        }
        self.params = {
            "schemaVersion": 1, "listeners": [self.target],
            "range": {"startBeat": 0, "endBeat": 16},
        }

    def inspect(self):
        return inspect_listening_context(self.context, self.params)

    def test_exact_bindings_transport_and_content_evidence(self):
        result = self.inspect()
        self.assertEqual(result["projectRevision"], 7)
        self.assertTrue(result["transport"]["safeToStart"])
        listener = result["listeners"][0]
        self.assertEqual(listener["canonicalPath"], "live_set tracks 0 devices 0")
        clip = listener["clips"][0]
        self.assertEqual(clip["interval"], {"startBeat": 0, "endBeat": 8})
        self.assertEqual(clip["activity"], "inactive")
        self.assertEqual(clip["fingerprint"]["completeness"], "unknown")
        self.assertIn("source-content-not-hashed", clip["fingerprint"]["unknownReasons"])
        again = self.inspect()["listeners"][0]
        self.assertEqual(listener["fingerprint"], again["fingerprint"])
        self.track.arrangement_clips[0].gain = 0.2
        self.assertNotEqual(clip["fingerprint"]["digest"], self.inspect()["listeners"][0]["clips"][0]["fingerprint"]["digest"])

    def test_actual_interval_and_session_override_not_transport_inference(self):
        self.song.is_playing = True
        self.assertEqual(self.inspect()["listeners"][0]["clips"][0]["activity"], "active")
        self.song.current_song_time = 12
        self.assertEqual(self.inspect()["listeners"][0]["clips"][0]["activity"], "inactive")
        self.song.current_song_time = 4
        del self.track.arrangement_clips[0].is_playing
        self.assertEqual(self.inspect()["listeners"][0]["clips"][0]["activity"], "unknown")
        session = audio_clip("Session")
        self.track.clip_slots = [types.SimpleNamespace(has_clip=True, clip=session)]
        self.track.playing_slot_index = 0
        result = self.inspect()["listeners"][0]
        self.assertTrue(result["sessionOverride"])
        self.assertEqual([clip["activity"] for clip in result["clips"]], ["active", "inactive"])
        self.track.playing_slot_index = -1
        self.track.back_to_arranger = True
        self.assertEqual(self.inspect()["listeners"][0]["clips"][-1]["activity"], "inactive")

    def test_recording_or_unknown_flags_and_clip_state_fail_closed(self):
        for field in ("record_mode", "session_record", "overdub", "session_automation_record"):
            setattr(self.song, field, True)
            self.assertFalse(self.inspect()["transport"]["safeToStart"], field)
            setattr(self.song, field, None)
            self.assertFalse(self.inspect()["transport"]["safeToStart"], field)
            setattr(self.song, field, False)
        self.track.arrangement_clips[0].is_recording = True
        self.assertFalse(self.inspect()["transport"]["safeToStart"])
        self.track.arrangement_clips[0].is_recording = None
        self.assertFalse(self.inspect()["transport"]["safeToStart"])
        self.track.arrangement_clips[0].is_recording = False
        self.assertTrue(self.inspect()["transport"]["safeToStart"])
        self.track.clip_slots = [types.SimpleNamespace(
            has_clip=False, is_triggered=True, clip=None,
        )]
        self.assertFalse(self.inspect()["transport"]["safeToStart"])

    def test_validation_bounds_versions_and_no_arbitrary_paths(self):
        for change in (
            {"schemaVersion": 2}, {"schemaVersion": True},
            {"maxClips": 65}, {"maxParameters": 33},
            {"range": {"startBeat": 4, "endBeat": 4}},
            {"range": {"startBeat": 0, "endBeat": float("nan")}},
            {"listeners": []}, {"listeners": [self.target] * 9},
            {"listeners": [self.target, self.target]},
            {"path": "live_set tracks 0"},
        ):
            params = dict(self.params, **change)
            self.assertIsNotNone(validate_listening_context(params), change)
            with self.assertRaises(ProtocolFailure):
                inspect_listening_context(self.context, params)

    def test_stale_identity_rejected_and_inspection_has_no_mutations(self):
        self.listener.name = "Other"
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "stale_reference")
        self.listener.name = "Listener"
        self.listener.class_name = "InstrumentDevice"
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "stale_reference")
        registry = CommandRegistry()
        register_listening_commands(registry)
        self.assertFalse(registry.metadata()["listening.inspect_context"]["mutates"])

    def test_bounded_clips_parameters_and_downstream_independence(self):
        self.params["maxClips"] = 1
        self.params["maxParameters"] = 1
        self.track.arrangement_clips.append(audio_clip("Second", 8, 16))
        self.listener.parameters.append(types.SimpleNamespace(name="Amount", value=0.5))
        listener = self.inspect()["listeners"][0]
        self.assertEqual(len(listener["clips"]), 1)
        self.assertEqual(len(listener["upstreamDevices"][0]["parameters"]), 1)
        self.assertTrue(listener["clipsTruncated"])
        self.assertTrue(listener["dependenciesTruncated"])
        self.assertFalse(self.inspect()["transport"]["safeToStart"])
        downstream = types.SimpleNamespace(
            name="Downstream", class_name="PluginDevice", is_active=True, parameters=[],
        )
        self.track.devices.append(downstream)
        self.assertEqual(listener["fingerprint"], self.inspect()["listeners"][0]["fingerprint"])

    def test_return_master_are_mixed_and_do_not_invent_clip_sources(self):
        self.track.devices = []
        for kind in ("return", "master"):
            track = types.SimpleNamespace(name="Mix", devices=[self.listener])
            if kind == "return":
                self.song.return_tracks = [track]
            else:
                self.song.return_tracks[0].devices = []
                self.song.master_track = track
            target = dict(self.target)
            target["track"] = {
                "kind": kind, "expectedReference": _track_reference(self.context, track),
                "expectedName": "Mix",
            }
            if kind == "return":
                target["track"]["index"] = 0
            self.params["listeners"] = [target]
            result = self.inspect()["listeners"][0]
            self.assertEqual(result["clips"], [])
            self.assertIn("mixed-return-or-master", result["unknownReasons"])
            reference = _device_reference(self.context, self.listener)
            self.assertEqual(reference, _device_reference(self.context, self.listener))

    def test_missing_and_nonfinite_fields_remain_unknown(self):
        self.track.arrangement_clips[0].gain = float("nan")
        del self.track.playing_slot_index
        del self.track.back_to_arranger
        self.song.current_song_time = None
        self.song.is_playing = True
        result = self.inspect()
        listener = result["listeners"][0]
        self.assertIsNone(listener["sessionOverride"])
        self.assertEqual(listener["clips"][0]["activity"], "unknown")
        settings = {item["field"]: item["value"] for item in listener["clips"][0]["settings"]}
        self.assertIsNone(settings["gain"])

    def test_generated_typescript_request_is_accepted_by_python_validator(self):
        fixture_path = Path(__file__).resolve().parents[2] / "packages/protocol/contracts/command-fixtures.json"
        fixtures = json.loads(fixture_path.read_text())
        fixture = fixtures["commands"]["listening.inspect_context"]
        self.assertIsNone(validate_listening_context(fixture["request"]["params"]))
        self.assertIsNone(validate_listening_context(fixture["canonicalPathRequest"]["params"]))
        result = inspect_listening_context(self.context, fixture["canonicalPathRequest"]["params"])
        self.assertEqual(result["listeners"][0]["pathAttestation"]["source"], "remote-script-lom")

    def test_scan_never_materializes_or_reads_beyond_the_budget(self):
        class GuardedCollection(object):
            def __len__(self):
                return 10000

            def __getitem__(self, index):
                if index >= 256:
                    raise AssertionError("Read beyond bounded clip scan")
                return types.SimpleNamespace(has_clip=False)

        self.track.clip_slots = GuardedCollection()
        result = self.inspect()["listeners"][0]
        self.assertTrue(result["clipsTruncated"])
        self.assertFalse(self.inspect()["transport"]["safeToStart"])

    def test_moved_listener_new_connection_and_non_audio_effect_are_rejected(self):
        self.track.devices.insert(0, types.SimpleNamespace(
            name="Other", class_name="AudioEffectDevice", parameters=[],
        ))
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "stale_reference")
        self.track.devices.pop(0)
        replacement_context = types.SimpleNamespace(song=self.song, project_revision=8)
        with self.assertRaises(ProtocolFailure) as raised:
            inspect_listening_context(replacement_context, self.params)
        self.assertEqual(raised.exception.code, "stale_reference")
        self.listener.class_name = "InstrumentDevice"
        self.target["expectedClassName"] = "InstrumentDevice"
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "conflict")

    def test_missing_arrangement_intervals_and_unknown_recording_are_not_safe(self):
        del self.track.arrangement_clips[0].end_time
        result = self.inspect()
        self.assertFalse(result["transport"]["safeToStart"])
        self.assertIn("arrangement-interval-unavailable", result["listeners"][0]["unknownReasons"])

    def test_upstream_parameter_and_mixer_changes_affect_available_evidence_digest(self):
        before = self.inspect()["listeners"][0]["fingerprint"]["digest"]
        self.listener.parameters[0].value = 0
        changed = self.inspect()["listeners"][0]["fingerprint"]["digest"]
        self.assertNotEqual(before, changed)
        self.track.mixer_device.volume.value = 0.5
        self.assertNotEqual(changed, self.inspect()["listeners"][0]["fingerprint"]["digest"])

    def test_path_selector_independently_attests_uuids_and_echoes_query(self):
        query_id = "10000000-0000-4000-8000-000000000001"
        self.params["listeners"] = [{"canonicalPath": "live_set tracks 0 devices 0"}]
        self.params["bindingQueryId"] = query_id
        before = dict(vars(self.song))
        result = self.inspect()
        self.assertEqual(result["bindingQueryId"], query_id)
        listener = result["listeners"][0]
        self.assertEqual(listener["binding"], self.target)
        self.assertEqual(listener["pathAttestation"], {
            "schemaVersion": 1, "source": "remote-script-lom",
            "canonicalDevicePath": "live_set tracks 0 devices 0",
            "canonicalTrackPath": "live_set tracks 0",
            "deviceReference": self.target["expectedDeviceReference"],
            "trackReference": self.target["track"]["expectedReference"],
            "placement": {"kind": "track-device", "deviceIndex": 0},
        })
        self.assertEqual(before, vars(self.song))

    def test_paths_for_return_and_master_are_derived_from_their_own_collections(self):
        self.track.devices = []
        for kind, path in (("return", "live_set return_tracks 0"), ("master", "live_set master_track")):
            track = types.SimpleNamespace(name="Same Name", devices=[self.listener])
            self.song.return_tracks = [track] if kind == "return" else []
            if kind == "master":
                self.song.master_track = track
            self.params["listeners"] = [{"canonicalPath": path + " devices 0"}]
            result = self.inspect()["listeners"][0]
            self.assertEqual(result["pathAttestation"]["canonicalTrackPath"], path)
            self.assertEqual(result["binding"]["track"]["kind"], kind)

    def test_arbitrary_paths_bounds_nested_and_non_audio_devices_fail_closed(self):
        for path, code in (
            ("live_set this_device", "invalid_params"),
            ("live_set tracks 0 devices 0 parameters 1", "invalid_params"),
            ("live_set tracks 00 devices 0", "invalid_params"),
            ("live_set tracks 0 devices 0 chains 0 devices 0", "unsupported_capability"),
            ("live_set tracks 256 devices 0", "unsupported_capability"),
            ("live_set tracks 0 devices 32", "unsupported_capability"),
            ("live_set tracks 1 devices 0", "not_found"),
        ):
            self.params["listeners"] = [{"canonicalPath": path}]
            with self.assertRaises(ProtocolFailure) as raised:
                self.inspect()
            self.assertEqual(raised.exception.code, code, path)
        self.listener.class_name = "MxDeviceInstrument"
        self.params["listeners"] = [{"canonicalPath": "live_set tracks 0 devices 0"}]
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "conflict")

    def test_unknown_parent_and_ambiguous_duplicate_paths_are_not_attested(self):
        self.params["listeners"] = [{"canonicalPath": "live_set tracks 0 devices 0"}]
        self.listener.canonical_parent = types.SimpleNamespace(name="Unknown chain")
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "unsupported_capability")
        del self.listener.canonical_parent
        self.track.devices.append(self.listener)
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "ambiguous_reference")
        self.track.devices.pop()
        self.song.return_tracks = [types.SimpleNamespace(name="Other", devices=[self.listener])]
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "ambiguous_reference")

    def test_paths_and_uuid_selectors_cannot_alias_one_listener(self):
        self.params["listeners"] = [self.target, {"canonicalPath": "live_set tracks 0 devices 0"}]
        with self.assertRaises(ProtocolFailure) as raised:
            self.inspect()
        self.assertEqual(raised.exception.code, "ambiguous_reference")


if __name__ == "__main__":
    unittest.main()
