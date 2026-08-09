"""System and session inspection commands."""

from __future__ import absolute_import, unicode_literals


def _no_params(params):
    if params:
        return "Command does not accept parameters"
    return None


def ping(_context, _params):
    return {"pong": True}


def inspect_session(context, _params):
    song = context.song
    tracks = []
    for index, track in enumerate(song.tracks):
        tracks.append(
            {
                "index": index,
                "name": track.name,
                "color": getattr(track, "color", None),
                "isMuted": bool(track.mute),
                "isSoloed": bool(track.solo),
                "isArmed": bool(getattr(track, "arm", False)),
            }
        )
    return {
        "tempo": song.tempo,
        "timeSignature": {
            "numerator": song.signature_numerator,
            "denominator": song.signature_denominator,
        },
        "isPlaying": bool(song.is_playing),
        "trackCount": len(tracks),
        "tracks": tracks,
    }


def register_system_commands(registry):
    registry.register("system.ping", ping, validator=_no_params)
    registry.register("session.inspect", inspect_session, validator=_no_params)
