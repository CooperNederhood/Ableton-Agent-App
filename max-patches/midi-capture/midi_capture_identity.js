autowatch = 1;
inlets = 1;
outlets = 1;

var MAX_RETRIES = 20;
var RETRY_DELAY_MS = 250;
var generation = 0;
var retryTask = null;

function cleanValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Array) {
    return value.join(" ");
  }
  return String(value);
}

function numericId(api) {
  var value = Number(api && api.id);
  return isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function apiName(api) {
  try {
    return cleanValue(api.get("name"));
  } catch (error) {
    return "";
  }
}

function apiPath(api) {
  try {
    return cleanValue(api.unquotedpath || api.path);
  } catch (error) {
    return "";
  }
}

function apiType(api) {
  try {
    return cleanValue(api.type);
  } catch (error) {
    return "";
  }
}

function trackIndex(path) {
  var match = String(path).match(/(?:^| )tracks (\d+)(?: |$)/);
  return match ? Number(match[1]) : null;
}

function makeApi(path) {
  try {
    return new LiveAPI(path);
  } catch (firstError) {
    try {
      return new LiveAPI(function () {}, path);
    } catch (secondError) {
      post(
        "[midi_capture_identity] LiveAPI " +
          path +
          ": " +
          String(
            secondError && secondError.message ? secondError.message : secondError
          ) +
          "\n"
      );
      return null;
    }
  }
}

function findTrack() {
  var path = "live_set this_device canonical_parent";
  for (var depth = 0; depth < 16; depth += 1) {
    var api = makeApi(path);
    if (!numericId(api)) {
      return null;
    }
    if (apiType(api) === "Track") {
      return api;
    }
    path += " canonical_parent";
  }
  return null;
}

function buildIdentity() {
  var deviceApi = makeApi("live_set this_device");
  var deviceId = numericId(deviceApi);
  var canonicalPath = apiPath(deviceApi);
  var deviceName = apiName(deviceApi);
  if (!deviceId || !canonicalPath || !deviceName) {
    return null;
  }

  var trackApi = findTrack();
  if (!trackApi) {
    return null;
  }
  var trackId = numericId(trackApi);
  var trackPath = apiPath(trackApi);
  var trackName = apiName(trackApi);
  if (!trackId || !trackPath || !trackName) {
    return null;
  }

  var track = {
    id: trackId,
    name: trackName
  };
  var index = trackIndex(trackPath);
  if (index !== null) {
    track.index = index;
  }

  return {
    canonicalPath: canonicalPath,
    track: track,
    device: {
      id: deviceId,
      name: deviceName
    }
  };
}

function cancelRetry() {
  if (retryTask) {
    retryTask.cancel();
    retryTask = null;
  }
}

function attempt(requestGeneration, retryCount) {
  if (requestGeneration !== generation) {
    return;
  }

  var identity = buildIdentity();
  if (identity) {
    retryTask = null;
    outlet(0, "identity", JSON.stringify(identity));
    return;
  }

  if (retryCount >= MAX_RETRIES) {
    retryTask = null;
    post(
      "[midi_capture_identity] LiveAPI identity unavailable after " +
        MAX_RETRIES +
        " retries\n"
    );
    return;
  }

  retryTask = new Task(attempt, this, requestGeneration, retryCount + 1);
  retryTask.schedule(RETRY_DELAY_MS);
}

function bang() {
  try {
    generation += 1;
    cancelRetry();
    attempt(generation, 0);
  } catch (error) {
    post(
      "[midi_capture_identity] " +
        String(error && error.message ? error.message : error) +
        "\n"
    );
  }
}

function notifydeleted() {
  generation += 1;
  cancelRetry();
}
