from __future__ import absolute_import, unicode_literals

import sys
import unittest
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.identity import build_live_identity  # noqa: E402
from AbletonAgent.save_observer import (  # noqa: E402
    MAX_SAFE_INTEGER,
    LiveSetSaveObserver,
)


class FakeSong(object):
    def __init__(self, path="", name="Set"):
        self.file_path = path
        self.name = name


class FakeContext(object):
    def __init__(self, song):
        self.song = song
        self.project_revision = 7
        self.scheduled = []

    def schedule_message(self, delay, callback):
        self.scheduled.append((delay, callback))


class FakeStat(object):
    def __init__(self, modified_ns, size):
        self.st_mtime_ns = modified_ns
        self.st_mtime = modified_ns / 1000000000.0
        self.st_size = size


class SaveObserverTests(unittest.TestCase):
    def test_baselines_then_emits_only_stable_changed_metadata(self):
        song = FakeSong("/Music/Set.als")
        context = FakeContext(song)
        metadata = [FakeStat(100, 10)]
        published = []
        observer = LiveSetSaveObserver(
            context,
            lambda *args: published.append(args),
            stat_path=lambda _path: metadata[-1],
            poll_ticks=3,
        )

        observer.start()
        self.assertEqual(context.scheduled[0][0], 3)
        observer.sample_now()
        self.assertEqual(published, [])

        metadata.append(FakeStat(200, 20))
        observer.sample_now()
        self.assertEqual(published, [])
        metadata.append(FakeStat(201, 20))
        observer.sample_now()
        self.assertEqual(published, [])
        observer.sample_now()

        self.assertEqual(len(published), 1)
        name, payload, revision = published[0]
        self.assertEqual(name, "live_set.save_observed")
        self.assertEqual(payload["fileModifiedTimeNs"], "201")
        self.assertEqual(payload["fileSizeBytes"], 20)
        self.assertNotIn("filePath", payload)
        self.assertEqual(revision, 7)

    def test_observes_first_save_and_save_as_but_not_set_switch(self):
        song = FakeSong()
        context = FakeContext(song)
        values = {
            "/Music/First.als": FakeStat(100, 10),
            "/Music/Copy.als": FakeStat(200, 20),
            "/Music/Other.als": FakeStat(300, 30),
        }
        published = []
        observer = LiveSetSaveObserver(
            context,
            lambda *args: published.append(args),
            stat_path=lambda path: values[path],
        )
        observer.start()

        song.file_path = "/Music/First.als"
        first_id = build_live_identity(song)["liveSetId"]
        observer.sample_now()
        observer.sample_now()
        song.file_path = "/Music/Copy.als"
        copy_id = build_live_identity(song)["liveSetId"]
        observer.sample_now()
        observer.sample_now()

        context.song = FakeSong("/Music/Other.als", "Other")
        observer.sample_now()
        observer.sample_now()

        self.assertEqual(
            [item[1]["liveSetId"] for item in published],
            [first_id, copy_id],
        )
        self.assertEqual(
            [item[1]["fileModifiedTimeNs"] for item in published],
            ["100", "200"],
        )

    def test_tolerates_missing_and_rejects_unsafe_metadata(self):
        song = FakeSong("/Music/Set.als")
        context = FakeContext(song)
        errors = [OSError("replacing"), FakeStat(100, MAX_SAFE_INTEGER + 1)]
        logs = []

        def stat_path(_path):
            value = errors.pop(0)
            if isinstance(value, Exception):
                raise value
            return value

        observer = LiveSetSaveObserver(
            context,
            lambda *_args: self.fail("must not publish"),
            logger=logs.append,
            stat_path=stat_path,
        )
        observer.start()
        observer.sample_now()

        self.assertEqual(len(logs), 2)

    def test_stop_cancels_scheduled_sampling(self):
        song = FakeSong("/Music/Set.als")
        context = FakeContext(song)
        calls = []
        observer = LiveSetSaveObserver(
            context,
            lambda *_args: None,
            stat_path=lambda _path: calls.append(True) or FakeStat(100, 10),
        )
        observer.start()
        scheduled = context.scheduled.pop()[1]
        observer.stop()
        scheduled()
        self.assertEqual(len(calls), 1)
        self.assertEqual(context.scheduled, [])


if __name__ == "__main__":
    unittest.main()
