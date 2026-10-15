/* global URL */

// Historical source identity only, not current-source native qualification.
export const ARCHIVED_NATIVE_ASSEMBLER = Object.freeze({
  sourceCommit: "0a0159882589333640144769e502ecc135803279",
  sourcePath: "max-patches/audio-listener/audio_listener_native_assembler.js",
  sha256: "987b4b76e36b6494badcfc2a52af0929fcca4329fa2e28ca245caa9a2de0487c",
  bytes: 8750,
  fixtureURL: new URL("./fixtures/native-assembler-0a01598.js", import.meta.url)
    .href,
});

export const ARCHIVED_NATIVE_V1_SOURCES = Object.freeze({
  sourceCommit: "6cceef606aa3d557853db3795303006f22f6acbc",
  sha256: Object.freeze({
    "audio_listener_engine.js":
      "5fe39f29af1d1af2f469335e4afadf437603dcb3386e0b1397d94eac2c732767",
    "audio_listener_native_controller.js":
      "5c00dede0ccc55aaabd49d5da2e4442e272bb56f0e3191b5ae14b7ddf19309ba",
    "audio_listener_native_coordinates.js":
      "640c93faa774b4c9b11b88c3bdaa7e36cbe4d078e2ce261917928912798f6225",
    "audio_listener_native_io.js":
      "a7bbbd64d0409b2d062cfc586b2761b61cbe37a1e07f575f822a1543375e0667",
    "audio_listener_runtime.js":
      "dcb953aca5191e0f3decde836aced22475d7ee6c0f44605b0c05151479315ae2",
    "audio_listener_guard.js":
      "868508005df7c71d673a6da1da50341897970f8c1823a955a8932e237c400a81",
  }),
});

export function historicalNativeSourceURL(name) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error("invalid_historical_source_name");
  if (name === "audio_listener_native_assembler.js")
    return new URL(ARCHIVED_NATIVE_ASSEMBLER.fixtureURL);
  return new URL(
    Object.prototype.hasOwnProperty.call(
      ARCHIVED_NATIVE_V1_SOURCES.sha256,
      name,
    )
      ? `./fixtures/native-v1-6cceef6/${name}`
      : `./${name}`,
    import.meta.url,
  );
}
