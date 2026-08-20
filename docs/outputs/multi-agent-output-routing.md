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

Canonical agent `inputChannels` seed new instances. Session edits then belong to
the active instance snapshot and do not rewrite canonical YAML.

## Delivery

The signal router creates an independent assignment inbox for every
subscription. One incoming producer frame fans out to each enabled assignment.
Acknowledgement, latest-window state, automatic-turn deduplication, and delivery
mode remain isolated per subscription.

Subscribed agents receive observations even when another agent is selected in
the workspace. Missing or disconnected producers do not delete subscriptions;
routing resumes when the same stable producer ID reconnects.

## Runtime consumers

SignalRuntime tracks a set of active agent consumers rather than one active SDK
session. Next-prompt context is queried by active-agent instance ID. Automatic
turns are dispatched through the multi-agent manager using the subscription's
consumer ID.

## Desktop experience

Each Output row or card contains one checkbox per active agent. Checking creates
or enables that subscription; unchecking disables or removes only that
agent/output relationship. Detailed delivery controls are scoped to the chosen
subscription.

The same subscriptions appear in active-agent editing and persist with the
production session.
