# Multi-Agent Output Routing

## Subscription model

Outputs are stable MIDI or audio producers. Active agents subscribe
independently, so one producer may feed any number of agents and each agent may
listen to any number of producers.

A subscription is keyed by active-agent instance and producer. It stores:

- stable producer ID;
- enabled state;
- next-prompt, automatic-analysis, or automatic-action delivery;
- usage instruction;
- processing-policy IDs.

Canonical agent `inputChannels` seed new instances. Each entry is a stable
producer ID; it does not contain display, track, device, or signal metadata.
Session edits then belong to the active instance snapshot and do not rewrite
canonical YAML.

## Delivery

The signal router creates an independent assignment inbox for every
subscription. One incoming producer frame fans out to each enabled assignment.
Acknowledgement, latest-window state, automatic-turn deduplication, and delivery
mode remain isolated per subscription.

Subscribed agents receive observations even when another agent is selected in
the workspace. Missing or disconnected producers do not delete subscriptions;
routing resumes when the same stable producer ID reconnects. Disconnected
connection records are not part of the current output inventory.

## Runtime consumers

SignalRuntime tracks a set of active agent consumers rather than one active SDK
session. Next-prompt context is queried by active-agent instance ID. Automatic
turns are dispatched through the multi-agent manager using the subscription's
consumer ID.

## Desktop experience

Each live Output row or card contains one checkbox per active agent. Checking
creates or enables that subscription; unchecking disables or removes only that
agent/output relationship. Detailed delivery controls are scoped to the chosen
subscription.

Subscriptions whose producer is absent appear separately as unmatched
subscriptions for active agents. They do not count as discovered outputs and do
not appear as synthetic Unknown/ungrouped output cards. Users can remove an
unmatched subscription or leave it in place for stable-ID reconnection.

The Outputs view refreshes from the signal service when opened and also provides
an explicit refresh action. Project snapshot refresh remains independent: it
updates Live track and device metadata used for grouping, but signal ingress
determines which producers are currently connected.

The same subscriptions appear in active-agent editing and persist with the
production session.
