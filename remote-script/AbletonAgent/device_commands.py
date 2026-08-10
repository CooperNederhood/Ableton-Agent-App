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
    reachable = [
        candidate
        for track in context.song.tracks
        for candidate in getattr(track, "devices", ())
    ]
    return _runtime_reference(
        context, "_device_references", device, reachable
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
    reachable = [
        candidate
        for chain in _reachable_chains(context)
        for candidate in getattr(chain, "devices", ())
    ]
    return _runtime_reference(
        context, "_chain_device_references", device, reachable
    )


def _parameter_reference(context, parameter):
    reachable = [
        candidate
        for track in context.song.tracks
        for device in getattr(track, "devices", ())
        for candidate in getattr(device, "parameters", ())
    ]
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
