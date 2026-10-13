import copy
import json
import types
import unittest
from pathlib import Path

from AbletonAgent.errors import ProtocolFailure
from AbletonAgent.listening_playback import (
    register_playback_commands, start_listening_playback, stop_listening_playback,
    validate_start, validate_stop,
    guarded_arrangement_start_supported,
)
from AbletonAgent.registry import CommandRegistry
from simulator import handle
import test_listening_commands as fixtures
from AbletonAgent.identity import build_live_identity
from AbletonAgent.capabilities import build_capability_document

REFERENCE = "10000000-0000-4000-8000-000000000001"
TARGET = {
    "track": {
        "kind": "regular", "index": 0, "expectedReference": REFERENCE,
        "expectedName": "Audio",
    },
    "deviceIndex": 0, "expectedDeviceReference": REFERENCE,
    "expectedDeviceName": "Listener", "expectedClassName": "MxDeviceAudioEffect",
}
START = {
    "schemaVersion": 1, "mode": "arrangement",
    "ownerId": "app-session", "passId": REFERENCE,
    "expectedLiveSetId": "set", "expectedProjectRevision": 0,
    "listeners": [TARGET], "range": {"startBeat": 0, "endBeat": 8},
}
STOP = {
    "schemaVersion": 1,
    "ownership": {
        "ownerId": "app-session", "passId": REFERENCE,
        "generation": REFERENCE, "liveSetId": "set",
    },
}


class ForbiddenLom(object):
    def __getattribute__(self, _name):
        raise AssertionError("Unsupported playback must not consult/mutate LOM")

    def __setattr__(self, _name, _value):
        raise AssertionError("Unsupported playback must not mutate LOM")


class ListeningPlaybackTest(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.ListeningCommandsTest()
        fixture.setUp()
        self.context = fixture.context
        self.song = fixture.song
        self.song.loop = False
        self.song.back_to_arranger = False
        self.song.arrangement_overdub = False
        fixture.track.playing_slot_index = -1
        fixture.track.fired_slot_index = -1
        self.calls = []
        def continue_playing():
            self.calls.append(("continue", self.song.current_song_time))
            self.song.is_playing = True
        self.song.continue_playing = continue_playing
        self.params = dict(START, expectedProjectRevision=7, listeners=[fixture.target],
                           expectedLiveSetId=build_live_identity(self.song)["liveSetId"])

    def test_success_leaves_running_without_ownership_or_cleanup_mutations(self):
        result = start_listening_playback(self.context, self.params)
        self.assertEqual(result, {
            "schemaVersion": 1, "mode": "arrangement", "cleanupPolicy": "leave-running",
            "startedAtBeat": 0, "sourceOnset": "unverified",
        })
        self.assertEqual(self.calls, [("continue", 0)])
        self.assertTrue(self.song.is_playing)
        self.assertFalse(self.song.loop)
        self.assertFalse(self.song.back_to_arranger)
        with self.assertRaises(ProtocolFailure):
            stop_listening_playback(self.context, STOP)
        self.assertTrue(self.song.is_playing)

    def test_stop_never_mints_ownership_or_touches_live_for_valid_requests(self):
        context = types.SimpleNamespace(song=ForbiddenLom())
        with self.assertRaises(ProtocolFailure) as raised:
            stop_listening_playback(context, copy.deepcopy(STOP))
        self.assertEqual(raised.exception.code, "unsupported_capability")
        self.assertFalse(raised.exception.details["mutated"])

    def test_session_launch_is_explicitly_unsupported_without_fire(self):
        params = copy.deepcopy(START)
        params["mode"] = "session"
        params["clip"] = {
            "view": "session", "track": TARGET["track"], "sceneIndex": 0,
            "expectedClipReference": REFERENCE, "expectedClipName": "Audio",
        }
        with self.assertRaises(ProtocolFailure) as raised:
            start_listening_playback(types.SimpleNamespace(song=ForbiddenLom()), params)
        self.assertEqual(raised.exception.details["reason"], "session_source_onset_unverified")
        self.assertFalse(raised.exception.details["mutated"])

    def test_unissued_tokens_and_external_transport_changes_never_stop_user_playback(self):
        for change in (
            {"is_playing": True}, {"current_song_time": 32},
            {"record_mode": True}, {"session_record": True},
            {"loop": True}, {"back_to_arranger": True},
            {"playing_slot_index": 0}, {"fired_slot_index": 1},
        ):
            state = types.SimpleNamespace(is_playing=True, current_song_time=0, loop=False)
            for field, value in change.items():
                setattr(state, field, value)
            before = dict(vars(state))
            request = {"kind": "request", "command": "listening.stop_playback", "requestId": REFERENCE, "params": STOP}
            result = handle(request, "token", state)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "unsupported_capability")
            self.assertEqual(before, vars(state))

    def test_recording_unknown_set_or_listener_states_cannot_bypass_the_gate(self):
        for field in ("is_playing", "record_mode", "session_record", "arrangement_overdub",
                      "session_automation_record", "overdub", "loop", "back_to_arranger"):
            for value in (True, None):
                before = getattr(self.song, field)
                setattr(self.song, field, value)
                with self.assertRaises(ProtocolFailure):
                    start_listening_playback(self.context, self.params)
                self.assertEqual(self.song.current_song_time, 4)
                self.assertEqual(self.calls, [])
                setattr(self.song, field, before)

    def test_changed_set_revision_target_and_session_override_are_denied_before_seek(self):
        for change in (
            {"expectedLiveSetId": "changed"}, {"expectedProjectRevision": 8},
            {"listeners": [dict(self.params["listeners"][0], expectedDeviceReference=REFERENCE)]},
        ):
            with self.assertRaises(ProtocolFailure):
                start_listening_playback(self.context, dict(self.params, **change))
            self.assertEqual(self.song.current_song_time, 4)
        for field, value in (("playing_slot_index", 0), ("playing_slot_index", -2),
                             ("fired_slot_index", 0), ("fired_slot_index", None),
                             ("back_to_arranger", True)):
            track = self.song.tracks[0]
            before = getattr(track, field)
            setattr(track, field, value)
            with self.assertRaises(ProtocolFailure):
                start_listening_playback(self.context, self.params)
            self.assertEqual(self.song.current_song_time, 4)
            setattr(track, field, before)

    def test_partial_start_failure_reports_indeterminate_and_never_rolls_back_or_stops(self):
        def broken_start():
            self.calls.append(("continue", self.song.current_song_time))
            self.song.is_playing = True
            raise RuntimeError("host applied start then failed")
        self.song.continue_playing = broken_start
        with self.assertRaises(ProtocolFailure) as raised:
            start_listening_playback(self.context, self.params)
        self.assertEqual(raised.exception.details["stage"], "start")
        self.assertEqual(raised.exception.details["mutationState"], "indeterminate")
        self.assertTrue(raised.exception.details["playing"])
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.current_song_time, 0)

    def test_seek_failure_or_reentrant_recording_change_cannot_start_or_trigger_rollback(self):
        original = vars(self.song).copy()
        class ReentrantSong(types.SimpleNamespace):
            def __setattr__(song, field, value):
                super(ReentrantSong, song).__setattr__(field, value)
                if field == "current_song_time":
                    song.record_mode = True
        self.context.song = ReentrantSong(**original)
        with self.assertRaises(ProtocolFailure) as raised:
            start_listening_playback(self.context, self.params,
                                    identity_builder=lambda _song: {"liveSetId": self.params["expectedLiveSetId"]})
        self.assertEqual(raised.exception.details["mutationState"], "indeterminate")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.context.song.current_song_time, 0)

    def test_seek_throw_after_apply_is_indeterminate_with_no_start_or_rollback(self):
        original = vars(self.song).copy()
        class FailingSeek(types.SimpleNamespace):
            def __setattr__(song, field, value):
                super(FailingSeek, song).__setattr__(field, value)
                if field == "current_song_time":
                    raise RuntimeError("seek applied before failure")
        self.context.song = FailingSeek(**original)
        with self.assertRaises(ProtocolFailure) as raised:
            start_listening_playback(self.context, self.params,
                                    identity_builder=lambda _song: {"liveSetId": self.params["expectedLiveSetId"]})
        self.assertEqual(raised.exception.details["stage"], "seek")
        self.assertEqual(raised.exception.details["currentBeat"], 0)
        self.assertEqual(self.calls, [])

    def test_unavailable_primitives_and_inactive_listener_deny_without_mutation(self):
        self.assertTrue(guarded_arrangement_start_supported(self.song))
        self.song.continue_playing = None
        self.assertFalse(guarded_arrangement_start_supported(self.song))
        with self.assertRaises(ProtocolFailure):
            start_listening_playback(self.context, self.params)
        self.assertEqual(self.song.current_song_time, 4)
        self.song.continue_playing = lambda: None
        self.song.tracks[0].devices[0].is_active = False
        with self.assertRaises(ProtocolFailure):
            start_listening_playback(self.context, self.params)
        self.assertEqual(self.song.current_song_time, 4)

    def test_unconfirmed_start_cannot_be_a_success_acknowledgement(self):
        self.song.continue_playing = lambda: None
        with self.assertRaises(ProtocolFailure) as raised:
            start_listening_playback(self.context, self.params)
        self.assertEqual(raised.exception.details["stage"], "verify")
        self.assertFalse(raised.exception.details["playing"])
        self.assertEqual(raised.exception.details["cleanupPolicy"], "leave-running")

    def test_capability_advertises_only_guarded_live11_start_never_stop(self):
        registry = CommandRegistry()
        register_playback_commands(registry)
        for version, expected in (("11.3.42", True), ("12.0", False)):
            application = types.SimpleNamespace(get_version_string=lambda: version)
            document = build_capability_document(application, self.song, registry)
            self.assertIs(document["capabilities"]["listening.start_playback"], expected)
            self.assertFalse(document["capabilities"]["listening.stop_playback"])
        del self.song.continue_playing
        application = types.SimpleNamespace(get_version_string=lambda: "11.3.42")
        document = build_capability_document(application, self.song, registry)
        self.assertFalse(document["capabilities"]["listening.start_playback"])

    def test_validator_bounds_versions_identity_and_mode(self):
        for change in (
            {"schemaVersion": True}, {"schemaVersion": 2}, {"ownerId": " "},
            {"passId": "physical-Max-ID"}, {"expectedProjectRevision": -1},
            {"listeners": []}, {"listeners": [TARGET] * 9},
            {"range": {"startBeat": 8, "endBeat": 8}},
            {"range": {"startBeat": 0, "endBeat": float("inf")}},
            {"mode": "session"}, {"path": "live_set tracks 0"},
        ):
            params = dict(START, **change)
            self.assertIsNotNone(validate_start(params), change)
        for params in ({}, {"schemaVersion": 1, "ownership": "token"}, dict(STOP, schemaVersion=True)):
            self.assertIsNotNone(validate_stop(params))

    def test_catalog_and_cross_language_fixtures_do_not_activate_playback(self):
        registry = CommandRegistry()
        register_playback_commands(registry)
        for metadata in registry.metadata().values():
            self.assertTrue(metadata["mutates"])
        path = Path(__file__).resolve().parents[2] / "packages/protocol/contracts/command-fixtures.json"
        commands = json.loads(path.read_text())["commands"]
        self.assertIsNone(validate_start(commands["listening.start_playback"]["request"]["params"]))
        self.assertIsNone(validate_stop(commands["listening.stop_playback"]["request"]["params"]))


if __name__ == "__main__":
    unittest.main()
