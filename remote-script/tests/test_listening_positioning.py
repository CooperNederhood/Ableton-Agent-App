import types
import unittest

from AbletonAgent import listening_playback as playback
from AbletonAgent.errors import ProtocolFailure
from AbletonAgent.executor import DeferredResult
import test_listening_playback as fixtures


class ListeningPositioningTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ListeningPlaybackTest()
        self.fixture.setUp()
        self.context = self.fixture.context
        self.song = self.fixture.song
        self.song.current_song_time = 9
        self.params = dict(self.fixture.params, range={"startBeat": 5.25, "endBeat": 9.5})
        live_set_id = self.params["expectedLiveSetId"]
        self.identity = lambda _song: {"liveSetId": live_set_id}
        self.success, self.failures, self.progress = [], [], []

    def begin(self):
        result = playback.position_listening_playback(
            self.context, self.params, identity_builder=self.identity)
        self.assertIsInstance(result, DeferredResult)
        result.start(self.success.append, self.failures.append, self.progress.append)

    def drain(self):
        while self.context.pending_callbacks:
            self.context.pending_callbacks.pop(0)()

    def test_fractional_position_is_read_back_before_arm_without_starting(self):
        self.begin()
        self.assertEqual(self.song.start_time, 5.25)
        self.assertEqual(self.song.current_song_time, 9)
        self.assertEqual(self.success, [])
        self.context.pending_callbacks.pop(0)()
        self.assertEqual(self.song.current_song_time, 5.25)
        self.assertEqual(self.success, [])
        self.drain()
        self.assertEqual(self.success, [{
            "schemaVersion": 1, "mode": "arrangement",
            "cleanupPolicy": "leave-running", "sourceOnset": "unverified",
            "requestedStartBeat": 5.25, "insertMarkerBeat": 5.25,
            "currentBeat": 5.25, "playing": False,
            "changed": {"insertMarker": True, "currentPosition": True},
        }])
        self.assertEqual(self.failures, [])
        self.assertEqual(self.fixture.calls, [])
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.progress, [
            {"phase": "listening_position_marker_verification"},
            {"phase": "listening_position_seek_verification"},
        ])

    def test_noop_still_requires_later_readbacks_but_never_writes(self):
        class NoPositionWrites(types.SimpleNamespace):
            def __setattr__(song, field, value):
                if field in ("start_time", "current_song_time"):
                    raise AssertionError("Redundant position write")
                super(NoPositionWrites, song).__setattr__(field, value)
        self.song.start_time = self.song.current_song_time = 5.25
        self.song = NoPositionWrites(**vars(self.song))
        self.context.song = self.song
        self.begin()
        self.assertEqual(self.success, [])
        self.drain()
        self.assertEqual(self.success[0]["changed"], {
            "insertMarker": False, "currentPosition": False,
        })
        self.assertEqual(self.fixture.calls, [])

    def test_ignored_marker_write_never_seeks_or_reports_success(self):
        class IgnoredMarker(types.SimpleNamespace):
            def __setattr__(song, field, value):
                if field != "start_time":
                    super(IgnoredMarker, song).__setattr__(field, value)
        self.song = IgnoredMarker(**vars(self.song))
        self.context.song = self.song
        self.begin()
        self.drain()
        self.assertEqual(self.success, [])
        self.assertEqual(self.song.current_song_time, 9)
        self.assertEqual(self.failures[0].details["mutationState"], "indeterminate")
        self.assertEqual(self.fixture.calls, [])

    def test_ignored_seek_write_is_not_position_acknowledgement(self):
        class IgnoredSeek(types.SimpleNamespace):
            def __setattr__(song, field, value):
                if field != "current_song_time":
                    super(IgnoredSeek, song).__setattr__(field, value)
        self.song = IgnoredSeek(**vars(self.song))
        self.context.song = self.song
        self.begin()
        self.drain()
        self.assertEqual(self.success, [])
        self.assertEqual(self.failures[0].details["stage"], "position_verify")
        self.assertEqual(self.song.current_song_time, 9)
        self.assertEqual(self.song.start_time, 5.25)

    def test_deferred_setters_settle_before_independent_readbacks(self):
        context = self.context
        class DelayedPosition(types.SimpleNamespace):
            def __setattr__(song, field, value):
                if field in ("start_time", "current_song_time"):
                    context.pending_callbacks.append(
                        lambda: object.__setattr__(song, field, value))
                else:
                    super(DelayedPosition, song).__setattr__(field, value)
        self.song = DelayedPosition(**vars(self.song))
        self.context.song = self.song
        self.begin()
        self.assertEqual(self.song.start_time, 0)
        self.assertEqual(self.success, [])
        self.drain()
        self.assertEqual(self.failures, [])
        self.assertEqual(self.success[0]["currentBeat"], 5.25)
        self.assertFalse(self.song.is_playing)

    def test_pre_mutation_identity_revision_or_recording_denial_preserves_position(self):
        for change in (
            {"expectedLiveSetId": "another-set"},
            {"expectedProjectRevision": 8},
        ):
            with self.subTest(change=change):
                original = self.params
                self.params = dict(original, **change)
                with self.assertRaises(ProtocolFailure) as raised:
                    self.begin()
                self.assertFalse(raised.exception.details["mutated"])
                self.assertEqual(self.song.start_time, 0)
                self.assertEqual(self.song.current_song_time, 9)
                self.params = original
        self.song.session_record = True
        with self.assertRaises(ProtocolFailure) as raised:
            self.begin()
        self.assertFalse(raised.exception.details["mutated"])
        self.assertEqual(self.fixture.calls, [])

    def test_source_change_after_marker_is_not_hidden_by_own_revision_change(self):
        self.begin()
        self.context.project_revision += 1
        self.song.tempo += 1
        self.drain()
        self.assertEqual(self.success, [])
        self.assertEqual(self.failures[0].details["mutationState"], "indeterminate")
        self.assertEqual(self.song.current_song_time, 9)
        self.assertEqual(self.fixture.calls, [])

    def test_recording_or_user_playback_between_stages_never_seeks_or_cleans_up(self):
        for field in ("record_mode", "is_playing"):
            with self.subTest(field=field):
                self.setUp()
                self.begin()
                setattr(self.song, field, True)
                self.drain()
                self.assertEqual(self.success, [])
                self.assertEqual(self.failures[0].details["cleanupPolicy"], "leave-running")
                self.assertEqual(self.song.current_song_time, 9)
                self.assertTrue(getattr(self.song, field))
                self.assertEqual(self.fixture.calls, [])

    def test_partial_marker_setter_failure_is_indeterminate_and_not_restored(self):
        class PartialMarker(types.SimpleNamespace):
            def __setattr__(song, field, value):
                super(PartialMarker, song).__setattr__(field, value)
                if field == "start_time":
                    raise RuntimeError("private setter failure")
        self.song = PartialMarker(**vars(self.song))
        self.context.song = self.song
        self.begin()
        self.assertEqual(self.success, [])
        self.assertEqual(self.failures[0].details["mutationState"], "indeterminate")
        self.assertNotIn("private setter", self.failures[0].message)
        self.assertEqual(self.song.start_time, 5.25)
        self.assertEqual(self.song.current_song_time, 9)

    def test_scheduler_failure_is_explicit_after_marker_mutation(self):
        def broken_schedule(_ticks, _callback):
            raise RuntimeError("private scheduler failure")
        self.context.schedule_message = broken_schedule
        self.begin()
        self.assertEqual(self.success, [])
        self.assertEqual(self.failures[0].details["mutationState"], "indeterminate")
        self.assertEqual(self.song.start_time, 5.25)
        self.assertEqual(self.song.current_song_time, 9)

    def test_session_or_extra_position_parameters_deny_without_lom_access(self):
        context = types.SimpleNamespace(song=fixtures.ForbiddenLom())
        for change in (
            {"mode": "session"},
            {"schemaVersion": 2},
            {"stopAfterPosition": True},
            {"range": {"startBeat": 5.25, "endBeat": 5.25}},
        ):
            with self.subTest(change=change), self.assertRaises(ProtocolFailure) as raised:
                playback.position_listening_playback(context, dict(self.params, **change))
            self.assertEqual(raised.exception.code, "invalid_params")


if __name__ == "__main__":
    unittest.main()
