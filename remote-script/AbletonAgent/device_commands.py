"""Bounded regular-track device, rack, chain, pad, and parameter commands."""

from __future__ import absolute_import, unicode_literals

import math
import uuid

from .errors import ProtocolFailure
from .system_commands import (
    _resolve_track,
    _same_lom_object,
    _track_reference,
)

DEVICE_PAGE_LIMIT = 128
PARAMETER_PAGE_LIMIT = 256
CHAIN_PAGE_LIMIT = 64
CHAIN_DEVICE_PAGE_LIMIT = 128
DRUM_PAD_PAGE_LIMIT = 128
DEVICE_ON_NAMES = ("Device On", "Device Activator")


def _is_finite_number(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _runtime_reference(context, attribute, target, reachable):
    entries = [
        (candidate, reference)
        for candidate, reference in getattr(context, attribute, [])
        if any(_same_lom_object(candidate, current) for current in reachable)
    ]
    for candidate, reference in entries:
        if _same_lom_object(candidate, target):
            setattr(context, attribute, entries)
            return reference
    reference = str(uuid.uuid4())
    entries.append((target, reference))
    setattr(context, attribute, entries)
    return reference


def _device_reference(context, device):
    return _runtime_reference(
        context, "_device_references", device, _reachable_devices(context)
    )


def _top_level_devices(context):
    return [
        device
        for track in context.song.tracks
        for device in getattr(track, "devices", ())
    ]


def _direct_rack_chains(device):
    if not bool(getattr(device, "can_have_chains", False)):
        return ()
    return getattr(device, "chains", ())


def _direct_drum_pads(device):
    if not bool(getattr(device, "can_have_drum_pads", False)):
        return ()
    return getattr(device, "drum_pads", ())


def _reachable_chains(context):
    chains = []
    for device in _top_level_devices(context):
        chains.extend(_direct_rack_chains(device))
        for pad in _direct_drum_pads(device):
            chains.extend(getattr(pad, "chains", ()))
    return chains


def _reachable_devices(context):
    devices = list(_top_level_devices(context))
    for chain in _reachable_chains(context):
        devices.extend(getattr(chain, "devices", ()))
    return devices


def _chain_reference(context, chain):
    return _runtime_reference(
        context, "_chain_references", chain, _reachable_chains(context)
    )


def _pad_reference(context, pad):
    reachable = [
        candidate
        for device in _top_level_devices(context)
        for candidate in _direct_drum_pads(device)
    ]
    return _runtime_reference(context, "_pad_references", pad, reachable)


def _chain_device_reference(context, device):
    reference = _device_reference(context, device)
    context._chain_device_references = context._device_references
    return reference


def _parameter_reference(context, parameter):
    reachable = [
        candidate
        for device in _reachable_devices(context)
        for candidate in getattr(device, "parameters", ())
    ]
    for chain in _reachable_chains(context):
        mixer = getattr(chain, "mixer_device", None)
        if mixer is None:
            continue
        for name in ("volume", "panning"):
            candidate = getattr(mixer, name, None)
            if candidate is not None:
                reachable.append(candidate)
        reachable.extend(getattr(mixer, "sends", ()))
    return _runtime_reference(
        context, "_parameter_references", parameter, reachable
    )


def _device_on_parameter(device):
    parameters = getattr(device, "parameters", ())
    if not parameters:
        return None
    parameter = parameters[0]
    names = (
        getattr(parameter, "original_name", None),
        getattr(parameter, "name", None),
    )
    return parameter if any(name in DEVICE_ON_NAMES for name in names) else None


def _parameter_bounds(parameter):
    minimum = getattr(parameter, "min", None)
    maximum = getattr(parameter, "max", None)
    value = getattr(parameter, "value", None)
    if not all(
        _is_finite_number(candidate)
        for candidate in (minimum, maximum, value)
    ) or maximum < minimum:
        raise ProtocolFailure(
            "conflict", "Parameter has invalid current numeric state"
        )
    return float(minimum), float(maximum), float(value)


def _normalized_value(minimum, maximum, value):
    if maximum == minimum:
        return 0.0
    normalized = (value - minimum) / (maximum - minimum)
    return min(1.0, max(0.0, normalized))


def _value_item_count(parameter):
    if not bool(getattr(parameter, "is_quantized", False)):
        return 0
    try:
        return len(parameter.value_items)
    except Exception:
        return 0


def _parameter_summary(context, device_reference, index, parameter):
    minimum, maximum, value = _parameter_bounds(parameter)
    return {
        "reference": _parameter_reference(context, parameter),
        "deviceReference": device_reference,
        "index": index,
        "name": getattr(parameter, "name", "") or "",
        "value": value,
        "normalizedValue": _normalized_value(minimum, maximum, value),
        "min": minimum,
        "max": maximum,
        "isQuantized": bool(getattr(parameter, "is_quantized", False)),
        "isEnabled": bool(getattr(parameter, "is_enabled", True)),
        "valueItemCount": _value_item_count(parameter),
    }


def _device_enabled(device):
    parameter = _device_on_parameter(device)
    if parameter is None:
        return None
    minimum, maximum, value = _parameter_bounds(parameter)
    return _normalized_value(minimum, maximum, value) >= 0.5


def _device_summary(
    context, track_reference, track_index, device_index, device
):
    parameters = getattr(device, "parameters", ())
    return {
        "reference": _device_reference(context, device),
        "trackReference": track_reference,
        "trackIndex": track_index,
        "index": device_index,
        "name": getattr(device, "name", "") or "",
        "className": getattr(device, "class_name", "") or "",
        "classDisplayName": getattr(device, "class_display_name", "") or "",
        "enabled": _device_enabled(device),
        "parameterCount": len(parameters),
        "canHaveChains": bool(getattr(device, "can_have_chains", False)),
        "canHaveDrumPads": bool(
            getattr(device, "can_have_drum_pads", False)
        ),
    }


def _chain_summary(context, rack_reference, index, chain):
    return {
        "reference": _chain_reference(context, chain),
        "rackDeviceReference": rack_reference,
        "index": index,
        "name": getattr(chain, "name", "") or "",
        "color": getattr(chain, "color", None),
        "deviceCount": len(getattr(chain, "devices", ())),
    }


def _drum_pad_summary(context, rack_reference, index, pad):
    note = getattr(pad, "note", None)
    if (
        isinstance(note, bool)
        or not isinstance(note, int)
        or note < 0
        or note > 127
    ):
        raise ProtocolFailure(
            "conflict", "Drum pad has an invalid current MIDI note"
        )
    return {
        "reference": _pad_reference(context, pad),
        "rackDeviceReference": rack_reference,
        "index": index,
        "note": note,
        "name": getattr(pad, "name", "") or "",
        "mute": bool(getattr(pad, "mute", False)),
        "solo": bool(getattr(pad, "solo", False)),
        "chainCount": len(getattr(pad, "chains", ())),
    }


def _drum_pad_chain_summary(
    context, rack_reference, pad_reference, pad_index, index, chain
):
    summary = _chain_summary(context, rack_reference, index, chain)
    summary.update(
        {
            "drumPadReference": pad_reference,
            "drumPadIndex": pad_index,
        }
    )
    return summary


def _chain_device_summary(context, chain_reference, index, device):
    parameters = getattr(device, "parameters", ())
    return {
        "reference": _chain_device_reference(context, device),
        "chainReference": chain_reference,
        "index": index,
        "name": getattr(device, "name", "") or "",
        "className": getattr(device, "class_name", "") or "",
        "classDisplayName": getattr(device, "class_display_name", "") or "",
        "enabled": _device_enabled(device),
        "parameterCount": len(parameters),
        "canHaveChains": bool(getattr(device, "can_have_chains", False)),
        "canHaveDrumPads": bool(
            getattr(device, "can_have_drum_pads", False)
        ),
    }


def _validate_page(params, maximum):
    offset = params.get("offset", 0)
    limit = params.get("limit")
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > maximum
    ):
        return False
    return True


def _inspect_devices_params(params):
    from .system_commands import _validate_track_target

    message = _validate_track_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, DEVICE_PAGE_LIMIT):
        return "offset and limit must describe a bounded device page"
    return None


def inspect_devices(context, params):
    track = _resolve_track(context, params)
    devices = getattr(track, "devices", ())
    track_reference = _track_reference(context, track)
    offset = params["offset"]
    limit = params["limit"]
    return {
        "devices": [
            _device_summary(
                context,
                track_reference,
                params["index"],
                index,
                device,
            )
            for index, device in enumerate(
                devices[offset : offset + limit], start=offset
            )
        ],
        "total": len(devices),
        "offset": offset,
        "limit": limit,
    }


def _validate_device_target(params, extra_keys=None):
    from .system_commands import _validate_track_target

    extra = [
        "deviceIndex",
        "expectedDeviceReference",
        "expectedDeviceName",
    ] + list(extra_keys or [])
    message = _validate_track_target(params, extra)
    if message:
        return message
    index = params.get("deviceIndex")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "deviceIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedDeviceReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedDeviceReference must be a UUID"
    if not isinstance(params.get("expectedDeviceName"), str):
        return "expectedDeviceName must be a string"
    return None


def _resolve_device(context, params):
    track = _resolve_track(context, params)
    devices = getattr(track, "devices", ())
    index = params["deviceIndex"]
    if index >= len(devices):
        raise ProtocolFailure("not_found", "Device index is out of range")
    device = devices[index]
    reference = _device_reference(context, device)
    name = getattr(device, "name", "") or ""
    if (
        reference != params["expectedDeviceReference"]
        or name != params["expectedDeviceName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Device identity changed before operation",
            details={
                "deviceIndex": index,
                "expectedReference": params["expectedDeviceReference"],
                "actualReference": reference,
                "expectedName": params["expectedDeviceName"],
                "actualName": name,
            },
        )
    return track, device, devices


def _resolve_rack(context, params, drum=False):
    track, rack, devices = _resolve_device(context, params)
    capability = "can_have_drum_pads" if drum else "can_have_chains"
    collection = "drum_pads" if drum else "chains"
    label = "Drum Rack" if drum else "rack"
    if not hasattr(rack, capability):
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not expose documented {0} APIs".format(
                label
            ),
        )
    if not bool(getattr(rack, capability)):
        raise ProtocolFailure(
            "conflict",
            "The targeted device is not a {0}".format(label),
        )
    try:
        getattr(rack, collection)
    except Exception:
        raise ProtocolFailure(
            "unsupported_capability",
            "This Live version does not expose documented {0} APIs".format(
                label
            ),
        )
    return track, rack, devices


def _validate_uuid_field(params, key):
    try:
        uuid.UUID(params.get(key))
    except (AttributeError, TypeError, ValueError):
        return "{0} must be a UUID".format(key)
    return None


def _validate_chain_target(params, extra_keys=None):
    message = _validate_device_target(
        params,
        [
            "chainIndex",
            "expectedChainReference",
            "expectedChainName",
        ]
        + list(extra_keys or []),
    )
    if message:
        return message
    index = params.get("chainIndex")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "chainIndex must be a non-negative integer"
    message = _validate_uuid_field(params, "expectedChainReference")
    if message:
        return message
    if not isinstance(params.get("expectedChainName"), str):
        return "expectedChainName must be a string"
    return None


def _resolve_chain(context, rack, chains, params):
    index = params["chainIndex"]
    if index >= len(chains):
        raise ProtocolFailure("not_found", "Chain index is out of range")
    chain = chains[index]
    reference = _chain_reference(context, chain)
    name = getattr(chain, "name", "") or ""
    if (
        reference != params["expectedChainReference"]
        or name != params["expectedChainName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Chain identity changed before inspection",
            details={
                "chainIndex": index,
                "expectedReference": params["expectedChainReference"],
                "actualReference": reference,
                "expectedName": params["expectedChainName"],
                "actualName": name,
                "rackReference": _device_reference(context, rack),
            },
        )
    return chain


def _validate_drum_pad_target(params, extra_keys=None):
    message = _validate_device_target(
        params,
        [
            "padIndex",
            "expectedPadReference",
            "expectedPadNote",
            "expectedPadName",
        ]
        + list(extra_keys or []),
    )
    if message:
        return message
    index = params.get("padIndex")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "padIndex must be a non-negative integer"
    message = _validate_uuid_field(params, "expectedPadReference")
    if message:
        return message
    note = params.get("expectedPadNote")
    if (
        isinstance(note, bool)
        or not isinstance(note, int)
        or note < 0
        or note > 127
    ):
        return "expectedPadNote must be a MIDI note from 0 to 127"
    if not isinstance(params.get("expectedPadName"), str):
        return "expectedPadName must be a string"
    return None


def _resolve_drum_pad(context, rack, params):
    pads = getattr(rack, "drum_pads", ())
    index = params["padIndex"]
    if index >= len(pads):
        raise ProtocolFailure("not_found", "Drum pad index is out of range")
    pad = pads[index]
    reference = _pad_reference(context, pad)
    note = getattr(pad, "note", None)
    name = getattr(pad, "name", "") or ""
    if (
        reference != params["expectedPadReference"]
        or note != params["expectedPadNote"]
        or name != params["expectedPadName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Drum pad identity changed before inspection",
            details={
                "padIndex": index,
                "expectedReference": params["expectedPadReference"],
                "actualReference": reference,
                "expectedNote": params["expectedPadNote"],
                "actualNote": note,
                "expectedName": params["expectedPadName"],
                "actualName": name,
            },
        )
    return pad


def _inspect_device_parameters_params(params):
    message = _validate_device_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, PARAMETER_PAGE_LIMIT):
        return "offset and limit must describe a bounded parameter page"
    return None


def inspect_device_parameters(context, params):
    track, device, _devices = _resolve_device(context, params)
    parameters = getattr(device, "parameters", ())
    track_reference = _track_reference(context, track)
    device_reference = _device_reference(context, device)
    offset = params["offset"]
    limit = params["limit"]
    return {
        "device": _device_summary(
            context,
            track_reference,
            params["index"],
            params["deviceIndex"],
            device,
        ),
        "parameters": [
            _parameter_summary(
                context,
                device_reference,
                index,
                parameter,
            )
            for index, parameter in enumerate(
                parameters[offset : offset + limit], start=offset
            )
        ],
        "total": len(parameters),
        "offset": offset,
        "limit": limit,
    }


def _inspect_rack_chains_params(params):
    message = _validate_device_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, CHAIN_PAGE_LIMIT):
        return "offset and limit must describe a bounded chain page"
    return None


def inspect_rack_chains(context, params):
    track, rack, _devices = _resolve_rack(context, params)
    chains = getattr(rack, "chains", ())
    rack_reference = _device_reference(context, rack)
    offset = params["offset"]
    limit = params["limit"]
    return {
        "rack": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            rack,
        ),
        "chains": [
            _chain_summary(context, rack_reference, index, chain)
            for index, chain in enumerate(
                chains[offset : offset + limit], start=offset
            )
        ],
        "total": len(chains),
        "offset": offset,
        "limit": limit,
    }


def _inspect_rack_chain_devices_params(params):
    message = _validate_chain_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, CHAIN_DEVICE_PAGE_LIMIT):
        return "offset and limit must describe a bounded chain-device page"
    return None


def inspect_rack_chain_devices(context, params):
    track, rack, _devices = _resolve_rack(context, params)
    chain = _resolve_chain(context, rack, getattr(rack, "chains", ()), params)
    rack_reference = _device_reference(context, rack)
    chain_reference = _chain_reference(context, chain)
    devices = getattr(chain, "devices", ())
    offset = params["offset"]
    limit = params["limit"]
    return {
        "rack": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            rack,
        ),
        "chain": _chain_summary(
            context, rack_reference, params["chainIndex"], chain
        ),
        "devices": [
            _chain_device_summary(context, chain_reference, index, device)
            for index, device in enumerate(
                devices[offset : offset + limit], start=offset
            )
        ],
        "total": len(devices),
        "offset": offset,
        "limit": limit,
    }


def _inspect_drum_rack_pads_params(params):
    message = _validate_device_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, DRUM_PAD_PAGE_LIMIT):
        return "offset and limit must describe a bounded drum-pad page"
    return None


def inspect_drum_rack_pads(context, params):
    track, rack, _devices = _resolve_rack(context, params, drum=True)
    pads = getattr(rack, "drum_pads", ())
    rack_reference = _device_reference(context, rack)
    offset = params["offset"]
    limit = params["limit"]
    return {
        "rack": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            rack,
        ),
        "pads": [
            _drum_pad_summary(context, rack_reference, index, pad)
            for index, pad in enumerate(
                pads[offset : offset + limit], start=offset
            )
        ],
        "total": len(pads),
        "offset": offset,
        "limit": limit,
    }


def _inspect_drum_pad_chains_params(params):
    message = _validate_drum_pad_target(params, ["offset", "limit"])
    if message:
        return message
    if not _validate_page(params, CHAIN_PAGE_LIMIT):
        return "offset and limit must describe a bounded pad-chain page"
    return None


def inspect_drum_pad_chains(context, params):
    track, rack, _devices = _resolve_rack(context, params, drum=True)
    pad = _resolve_drum_pad(context, rack, params)
    chains = getattr(pad, "chains", ())
    rack_reference = _device_reference(context, rack)
    pad_reference = _pad_reference(context, pad)
    offset = params["offset"]
    limit = params["limit"]
    return {
        "rack": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            rack,
        ),
        "pad": _drum_pad_summary(
            context, rack_reference, params["padIndex"], pad
        ),
        "chains": [
            _drum_pad_chain_summary(
                context,
                rack_reference,
                pad_reference,
                params["padIndex"],
                index,
                chain,
            )
            for index, chain in enumerate(
                chains[offset : offset + limit], start=offset
            )
        ],
        "total": len(chains),
        "offset": offset,
        "limit": limit,
    }


def _inspect_drum_pad_chain_devices_params(params):
    message = _validate_drum_pad_target(
        params,
        [
            "chainIndex",
            "expectedChainReference",
            "expectedChainName",
            "offset",
            "limit",
        ],
    )
    if message:
        return message
    chain_index = params.get("chainIndex")
    if (
        isinstance(chain_index, bool)
        or not isinstance(chain_index, int)
        or chain_index < 0
    ):
        return "chainIndex must be a non-negative integer"
    message = _validate_uuid_field(params, "expectedChainReference")
    if message:
        return message
    if not isinstance(params.get("expectedChainName"), str):
        return "expectedChainName must be a string"
    if not _validate_page(params, CHAIN_DEVICE_PAGE_LIMIT):
        return "offset and limit must describe a bounded chain-device page"
    return None


def inspect_drum_pad_chain_devices(context, params):
    track, rack, _devices = _resolve_rack(context, params, drum=True)
    pad = _resolve_drum_pad(context, rack, params)
    chains = getattr(pad, "chains", ())
    chain = _resolve_chain(context, rack, chains, params)
    rack_reference = _device_reference(context, rack)
    pad_reference = _pad_reference(context, pad)
    chain_reference = _chain_reference(context, chain)
    devices = getattr(chain, "devices", ())
    offset = params["offset"]
    limit = params["limit"]
    return {
        "rack": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            rack,
        ),
        "pad": _drum_pad_summary(
            context, rack_reference, params["padIndex"], pad
        ),
        "chain": _drum_pad_chain_summary(
            context,
            rack_reference,
            pad_reference,
            params["padIndex"],
            params["chainIndex"],
            chain,
        ),
        "devices": [
            _chain_device_summary(context, chain_reference, index, device)
            for index, device in enumerate(
                devices[offset : offset + limit], start=offset
            )
        ],
        "total": len(devices),
        "offset": offset,
        "limit": limit,
    }


def _exact_keys(value, required, optional=()):
    if not isinstance(value, dict):
        return False
    keys = set(value.keys())
    required = set(required)
    return required.issubset(keys) and not keys - required - set(optional)


def _validate_track_identity(value):
    if not _exact_keys(
        value, ["index", "expectedReference", "expectedName"]
    ):
        return False
    index = value.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return False
    if _validate_uuid_field(value, "expectedReference"):
        return False
    return (
        isinstance(value.get("expectedName"), str)
        and len(value["expectedName"]) > 0
    )


def _validate_device_identity(value):
    if not _exact_keys(
        value, ["index", "expectedReference", "expectedName"]
    ):
        return False
    index = value.get("index")
    return (
        not isinstance(index, bool)
        and isinstance(index, int)
        and index >= 0
        and _validate_uuid_field(value, "expectedReference") is None
        and isinstance(value.get("expectedName"), str)
    )


def _validate_chain_identity(value):
    return _validate_device_identity(value)


def _validate_pad_identity(value):
    if not _exact_keys(
        value,
        [
            "index",
            "expectedReference",
            "expectedNote",
            "expectedName",
        ],
    ):
        return False
    index = value.get("index")
    note = value.get("expectedNote")
    return (
        not isinstance(index, bool)
        and isinstance(index, int)
        and index >= 0
        and _validate_uuid_field(value, "expectedReference") is None
        and not isinstance(note, bool)
        and isinstance(note, int)
        and 0 <= note <= 127
        and isinstance(value.get("expectedName"), str)
    )


def _validate_device_location(value):
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "track-device":
        return (
            _exact_keys(value, ["kind", "track", "device"])
            and _validate_track_identity(value.get("track"))
            and _validate_device_identity(value.get("device"))
        )
    if kind == "rack-chain-device":
        return (
            _exact_keys(value, ["kind", "track", "rack", "chain", "device"])
            and _validate_track_identity(value.get("track"))
            and _validate_device_identity(value.get("rack"))
            and _validate_chain_identity(value.get("chain"))
            and _validate_device_identity(value.get("device"))
        )
    if kind == "drum-pad-chain-device":
        return (
            _exact_keys(
                value,
                ["kind", "track", "rack", "pad", "chain", "device"],
            )
            and _validate_track_identity(value.get("track"))
            and _validate_device_identity(value.get("rack"))
            and _validate_pad_identity(value.get("pad"))
            and _validate_chain_identity(value.get("chain"))
            and _validate_device_identity(value.get("device"))
        )
    return False


def _validate_device_destination(value):
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    required = ["kind", "track", "deviceIndex"]
    if kind == "rack-chain":
        required.extend(["rack", "chain"])
    elif kind == "drum-pad-chain":
        required.extend(["rack", "pad", "chain"])
    elif kind != "track":
        return False
    index = value.get("deviceIndex")
    return (
        _exact_keys(value, required)
        and _validate_track_identity(value.get("track"))
        and (
            kind == "track"
            or (
                _validate_device_identity(value.get("rack"))
                and _validate_chain_identity(value.get("chain"))
                and (
                    kind != "drum-pad-chain"
                    or _validate_pad_identity(value.get("pad"))
                )
            )
        )
        and not isinstance(index, bool)
        and isinstance(index, int)
        and index >= 0
    )


def _validate_find_device_position_params(params):
    if not _exact_keys(params, ["source", "destination"]):
        return "source and destination are required"
    if not _validate_device_location(params.get("source")):
        return "source must be an exact supported device location"
    if not _validate_device_destination(params.get("destination")):
        return "destination must be an exact supported device parent"
    return None


def _actual_track_identity(context, track, index):
    return {
        "index": index,
        "reference": _track_reference(context, track),
        "name": getattr(track, "name", "") or "",
    }


def _actual_device_identity(context, device, index):
    return {
        "index": index,
        "reference": _device_reference(context, device),
        "name": getattr(device, "name", "") or "",
    }


def _actual_chain_identity(context, chain, index):
    return {
        "index": index,
        "reference": _chain_reference(context, chain),
        "name": getattr(chain, "name", "") or "",
    }


def _actual_pad_identity(context, pad, index):
    return {
        "index": index,
        "reference": _pad_reference(context, pad),
        "note": getattr(pad, "note", None),
        "name": getattr(pad, "name", "") or "",
    }


def _resolve_identity(collection, identity, reference, label):
    index = identity["index"]
    if index >= len(collection):
        raise ProtocolFailure("not_found", "{0} index is out of range".format(label))
    target = collection[index]
    actual_reference = reference(target)
    actual_name = getattr(target, "name", "") or ""
    if (
        actual_reference != identity["expectedReference"]
        or actual_name != identity["expectedName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "{0} identity changed before operation".format(label),
            details={
                "index": index,
                "expectedReference": identity["expectedReference"],
                "actualReference": actual_reference,
                "expectedName": identity["expectedName"],
                "actualName": actual_name,
            },
        )
    return target


def _resolve_location_track(context, identity):
    return _resolve_track(
        context,
        {
            "index": identity["index"],
            "expectedReference": identity["expectedReference"],
            "expectedName": identity["expectedName"],
        },
    )


def _resolve_location_rack(context, track, identity):
    return _resolve_identity(
        getattr(track, "devices", ()),
        identity,
        lambda value: _device_reference(context, value),
        "Rack device",
    )


def _require_rack_collection(rack, attribute, label):
    capability = (
        "can_have_drum_pads" if attribute == "drum_pads" else "can_have_chains"
    )
    if not bool(getattr(rack, capability, False)):
        raise ProtocolFailure("conflict", "Target device is not a {0}".format(label))
    collection = getattr(rack, attribute, None)
    if collection is None:
        raise ProtocolFailure(
            "unsupported_capability",
            "Live does not expose the required {0} collection".format(label),
        )
    return collection


def _resolve_chain_parent(context, target):
    track = _resolve_location_track(context, target["track"])
    rack = _resolve_location_rack(context, track, target["rack"])
    if target["kind"] in ("rack-chain", "rack-chain-device"):
        chains = _require_rack_collection(rack, "chains", "rack")
        chain = _resolve_identity(
            chains,
            target["chain"],
            lambda value: _chain_reference(context, value),
            "Chain",
        )
        return track, rack, None, chain
    pads = _require_rack_collection(rack, "drum_pads", "Drum Rack")
    pad = _resolve_identity(
        pads,
        target["pad"],
        lambda value: _pad_reference(context, value),
        "Drum pad",
    )
    if getattr(pad, "note", None) != target["pad"]["expectedNote"]:
        raise ProtocolFailure(
            "stale_reference", "Drum pad note changed before operation"
        )
    chains = getattr(pad, "chains", None)
    if chains is None:
        raise ProtocolFailure(
            "unsupported_capability",
            "Live does not expose Drum Rack pad chains",
        )
    chain = _resolve_identity(
        chains,
        target["chain"],
        lambda value: _chain_reference(context, value),
        "Drum pad chain",
    )
    return track, rack, pad, chain


def _resolve_device_location(context, target):
    track = _resolve_location_track(context, target["track"])
    if target["kind"] == "track-device":
        parent = track
        devices = getattr(track, "devices", ())
        device = _resolve_identity(
            devices,
            target["device"],
            lambda value: _device_reference(context, value),
            "Device",
        )
        return track, None, None, None, parent, devices, device
    track, rack, pad, chain = _resolve_chain_parent(context, target)
    devices = getattr(chain, "devices", ())
    device = _resolve_identity(
        devices,
        target["device"],
        lambda value: _device_reference(context, value),
        "Chain device",
    )
    return track, rack, pad, chain, chain, devices, device


def _resolve_device_destination(context, target):
    track = _resolve_location_track(context, target["track"])
    if target["kind"] == "track":
        return track, None, None, None, track, getattr(track, "devices", ())
    track, rack, pad, chain = _resolve_chain_parent(context, target)
    return track, rack, pad, chain, chain, getattr(chain, "devices", ())


def _location_summary(context, kind, track, rack, pad, chain, device, index):
    result = {
        "kind": kind,
        "track": _actual_track_identity(
            context, track, list(context.song.tracks).index(track)
        ),
        "device": _actual_device_identity(context, device, index),
    }
    if rack is not None:
        result["rack"] = _actual_device_identity(
            context, rack, list(getattr(track, "devices", ())).index(rack)
        )
    if chain is not None:
        chains = (
            getattr(pad, "chains", ())
            if pad is not None
            else getattr(rack, "chains", ())
        )
        result["chain"] = _actual_chain_identity(
            context, chain, list(chains).index(chain)
        )
    if pad is not None:
        result["pad"] = _actual_pad_identity(
            context, pad, list(getattr(rack, "drum_pads", ())).index(pad)
        )
    return result


def _destination_summary(
    context, kind, track, rack, pad, chain, device_index
):
    result = {
        "kind": kind,
        "track": _actual_track_identity(
            context, track, list(context.song.tracks).index(track)
        ),
        "deviceIndex": device_index,
    }
    if rack is not None:
        result["rack"] = _actual_device_identity(
            context, rack, list(getattr(track, "devices", ())).index(rack)
        )
    if chain is not None:
        chains = (
            getattr(pad, "chains", ())
            if pad is not None
            else getattr(rack, "chains", ())
        )
        result["chain"] = _actual_chain_identity(
            context, chain, list(chains).index(chain)
        )
    if pad is not None:
        result["pad"] = _actual_pad_identity(
            context, pad, list(getattr(rack, "drum_pads", ())).index(pad)
        )
    return result


def _same_parent_kind(source_kind, destination_kind):
    return {
        "track-device": "track",
        "rack-chain-device": "rack-chain",
        "drum-pad-chain-device": "drum-pad-chain",
    }.get(source_kind) == destination_kind


def _preflight_device_position(context, params):
    song = context.song
    finder = getattr(song, "find_device_position", None)
    if not callable(finder):
        raise ProtocolFailure(
            "unsupported_capability",
            "Live 11 Song.find_device_position is unavailable",
        )
    source = params["source"]
    destination = params["destination"]
    (
        source_track,
        source_rack,
        source_pad,
        source_chain,
        source_parent,
        source_devices,
        device,
    ) = _resolve_device_location(context, source)
    (
        destination_track,
        destination_rack,
        destination_pad,
        destination_chain,
        destination_parent,
        destination_devices,
    ) = _resolve_device_destination(context, destination)
    same_parent = _same_lom_object(source_parent, destination_parent)
    if same_parent and not _same_parent_kind(source["kind"], destination["kind"]):
        raise ProtocolFailure(
            "ambiguous_reference",
            "The same Live chain was addressed through different target kinds",
        )
    source_index = source["device"]["index"]
    requested_index = destination["deviceIndex"]
    maximum = len(destination_devices) - (1 if same_parent else 0)
    if requested_index > maximum:
        raise ProtocolFailure(
            "not_found",
            "Destination device index is out of range",
            details={"requestedIndex": requested_index, "maximumIndex": maximum},
        )
    api_target = (
        requested_index + 1
        if same_parent and source_index < requested_index
        else requested_index
    )
    try:
        found = finder(device, destination_parent, api_target)
    except Exception as exc:
        raise ProtocolFailure(
            "lom_error",
            "Live could not validate the device destination",
            details={"operationError": str(exc)},
        )
    if isinstance(found, bool) or not isinstance(found, int) or found < 0:
        raise ProtocolFailure(
            "conflict", "Live returned an invalid device position"
        )
    resolved_index = (
        found - 1 if same_parent and source_index < found else found
    )
    source_summary = _location_summary(
        context,
        source["kind"],
        source_track,
        source_rack,
        source_pad,
        source_chain,
        device,
        source_index,
    )
    destination_summary = _destination_summary(
        context,
        destination["kind"],
        destination_track,
        destination_rack,
        destination_pad,
        destination_chain,
        requested_index,
    )
    return {
        "source": source_summary,
        "destination": destination_summary,
        "requestedIndex": requested_index,
        "resolvedIndex": resolved_index,
        "apiTargetPosition": found,
        "sameParent": same_parent,
        "exact": resolved_index == requested_index,
    }, (
        device,
        source_parent,
        destination_parent,
        source_index,
        destination_track,
        destination_rack,
        destination_pad,
        destination_chain,
    )


def find_device_position(context, params):
    result, _resolved = _preflight_device_position(context, params)
    return result


def move_device(context, params):
    song = context.song
    mover = getattr(song, "move_device", None)
    if not callable(mover):
        raise ProtocolFailure(
            "unsupported_capability",
            "Live 11 Song.move_device is unavailable",
        )
    preflight, resolved = _preflight_device_position(context, params)
    if not preflight["exact"]:
        raise ProtocolFailure(
            "conflict",
            "Requested destination is not an exact valid Live device position",
            details={
                "requestedIndex": preflight["requestedIndex"],
                "resolvedIndex": preflight["resolvedIndex"],
            },
        )
    (
        device,
        source_parent,
        destination_parent,
        source_index,
        destination_track,
        destination_rack,
        destination_pad,
        destination_chain,
    ) = resolved
    try:
        returned = mover(
            device, destination_parent, preflight["apiTargetPosition"]
        )
        if isinstance(returned, bool) or not isinstance(returned, int):
            raise RuntimeError("move_device returned an invalid index")
        destination_devices = list(getattr(destination_parent, "devices", ()))
        actual_indexes = [
            index
            for index, candidate in enumerate(destination_devices)
            if _same_lom_object(candidate, device)
        ]
        if actual_indexes != [preflight["requestedIndex"]]:
            raise RuntimeError("device move verification failed")
    except Exception as exc:
        rollback_error = None
        try:
            current_parent = (
                destination_parent
                if any(
                    _same_lom_object(candidate, device)
                    for candidate in getattr(destination_parent, "devices", ())
                )
                else source_parent
            )
            rollback_position = song.find_device_position(
                device, source_parent, source_index
            )
            if not _same_lom_object(current_parent, source_parent) or list(
                getattr(source_parent, "devices", ())
            ).index(device) != source_index:
                song.move_device(device, source_parent, rollback_position)
            if list(getattr(source_parent, "devices", ())).index(device) != source_index:
                raise RuntimeError("device rollback verification failed")
        except Exception as rollback_exc:
            rollback_error = str(rollback_exc)
        raise ProtocolFailure(
            "lom_error",
            "Device move failed"
            if rollback_error is not None
            else "Device move failed; original position was restored",
            details={
                "operationError": str(exc),
                "rollbackError": rollback_error,
            },
        )
    destination_kind = params["destination"]["kind"] + "-device"
    after = _location_summary(
        context,
        destination_kind,
        destination_track,
        destination_rack,
        destination_pad,
        destination_chain,
        device,
        preflight["requestedIndex"],
    )
    return {
        "deviceReference": _device_reference(context, device),
        "before": preflight["source"],
        "after": after,
        "requestedDestinationIndex": preflight["requestedIndex"],
        "preflightIndex": preflight["resolvedIndex"],
        "moveReturnedIndex": returned,
        "sameParent": preflight["sameParent"],
        "verified": True,
    }


def _validate_chain_location_target(value):
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    required = ["kind", "track", "rack", "chain"]
    if kind == "drum-pad-chain":
        required.append("pad")
    elif kind != "rack-chain":
        return False
    return (
        _exact_keys(value, required)
        and _validate_track_identity(value.get("track"))
        and _validate_device_identity(value.get("rack"))
        and _validate_chain_identity(value.get("chain"))
        and (
            kind != "drum-pad-chain"
            or _validate_pad_identity(value.get("pad"))
        )
    )


def _validate_set_chain_properties_params(params):
    if not _exact_keys(params, ["target"], ["name", "color"]):
        return "target and at least one supported chain property are required"
    if not _validate_chain_location_target(params.get("target")):
        return "target must identify one exact existing chain"
    if "name" in params and (
        not isinstance(params["name"], str)
        or not params["name"]
        or len(params["name"]) > 128
    ):
        return "name must contain 1 to 128 characters"
    if "color" in params and (
        isinstance(params["color"], bool)
        or not isinstance(params["color"], int)
        or params["color"] < 0
        or params["color"] > 0xFFFFFF
    ):
        return "color must be an RGB integer"
    if "name" not in params and "color" not in params:
        return "At least one chain property is required"
    return None


def _chain_properties_state(chain):
    return {
        "name": getattr(chain, "name", "") or "",
        "color": getattr(chain, "color", None),
    }


def set_chain_properties(context, params):
    _track, _rack, _pad, chain = _resolve_chain_parent(
        context, params["target"]
    )
    before = _chain_properties_state(chain)
    try:
        if "name" in params:
            chain.name = params["name"]
        if "color" in params:
            chain.color = params["color"]
        after = _chain_properties_state(chain)
        if (
            ("name" in params and after["name"] != params["name"])
            or ("color" in params and after["color"] != params["color"])
        ):
            raise RuntimeError("chain property verification failed")
    except Exception as exc:
        try:
            if "name" in params:
                chain.name = before["name"]
            if "color" in params:
                chain.color = before["color"]
            restored = _chain_properties_state(chain)
            if restored != before:
                raise RuntimeError("chain property rollback verification failed")
        except Exception as rollback_exc:
            raise ProtocolFailure(
                "lom_error",
                "Chain property update and rollback failed",
                details={
                    "operationError": str(exc),
                    "rollbackError": str(rollback_exc),
                },
            )
        raise ProtocolFailure(
            "lom_error",
            "Chain property update failed; prior values were restored",
            details={"operationError": str(exc)},
        )
    return {
        "chainReference": _chain_reference(context, chain),
        "before": before,
        "after": after,
        "verified": True,
    }


def _mixer_parameter_state(context, parameter):
    minimum, maximum, value = _parameter_bounds(parameter)
    return {
        "reference": _parameter_reference(context, parameter),
        "name": getattr(parameter, "name", "") or "",
        "value": value,
        "normalizedValue": _normalized_value(minimum, maximum, value),
        "min": minimum,
        "max": maximum,
        "isEnabled": bool(getattr(parameter, "is_enabled", True)),
    }


def _chain_mixer_state(context, chain):
    mixer = getattr(chain, "mixer_device", None)
    volume = getattr(mixer, "volume", None) if mixer is not None else None
    panning = getattr(mixer, "panning", None) if mixer is not None else None
    sends = getattr(mixer, "sends", ()) if mixer is not None else ()
    return {
        "mute": bool(getattr(chain, "mute", False)),
        "solo": bool(getattr(chain, "solo", False)),
        "volume": (
            _mixer_parameter_state(context, volume)
            if volume is not None
            else None
        ),
        "pan": (
            _mixer_parameter_state(context, panning)
            if panning is not None
            else None
        ),
        "sends": [
            _mixer_parameter_state(context, parameter)
            for parameter in list(sends)[:64]
        ],
    }


def _validate_inspect_chain_mixer_params(params):
    if not _exact_keys(params, ["target"]):
        return "target is required"
    if not _validate_chain_location_target(params.get("target")):
        return "target must identify one exact existing chain"
    return None


def inspect_chain_mixer(context, params):
    _track, _rack, _pad, chain = _resolve_chain_parent(
        context, params["target"]
    )
    return {
        "chainReference": _chain_reference(context, chain),
        "mixer": _chain_mixer_state(context, chain),
    }


def _validate_parameter_change(value, send=False):
    required = [
        "expectedParameterReference",
        "expectedParameterName",
        "normalizedValue",
    ]
    if send:
        required.append("index")
    if not _exact_keys(value, required):
        return False
    normalized = value.get("normalizedValue")
    if (
        isinstance(normalized, bool)
        or not isinstance(normalized, (int, float))
        or not math.isfinite(normalized)
        or normalized < 0
        or normalized > 1
    ):
        return False
    if _validate_uuid_field(value, "expectedParameterReference"):
        return False
    if not isinstance(value.get("expectedParameterName"), str):
        return False
    if send:
        index = value.get("index")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index > 63
        ):
            return False
    return True


def _validate_set_chain_mixer_params(params):
    if not _exact_keys(
        params,
        ["target"],
        ["mute", "solo", "volume", "pan", "sends"],
    ):
        return "target and supported chain mixer properties are required"
    if not _validate_chain_location_target(params.get("target")):
        return "target must identify one exact existing chain"
    if "mute" in params and not isinstance(params["mute"], bool):
        return "mute must be a boolean"
    if "solo" in params and not isinstance(params["solo"], bool):
        return "solo must be a boolean"
    for name in ("volume", "pan"):
        if name in params and not _validate_parameter_change(params[name]):
            return "{0} must be an exact normalized parameter change".format(name)
    sends = params.get("sends", [])
    if not isinstance(sends, list) or len(sends) > 64:
        return "sends must be a bounded list"
    if any(not _validate_parameter_change(send, send=True) for send in sends):
        return "Each send must be an exact normalized parameter change"
    indexes = [send["index"] for send in sends]
    if len(indexes) != len(set(indexes)):
        return "Send indexes must be unique"
    if not any(
        name in params for name in ("mute", "solo", "volume", "pan")
    ) and not sends:
        return "At least one chain mixer property is required"
    return None


def _resolve_mixer_parameter(context, parameter, change, label):
    if parameter is None:
        raise ProtocolFailure(
            "unsupported_capability",
            "{0} is not exposed for this chain".format(label),
        )
    reference = _parameter_reference(context, parameter)
    name = getattr(parameter, "name", "") or ""
    if (
        reference != change["expectedParameterReference"]
        or name != change["expectedParameterName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "{0} identity changed before operation".format(label),
            details={
                "expectedReference": change["expectedParameterReference"],
                "actualReference": reference,
                "expectedName": change["expectedParameterName"],
                "actualName": name,
            },
        )
    _ensure_parameter_writable(parameter)
    return parameter


def set_chain_mixer(context, params):
    _track, _rack, _pad, chain = _resolve_chain_parent(
        context, params["target"]
    )
    mixer = getattr(chain, "mixer_device", None)
    changes = []
    if "volume" in params:
        changes.append(
            (
                _resolve_mixer_parameter(
                    context,
                    getattr(mixer, "volume", None) if mixer else None,
                    params["volume"],
                    "Chain volume",
                ),
                params["volume"],
            )
        )
    if "pan" in params:
        changes.append(
            (
                _resolve_mixer_parameter(
                    context,
                    getattr(mixer, "panning", None) if mixer else None,
                    params["pan"],
                    "Chain pan",
                ),
                params["pan"],
            )
        )
    sends = list(getattr(mixer, "sends", ())) if mixer is not None else []
    for send in params.get("sends", []):
        if send["index"] >= len(sends):
            raise ProtocolFailure("not_found", "Chain send index is out of range")
        changes.append(
            (
                _resolve_mixer_parameter(
                    context,
                    sends[send["index"]],
                    send,
                    "Chain send",
                ),
                send,
            )
        )
    before = _chain_mixer_state(context, chain)
    original_values = [(parameter, parameter.value) for parameter, _ in changes]
    try:
        if "mute" in params:
            chain.mute = params["mute"]
        if "solo" in params:
            chain.solo = params["solo"]
        for parameter, change in changes:
            parameter.value = _target_value(
                parameter, change["normalizedValue"]
            )
        after = _chain_mixer_state(context, chain)
        if "mute" in params and after["mute"] != params["mute"]:
            raise RuntimeError("chain mute verification failed")
        if "solo" in params and after["solo"] != params["solo"]:
            raise RuntimeError("chain solo verification failed")
        for parameter, change in changes:
            target = _target_value(parameter, change["normalizedValue"])
            _minimum, _maximum, actual = _parameter_bounds(parameter)
            if not _values_match(parameter, actual, target):
                raise RuntimeError("chain mixer verification failed")
    except Exception as exc:
        try:
            chain.mute = before["mute"]
            chain.solo = before["solo"]
            for parameter, value in original_values:
                parameter.value = value
            restored = _chain_mixer_state(context, chain)
            if restored != before:
                raise RuntimeError("chain mixer rollback verification failed")
        except Exception as rollback_exc:
            raise ProtocolFailure(
                "lom_error",
                "Chain mixer update and rollback failed",
                details={
                    "operationError": str(exc),
                    "rollbackError": str(rollback_exc),
                },
            )
        raise ProtocolFailure(
            "lom_error",
            "Chain mixer update failed; prior values were restored",
            details={"operationError": str(exc)},
        )
    return {
        "chainReference": _chain_reference(context, chain),
        "before": before,
        "after": after,
        "verified": True,
    }


def _set_device_enabled_params(params):
    message = _validate_device_target(params, ["enabled"])
    if message:
        return message
    if not isinstance(params.get("enabled"), bool):
        return "enabled must be a boolean"
    return None


def _ensure_parameter_writable(parameter):
    if not bool(getattr(parameter, "is_enabled", True)):
        raise ProtocolFailure(
            "conflict", "Parameter is disabled and cannot be changed"
        )
    if not bool(getattr(parameter, "is_writable", True)):
        raise ProtocolFailure(
            "conflict", "Parameter is not writable"
        )
    minimum, maximum, _value = _parameter_bounds(parameter)
    if maximum == minimum:
        raise ProtocolFailure(
            "conflict", "Parameter has no writable range"
        )


def _quantized_target(parameter, normalized, minimum, maximum):
    item_count = _value_item_count(parameter)
    steps = (
        item_count - 1
        if item_count > 1
        else max(1, int(round(maximum - minimum)))
    )
    if steps <= 0:
        return minimum
    step_index = int(math.floor(normalized * steps + 0.5))
    return minimum + (maximum - minimum) * step_index / steps


def _target_value(parameter, normalized):
    minimum, maximum, _value = _parameter_bounds(parameter)
    if bool(getattr(parameter, "is_quantized", False)):
        return _quantized_target(parameter, normalized, minimum, maximum)
    return minimum + (maximum - minimum) * normalized


def _values_match(parameter, left, right):
    minimum, maximum, _value = _parameter_bounds(parameter)
    tolerance = max(0.0000001, abs(maximum - minimum) * 0.000001)
    return abs(left - right) <= tolerance


def _set_parameter_value(parameter, target, before):
    try:
        parameter.value = target
        _minimum, _maximum, after = _parameter_bounds(parameter)
        if not _values_match(parameter, after, target):
            raise RuntimeError("parameter verification failed")
        return after
    except Exception as exc:
        current = before
        try:
            _minimum, _maximum, current = _parameter_bounds(parameter)
            if not _values_match(parameter, current, before):
                parameter.value = before
                _minimum, _maximum, restored = _parameter_bounds(parameter)
                if not _values_match(parameter, restored, before):
                    raise RuntimeError("parameter rollback verification failed")
        except Exception as rollback_exc:
            raise ProtocolFailure(
                "lom_error",
                "Parameter update and rollback failed",
                details={
                    "operationError": str(exc),
                    "rollbackError": str(rollback_exc),
                },
            )
        if _values_match(parameter, current, before):
            raise ProtocolFailure(
                "conflict",
                "Parameter rejected the value and may not be writable",
                details={"operationError": str(exc)},
            )
        raise ProtocolFailure(
            "lom_error",
            "Parameter update failed; prior value was restored",
            details={"operationError": str(exc)},
        )


def set_device_enabled(context, params):
    track, device, _devices = _resolve_device(context, params)
    parameter = _device_on_parameter(device)
    if parameter is None:
        raise ProtocolFailure(
            "unsupported_capability",
            "Device does not expose a documented Device On parameter",
        )
    _ensure_parameter_writable(parameter)
    _minimum, _maximum, before_value = _parameter_bounds(parameter)
    before_enabled = _device_enabled(device)
    target = _target_value(parameter, 1.0 if params["enabled"] else 0.0)
    _set_parameter_value(parameter, target, before_value)
    after_enabled = _device_enabled(device)
    if after_enabled is not params["enabled"]:
        try:
            parameter.value = before_value
            _minimum, _maximum, restored_value = _parameter_bounds(parameter)
            if not _values_match(parameter, restored_value, before_value):
                raise RuntimeError("device enable rollback verification failed")
            if _device_enabled(device) is not before_enabled:
                raise RuntimeError("device enable state was not restored")
        except Exception as rollback_exc:
            raise ProtocolFailure(
                "lom_error",
                "Device enable update verification and rollback failed",
                details={"rollbackError": str(rollback_exc)},
            )
        raise ProtocolFailure(
            "lom_error",
            "Device enable update failed; prior value was restored",
        )
    return {
        "device": _device_summary(
            context,
            _track_reference(context, track),
            params["index"],
            params["deviceIndex"],
            device,
        ),
        "beforeEnabled": before_enabled,
        "afterEnabled": after_enabled,
        "verified": True,
    }


def _set_device_parameter_params(params):
    message = _validate_device_target(
        params,
        [
            "parameterIndex",
            "expectedParameterReference",
            "expectedParameterName",
            "normalizedValue",
        ],
    )
    if message:
        return message
    index = params.get("parameterIndex")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        return "parameterIndex must be a non-negative integer"
    try:
        uuid.UUID(params.get("expectedParameterReference"))
    except (AttributeError, TypeError, ValueError):
        return "expectedParameterReference must be a UUID"
    if not isinstance(params.get("expectedParameterName"), str):
        return "expectedParameterName must be a string"
    normalized = params.get("normalizedValue")
    if not _is_finite_number(normalized) or normalized < 0 or normalized > 1:
        return "normalizedValue must be between 0 and 1"
    return None


def _resolve_parameter(context, device, params):
    parameters = getattr(device, "parameters", ())
    index = params["parameterIndex"]
    if index >= len(parameters):
        raise ProtocolFailure("not_found", "Parameter index is out of range")
    parameter = parameters[index]
    reference = _parameter_reference(context, parameter)
    name = getattr(parameter, "name", "") or ""
    if (
        reference != params["expectedParameterReference"]
        or name != params["expectedParameterName"]
    ):
        raise ProtocolFailure(
            "stale_reference",
            "Parameter identity changed before mutation",
            details={
                "parameterIndex": index,
                "expectedReference": params["expectedParameterReference"],
                "actualReference": reference,
                "expectedName": params["expectedParameterName"],
                "actualName": name,
            },
        )
    return parameter, parameters


def set_device_parameter(context, params):
    track, device, _devices = _resolve_device(context, params)
    parameter, _parameters = _resolve_parameter(context, device, params)
    _ensure_parameter_writable(parameter)
    track_reference = _track_reference(context, track)
    device_reference = _device_reference(context, device)
    before = _parameter_summary(
        context,
        device_reference,
        params["parameterIndex"],
        parameter,
    )
    target = _target_value(parameter, params["normalizedValue"])
    _set_parameter_value(parameter, target, before["value"])
    after = _parameter_summary(
        context,
        device_reference,
        params["parameterIndex"],
        parameter,
    )
    return {
        "device": _device_summary(
            context,
            track_reference,
            params["index"],
            params["deviceIndex"],
            device,
        ),
        "before": before,
        "after": after,
        "requestedNormalizedValue": params["normalizedValue"],
        "verified": True,
    }


def register_device_commands(registry):
    registry.register(
        "devices.inspect",
        inspect_devices,
        capability="devices.inspect",
        validator=_inspect_devices_params,
    )
    registry.register(
        "devices.inspect_parameters",
        inspect_device_parameters,
        capability="devices.inspect_parameters",
        validator=_inspect_device_parameters_params,
        timeout_class="long",
    )
    registry.register(
        "devices.inspect_rack_chains",
        inspect_rack_chains,
        capability="devices.inspect_rack_chains",
        validator=_inspect_rack_chains_params,
    )
    registry.register(
        "devices.inspect_rack_chain_devices",
        inspect_rack_chain_devices,
        capability="devices.inspect_rack_chain_devices",
        validator=_inspect_rack_chain_devices_params,
    )
    registry.register(
        "devices.inspect_drum_rack_pads",
        inspect_drum_rack_pads,
        capability="devices.inspect_drum_rack_pads",
        validator=_inspect_drum_rack_pads_params,
    )
    registry.register(
        "devices.inspect_drum_pad_chains",
        inspect_drum_pad_chains,
        capability="devices.inspect_drum_pad_chains",
        validator=_inspect_drum_pad_chains_params,
    )
    registry.register(
        "devices.inspect_drum_pad_chain_devices",
        inspect_drum_pad_chain_devices,
        capability="devices.inspect_drum_pad_chain_devices",
        validator=_inspect_drum_pad_chain_devices_params,
    )
    registry.register(
        "devices.inspect_chain_mixer",
        inspect_chain_mixer,
        capability="devices.inspect_chain_mixer",
        validator=_validate_inspect_chain_mixer_params,
    )
    registry.register(
        "devices.find_position",
        find_device_position,
        capability="devices.find_position",
        validator=_validate_find_device_position_params,
    )
    registry.register(
        "devices.move",
        move_device,
        mutates=True,
        capability="devices.move",
        validator=_validate_find_device_position_params,
    )
    registry.register(
        "devices.set_chain_properties",
        set_chain_properties,
        mutates=True,
        capability="devices.set_chain_properties",
        validator=_validate_set_chain_properties_params,
    )
    registry.register(
        "devices.set_chain_mixer",
        set_chain_mixer,
        mutates=True,
        capability="devices.set_chain_mixer",
        validator=_validate_set_chain_mixer_params,
    )
    registry.register(
        "devices.set_enabled",
        set_device_enabled,
        mutates=True,
        capability="devices.set_enabled",
        validator=_set_device_enabled_params,
    )
    registry.register(
        "devices.set_parameter",
        set_device_parameter,
        mutates=True,
        capability="devices.set_parameter",
        validator=_set_device_parameter_params,
    )
