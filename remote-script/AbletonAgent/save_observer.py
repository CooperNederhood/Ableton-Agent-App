"""Stable metadata-only observation of user-initiated Live Set saves."""

from __future__ import absolute_import, unicode_literals

import datetime
import os

from .identity import build_live_identity

MAX_SAFE_INTEGER = 9007199254740991


def _observed_at():
    return datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


class LiveSetSaveObserver(object):
    def __init__(
        self,
        context,
        publish_event,
        logger=None,
        stat_path=None,
        stable_samples=2,
        poll_ticks=10,
    ):
        self._context = context
        self._publish_event = publish_event
        self._logger = logger or (lambda _message: None)
        self._stat_path = stat_path or os.stat
        self._stable_samples = max(2, stable_samples)
        self._poll_ticks = max(1, poll_ticks)
        self._started = False
        self._generation = 0
        self._song_object = None
        self._live_set_id = None
        self._baseline = None
        self._candidate = None
        self._candidate_samples = 0
        self._had_unsaved_identity = False

    def start(self):
        if self._started:
            return
        self._started = True
        self._generation += 1
        generation = self._generation
        self._sample()
        self._schedule(generation)

    def stop(self):
        self._started = False
        self._generation += 1
        self._candidate = None
        self._candidate_samples = 0

    def sample_now(self):
        if self._started:
            self._sample()

    def _schedule(self, generation):
        self._context.schedule_message(
            self._poll_ticks,
            lambda: self._scheduled_sample(generation),
        )

    def _scheduled_sample(self, generation):
        if not self._started or generation != self._generation:
            return
        self._sample()
        self._schedule(generation)

    def _sample(self):
        song = self._context.song
        identity = build_live_identity(song)
        live_set_id = identity["liveSetId"]
        saved = identity["saved"]
        song_switched = self._song_object is not None and song is not self._song_object
        identity_changed = (
            self._live_set_id is not None and live_set_id != self._live_set_id
        )

        if song_switched:
            self._reset(song, live_set_id, saved)
            return

        if not saved:
            self._song_object = song
            self._live_set_id = live_set_id
            self._had_unsaved_identity = True
            self._baseline = None
            self._candidate = None
            self._candidate_samples = 0
            return

        metadata = self._metadata(getattr(song, "file_path", "") or "")
        if metadata is None:
            return

        emit_initial = identity_changed and self._had_unsaved_identity
        save_as = identity_changed and self._song_object is song
        if identity_changed:
            self._live_set_id = live_set_id
            self._baseline = None if (emit_initial or save_as) else metadata
            self._candidate = metadata if (emit_initial or save_as) else None
            self._candidate_samples = 1 if (emit_initial or save_as) else 0
            self._had_unsaved_identity = False
            if emit_initial or save_as:
                return

        self._song_object = song
        self._live_set_id = live_set_id
        if self._baseline is None and self._candidate is None:
            self._baseline = metadata
            self._had_unsaved_identity = False
            return
        if metadata == self._baseline:
            self._candidate = None
            self._candidate_samples = 0
            return
        if metadata != self._candidate:
            self._candidate = metadata
            self._candidate_samples = 1
            return
        self._candidate_samples += 1
        if self._candidate_samples < self._stable_samples:
            return

        self._baseline = metadata
        self._candidate = None
        self._candidate_samples = 0
        self._had_unsaved_identity = False
        self._publish_event(
            "live_set.save_observed",
            {
                "liveSetId": live_set_id,
                "observedAt": _observed_at(),
                "fileModifiedTimeNs": str(metadata[0]),
                "fileSizeBytes": metadata[1],
            },
            self._context.project_revision,
        )

    def _reset(self, song, live_set_id, saved):
        self._song_object = song
        self._live_set_id = live_set_id
        self._baseline = None
        self._candidate = None
        self._candidate_samples = 0
        self._had_unsaved_identity = not saved
        if saved:
            self._baseline = self._metadata(
                getattr(song, "file_path", "") or ""
            )

    def _metadata(self, path):
        if not path:
            return None
        try:
            value = self._stat_path(path)
        except (OSError, ValueError) as exc:
            self._logger("Live Set save metadata unavailable: {0}".format(exc))
            return None
        modified_ns = getattr(value, "st_mtime_ns", None)
        if modified_ns is None:
            modified_ns = int(value.st_mtime * 1000000000)
        size = value.st_size
        if (
            not isinstance(modified_ns, int)
            or modified_ns < 0
            or not isinstance(size, int)
            or size < 0
            or size > MAX_SAFE_INTEGER
        ):
            self._logger("Live Set save metadata was outside protocol bounds")
            return None
        return (modified_ns, size)
