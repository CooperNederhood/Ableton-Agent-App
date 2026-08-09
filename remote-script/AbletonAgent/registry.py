"""Declarative Remote Script command registry."""

from __future__ import absolute_import, unicode_literals

from .errors import ProtocolFailure


class Command(object):
    def __init__(
        self,
        name,
        handler,
        mutates=False,
        capability=None,
        timeout_class="normal",
        validator=None,
    ):
        self.name = name
        self.handler = handler
        self.mutates = mutates
        self.capability = capability
        self.timeout_class = timeout_class
        self.validator = validator

    def execute(self, context, params):
        if self.validator is not None:
            message = self.validator(params)
            if message:
                raise ProtocolFailure("invalid_params", message)
        return self.handler(context, params)


class CommandRegistry(object):
    def __init__(self):
        self._commands = {}

    def register(
        self,
        name,
        handler,
        mutates=False,
        capability=None,
        timeout_class="normal",
        validator=None,
    ):
        if name in self._commands:
            raise ValueError("Command already registered: {0}".format(name))
        self._commands[name] = Command(
            name,
            handler,
            mutates=mutates,
            capability=capability,
            timeout_class=timeout_class,
            validator=validator,
        )

    def get(self, name):
        return self._commands.get(name)

    def metadata(self):
        return {
            name: {
                "mutates": command.mutates,
                "capability": command.capability,
                "timeoutClass": command.timeout_class,
            }
            for name, command in self._commands.items()
        }
