"""Low-frequency Live Object Model listener registration and cleanup."""

from __future__ import absolute_import, unicode_literals


class LomListenerManager(object):
    EVENTS = (
        ("tempo", "tempo"),
        ("is_playing", "transport"),
        ("tracks", "tracks"),
        ("scenes", "scenes"),
    )

    def __init__(self, context, publish_event, logger=None):
        self._context = context
        self._publish_event = publish_event
        self._logger = logger or (lambda _message: None)
        self._registrations = []
        self._started = False

    def start(self):
        if self._started:
            return
        self._started = True
        for property_name, reason in self.EVENTS:
            self._register(self._context.song, property_name, reason)
        view = getattr(self._context.song, "view", None)
        if view is not None:
            self._register(view, "selected_track", "selection")

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

    def _register(self, target, property_name, reason):
        add = getattr(target, "add_{0}_listener".format(property_name), None)
        if add is None:
            return

        def on_change():
            self._context.project_revision += 1
            self._publish_event(
                "project.changed",
                {"reason": reason},
                self._context.project_revision,
            )

        try:
            add(on_change)
            self._registrations.append((target, property_name, on_change))
        except Exception as exc:
            self._logger(
                "Failed to add {0} listener: {1}".format(
                    property_name, exc
                )
            )
