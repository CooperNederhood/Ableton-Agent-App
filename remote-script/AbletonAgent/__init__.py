"""Ableton Agent Remote Script package."""


def create_instance(c_instance):
    from .control_surface import AbletonAgentControlSurface

    return AbletonAgentControlSurface(c_instance)
