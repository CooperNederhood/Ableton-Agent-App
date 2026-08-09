from __future__ import absolute_import, unicode_literals

import sys
import unittest
from pathlib import Path

REMOTE_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REMOTE_SCRIPT_ROOT))

from AbletonAgent.listeners import LomListenerManager  # noqa: E402


class ListenerTarget(object):
    def __init__(self, properties):
        self._listeners = dict((name, []) for name in properties)
        for name in properties:
            setattr(self, "add_{0}_listener".format(name), self._add(name))
            setattr(
                self,
                "remove_{0}_listener".format(name),
                self._remove(name),
            )

    def _add(self, name):
        return lambda callback: self._listeners[name].append(callback)

    def _remove(self, name):
        return lambda callback: self._listeners[name].remove(callback)

    def emit(self, name):
        for callback in list(self._listeners[name]):
            callback()

    def listener_count(self):
        return sum(len(callbacks) for callbacks in self._listeners.values())


class ListenerManagerTests(unittest.TestCase):
    def test_registers_publishes_revisions_and_removes_every_listener(self):
        song = ListenerTarget(("tempo", "is_playing", "tracks", "scenes"))
        song.view = ListenerTarget(("selected_track",))
        context = type(
            "Context",
            (),
            {"song": song, "project_revision": 0},
        )()
        published = []
        manager = LomListenerManager(
            context,
            lambda name, payload, revision: published.append(
                (name, payload, revision)
            ),
        )

        manager.start()
        manager.start()
        self.assertEqual(song.listener_count(), 4)
        self.assertEqual(song.view.listener_count(), 1)

        song.emit("tempo")
        song.view.emit("selected_track")

        self.assertEqual(
            published,
            [
                ("project.changed", {"reason": "tempo"}, 1),
                ("project.changed", {"reason": "selection"}, 2),
            ],
        )
        self.assertEqual(context.project_revision, 2)

        manager.stop()
        manager.stop()
        self.assertEqual(song.listener_count(), 0)
        self.assertEqual(song.view.listener_count(), 0)

    def test_skips_unsupported_listener_properties(self):
        song = ListenerTarget(("tempo",))
        context = type(
            "Context",
            (),
            {"song": song, "project_revision": 0},
        )()
        manager = LomListenerManager(context, lambda *_args: None)

        manager.start()
        self.assertEqual(song.listener_count(), 1)
        manager.stop()
        self.assertEqual(song.listener_count(), 0)


if __name__ == "__main__":
    unittest.main()
