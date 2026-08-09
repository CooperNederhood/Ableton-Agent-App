"""System and session inspection commands."""

from __future__ import absolute_import, unicode_literals

from .executor import DeferredResult


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

def _set_tempo_params(params):
    if set(params.keys()) != set(["tempo"]):
        return "tempo is the only accepted parameter"
    tempo = params.get("tempo")
    if isinstance(tempo, bool) or not isinstance(tempo, (int, float)):
        return "tempo must be a number"
    if tempo < 20 or tempo > 999:
        return "tempo must be between 20 and 999 BPM"
    return None


def set_tempo(context, params):
    before = context.song.tempo
    context.song.tempo = params["tempo"]
    after = context.song.tempo
    return {
        "beforeTempo": before,
        "afterTempo": after,
        "verified": abs(after - params["tempo"]) < 0.001,
    }

def _set_playing_params(params):
    if set(params.keys()) != set(["isPlaying"]):
        return "isPlaying is the only accepted parameter"
    if not isinstance(params.get("isPlaying"), bool):
        return "isPlaying must be a boolean"
    return None


def set_playing(context, params):
    song = context.song
    before = bool(song.is_playing)
    if params["isPlaying"]:
        song.start_playing()
    else:
        song.stop_playing()

    def start_verification(on_success, on_failure):
        def verify():
            try:
                after = bool(song.is_playing)
                on_success(
                    {
                        "beforeIsPlaying": before,
                        "afterIsPlaying": after,
                        "verified": after == params["isPlaying"],
                    }
                )
            except Exception as exc:
                on_failure(exc)

        context.schedule_message(1, verify)

    return DeferredResult(start_verification)


def register_system_commands(registry):
    registry.register("system.ping", ping, validator=_no_params)
    registry.register("session.inspect", inspect_session, validator=_no_params)
    registry.register(
        "transport.set_tempo",
        set_tempo,
        mutates=True,
        capability="transport.set_tempo",
        validator=_set_tempo_params,
    )
    registry.register(
        "transport.set_playing",
        set_playing,
        mutates=True,
        capability="transport.set_playing",
        validator=_set_playing_params,
    )
