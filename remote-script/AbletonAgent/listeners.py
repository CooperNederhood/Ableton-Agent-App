"""Low-frequency Live Object Model listener registration and cleanup."""

from __future__ import absolute_import, unicode_literals

import datetime

from .event_subscriptions import curated_state_entries


class LomListenerManager(object):
    EVENTS = (
        ("tempo", "tempo"),
        ("signature_numerator", "tempo"),
        ("signature_denominator", "tempo"),
        ("is_playing", "transport"),
        ("record_mode", "transport"),
        ("session_record", "transport"),
        ("tracks", "tracks"),
        ("scenes", "scenes"),
    )

    def __init__(self, context, publish_event, logger=None):
        self._context = context
        self._publish_event = publish_event
        self._logger = logger or (lambda _message: None)
        self._registrations = []
        self._started = False
        self._meter_flush_scheduled = False

    def start(self):
        if self._started:
            return
        self._started = True
        for property_name, reason in self.EVENTS:
            self._register(self._context.song, property_name, reason, self._topic(reason))
        view = getattr(self._context.song, "view", None)
        if view is not None:
            for property_name in (
                "selected_track",
                "selected_scene",
                "detail_clip",
                "selected_device",
                "highlighted_clip_slot",
            ):
                self._register(view, property_name, "selection", "selection")
        self._bind_track_listeners()
        for entry in curated_state_entries(self._context):
            self._publish_state(entry["topic"], "initial")

    def stop(self):
        registrations = list(reversed(self._registrations))
        self._registrations = []
        self._started = False
        for target, property_name, callback in registrations:
            remove = getattr(
                target, "remove_{0}_listener".format(property_name), None
            )
            if remove is None:
                continue
            try:
                remove(callback)
            except Exception as exc:
                self._logger(
                    "Failed to remove {0} listener: {1}".format(
                        property_name, exc
                    )
                )

    def _topic(self, reason):
        return {
            "tempo": "tempo-signature",
            "transport": "transport",
            "tracks": "track-topology",
            "scenes": "scene-topology",
            "selection": "selection",
        }.get(reason, reason)

    def _state(self, topic):
        for entry in curated_state_entries(self._context):
            if entry["topic"] == topic:
                return entry
        return None

    def _publish_state(self, topic, phase="update"):
        entry = self._state(topic)
        if entry is None:
            return
        self._publish_event(
            "live_state.changed",
            {
                "phase": phase,
                "observedAt": datetime.datetime.utcnow().isoformat() + "Z",
                "projectRevision": self._context.project_revision,
                "entry": entry,
            },
            self._context.project_revision,
        )

    def _bind_track_listeners(self):
        for track in list(getattr(self._context.song, "tracks", ()) or ()):
            self._register(track, "clip_slots", "clip-topology", "clip-topology")
            self._register(track, "devices", "device-topology", "device-topology")
            for slot in list(getattr(track, "clip_slots", ()) or ()):
                self._register(
                    slot, "has_clip", "clip-topology", "clip-topology"
                )
            for property_name in (
                "current_input_routing",
                "current_input_sub_routing",
                "current_output_routing",
                "current_output_sub_routing",
            ):
                self._register(track, property_name, "routing", "routing")
            for property_name in ("output_meter_left", "output_meter_right"):
                self._register(
                    track,
                    property_name,
                    "meters",
                    "meters",
                    coalesced=True,
                )

    def _register(
        self, target, property_name, reason, topic=None, coalesced=False
    ):
        add = getattr(target, "add_{0}_listener".format(property_name), None)
        if add is None:
            return

        def on_change():
            if reason in ("tracks", "scenes"):
                self._rebind_all()
            if coalesced:
                if self._meter_flush_scheduled:
                    return
                self._meter_flush_scheduled = True

                def flush():
                    self._meter_flush_scheduled = False
                    self._publish_state(topic or reason)

                self._context.schedule_message(2, flush)
            else:
                self._context.project_revision += 1
                self._publish_event(
                    "project.changed",
                    {"reason": reason},
                    self._context.project_revision,
                )
                self._publish_state(topic or reason)

        try:
            add(on_change)
            self._registrations.append((target, property_name, on_change))
        except Exception as exc:
            self._logger(
                "Failed to add {0} listener: {1}".format(
                    property_name, exc
                )
            )

    def _rebind_all(self):
        retained = []
        for target, property_name, callback in self._registrations:
            if target is self._context.song or target is getattr(
                self._context.song, "view", None
            ):
                retained.append((target, property_name, callback))
                continue
            remove = getattr(
                target, "remove_{0}_listener".format(property_name), None
            )
            if callable(remove):
                try:
                    remove(callback)
                except Exception:
                    pass
        self._registrations = retained
        self._bind_track_listeners()
        for topic in (
            "track-topology",
            "scene-topology",
            "clip-topology",
            "device-topology",
            "routing",
            "meters",
        ):
            self._publish_state(topic, "rebound")
