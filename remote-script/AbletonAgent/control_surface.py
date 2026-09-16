"""Ableton ControlSurface lifecycle integration."""

from __future__ import absolute_import, unicode_literals

import os

from _Framework.ControlSurface import ControlSurface

from .capabilities import build_capability_document
from .event_subscriptions import (
    LomSubscriptionManager,
    register_event_commands,
)
from .executor import MainThreadExecutor
from .listeners import LomListenerManager
from .registry import CommandRegistry
from .server import RemoteScriptServer
from .system_commands import register_system_commands
from .token_store import load_or_create_token


class RuntimeContext(object):
    def __init__(self, application, song, schedule_message):
        self.application = application
        self.song = song
        self.schedule_message = schedule_message
        self.project_revision = 0


class AbletonAgentControlSurface(ControlSurface):
    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        registry = CommandRegistry()
        context = RuntimeContext(
            self.application(), self.song(), self.schedule_message
        )
        self._subscription_manager = LomSubscriptionManager(
            context,
            lambda name, payload, revision=None: self._server.publish_event(
                name, payload, revision
            ),
            logger=self.log_message,
        )
        register_system_commands(registry)
        register_event_commands(registry, self._subscription_manager)
        self._executor = MainThreadExecutor(
            self.schedule_message,
            registry,
            context,
            logger=self.log_message,
        )
        token = load_or_create_token(os.path.dirname(__file__))
        capabilities = build_capability_document(
            context.application, context.song, registry
        )
        self._server = RemoteScriptServer(
            self._executor,
            token,
            capabilities,
            logger=self.log_message,
            on_client_disconnect=lambda: self.schedule_message(
                0, self._subscription_manager.clear
            ),
        )
        self._server.start()
        self._listeners = LomListenerManager(
            context, self._server.publish_event, logger=self.log_message
        )
        self._listeners.start()

    def disconnect(self):
        self._subscription_manager.stop()
        self._listeners.stop()
        self._server.stop()
        self._executor.close()
        ControlSurface.disconnect(self)
