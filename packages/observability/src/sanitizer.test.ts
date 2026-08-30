import { describe, expect, it } from "vitest";

import {
  AUDIO_OMITTED_VALUE,
  BINARY_OMITTED_VALUE,
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  sanitizeTelemetryAttributes,
  sanitizedAttributesSchema,
} from "./index.js";

describe("telemetry sanitizer", () => {
  it("redacts credentials and bearer tokens while preserving detailed content", () => {
    const input: Record<string, unknown> = {
      prompt: "Create a MIDI clip at /Users/cooper/Sets/demo.als",
      assistantContent: "I will use the clip tool.",
      toolDefinition: {
        name: "replace_midi_notes",
        description: "Replace the notes in a MIDI clip",
      },
      toolArguments: {
        trackPath: "/tracks/Lead",
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100 }],
      },
      toolResult: {
        changedNotes: 1,
        clipName: "Lead phrase",
      },
      abletonEventPayload: {
        kind: "midi.note_changed",
        note: { pitch: 64, velocity: 92 },
      },
      authorization: "Bearer raw-authorization-token",
      nested: {
        apiKey: "raw-api-key",
        password: "raw-password",
      },
      statusText: "Request used Bearer inline-token-value successfully",
      binaryAttachment: new Uint8Array([1, 2, 3, 4]),
      audioBody: "UklGRgAAAABXQVZFZm10",
      audioResponse: {
        mimeType: "audio/wav",
        body: "UklGRgAAAABXQVZFZm10",
        sampleRate: 48_000,
      },
    };
    input.self = input;

    const sanitized = sanitizeTelemetryAttributes(input);

    expect(sanitized).toMatchObject({
      prompt: input.prompt,
      assistantContent: input.assistantContent,
      toolDefinition: input.toolDefinition,
      toolArguments: input.toolArguments,
      toolResult: input.toolResult,
      abletonEventPayload: input.abletonEventPayload,
      authorization: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        password: REDACTED_VALUE,
      },
      statusText: "Request used Bearer [REDACTED] successfully",
      binaryAttachment: {
        type: "binary",
        byteLength: 4,
        value: BINARY_OMITTED_VALUE,
      },
      audioBody: AUDIO_OMITTED_VALUE,
      audioResponse: {
        mimeType: "audio/wav",
        body: AUDIO_OMITTED_VALUE,
        sampleRate: 48_000,
      },
      self: CIRCULAR_VALUE,
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("raw-authorization-token");
    expect(serialized).not.toContain("raw-api-key");
    expect(serialized).not.toContain("raw-password");
    expect(serialized).not.toContain("inline-token-value");
    expect(sanitizedAttributesSchema.parse(sanitized)).toEqual(sanitized);
  });

  it("redacts embedded credentials from every free-text form", () => {
    const secrets = {
      bearer: "bearer-secret-value",
      basic: "dXNlcjpwYXNzd29yZA==",
      digest: "digest-secret-value",
      assignment: "assigned-secret-value",
      url: "url-password",
      privateKey: "private-key-material",
      provider: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    };
    const providerTokens = [
      ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwxyz"].join("-"),
      "AKIA1234567890ABCDEF",
      "sk_live_1234567890abcdefghijkl",
      "sk-proj-1234567890abcdefghijklmnop",
    ];
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      secrets.privateKey,
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const sanitized = sanitizeTelemetryAttributes({
      bearer: `Authorization: Bearer ${secrets.bearer}`,
      basic: `Basic ${secrets.basic}`,
      digest: `Digest username="agent", nonce="${secrets.digest}", realm="Live"`,
      assignments: [
        `token=${secrets.assignment}`,
        `api-key: '${secrets.assignment}'`,
        `password="${secrets.assignment}"`,
        `passphrase="line one\n${secrets.assignment}"`,
        `client_secret = ${secrets.assignment}`,
      ].join("\n"),
      url: `https://agent:${secrets.url}@localhost:4711/session?clip=Lead`,
      privateKey,
      providerTokens: providerTokens.join(" "),
      provider: `GitHub token ${secrets.provider}`,
      [`result password=${secrets.assignment}`]: "safe value",
    });
    const serialized = JSON.stringify(sanitized);

    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    for (const token of providerTokens) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized).toContain(REDACTED_VALUE);
    expect(sanitized.url).toBe(
      "https://[REDACTED]@localhost:4711/session?clip=Lead",
    );
    expect(sanitized.privateKey).toBe(REDACTED_VALUE);
    expect(Object.keys(sanitized)).toContain("result password=[REDACTED]");
  });

  it("redacts provider-prefixed credential keys and assignments", () => {
    const secrets = {
      ableton: "ableton-prefixed-secret",
      openai: "openai-prefixed-secret",
      aws: "aws-prefixed-secret",
      authorization: "authorization-prefixed-secret",
      cookie: "cookie-prefixed-secret",
      credential: "credential-prefixed-secret",
      privateKey: "private-key-prefixed-secret",
    };
    const ordinary = {
      tokenBudget: 8_192,
      passwordPolicy: "Require 12 characters",
      cookieName: "session-preference",
      credentialType: "oauth",
      privateKeyPath: "/Users/cooper/.config/example.pem",
      apiKeyName: "OpenAI development key",
      secretRotationEnabled: true,
    };
    const sanitized = sanitizeTelemetryAttributes({
      ...ordinary,
      ABLETON_AGENT_TOKEN: secrets.ableton,
      OPENAI_API_KEY: secrets.openai,
      AWS_SECRET_ACCESS_KEY: secrets.aws,
      requestAuthorizationHeader: secrets.authorization,
      browserCookieValue: secrets.cookie,
      serviceCredentialJson: secrets.credential,
      tlsPrivateKeyPem: secrets.privateKey,
      text: [
        `ABLETON_AGENT_TOKEN=${secrets.ableton}`,
        `"OPENAI_API_KEY": "${secrets.openai}"`,
        `AWS_SECRET_ACCESS_KEY='${secrets.aws}'`,
        "token_budget=8192",
        "password_policy=strict",
      ].join("\n"),
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      ...ordinary,
      ABLETON_AGENT_TOKEN: REDACTED_VALUE,
      OPENAI_API_KEY: REDACTED_VALUE,
      AWS_SECRET_ACCESS_KEY: REDACTED_VALUE,
      requestAuthorizationHeader: REDACTED_VALUE,
      browserCookieValue: REDACTED_VALUE,
      serviceCredentialJson: REDACTED_VALUE,
      tlsPrivateKeyPem: REDACTED_VALUE,
    });
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(sanitized.text).toContain("ABLETON_AGENT_TOKEN=[REDACTED]");
    expect(sanitized.text).toContain('"OPENAI_API_KEY": "[REDACTED]"');
    expect(sanitized.text).toContain("AWS_SECRET_ACCESS_KEY='[REDACTED]'");
    expect(sanitized.text).toContain("token_budget=8192");
    expect(sanitized.text).toContain("password_policy=strict");
  });

  it("preserves detailed ordinary strings and structured musical payloads", () => {
    const detailed = {
      prompt:
        "Create a syncopated MIDI clip, keep the ghost notes, then save /Users/cooper/Sets/Funk.als",
      assistantContent:
        "I replaced four notes and retained the requested velocity accents.",
      toolDefinition: {
        name: "replace_midi_notes",
        description: "Replace note events without changing the clip loop.",
      },
      toolArguments: {
        clip: "Verse Lead",
        notes: [
          { pitch: 60, start: 0, duration: 0.5, velocity: 83 },
          { pitch: 64, start: 0.75, duration: 0.25, velocity: 61 },
        ],
      },
      toolResult: { changedNotes: 2, preservedLoop: true },
      eventPayload: {
        kind: "midi.note_changed",
        path: "/live_set/tracks/0/clip_slots/2/clip",
      },
    };

    expect(sanitizeTelemetryAttributes(detailed)).toEqual(detailed);
  });

  it("uses visible markers at configurable depth, collection, and string limits", () => {
    const sanitized = sanitizeTelemetryAttributes(
      {
        prompt: "p".repeat(100),
        nested: { deeper: { deepest: true } },
        notes: [1, 2, 3, 4, 5],
        extra: true,
      },
      {
        maxDepth: 2,
        maxStringCharacters: 40,
        maxArrayItems: 3,
        maxObjectFields: 4,
      },
    );

    expect(sanitized.prompt).toContain("[truncated");
    expect(sanitized.nested).toEqual({
      deeper: { truncated: true, reason: "max_depth", limit: 2 },
    });
    expect(sanitized.notes).toEqual([
      1,
      2,
      { truncated: true, reason: "max_array_items", omittedItems: 3 },
    ]);
    expect(sanitizedAttributesSchema.safeParse(sanitized).success).toBe(true);
  });
});
