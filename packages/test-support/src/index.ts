import { HeadlessApplication } from "@ableton-agent/application";
import { InMemoryEventPublisher, noopLogger } from "@ableton-agent/shared";

import {
  FakeAbletonService,
  type FakeAbletonState,
} from "./fake-ableton-service.js";
import {
  FakeAgentService,
  type FakeAgentBehavior,
} from "./fake-agent-service.js";

export {
  FakeClock,
  FakeIdGenerator,
  LogCapture,
  type CapturedLog,
} from "./deterministic.js";

export {
  FakeAbletonService,
  UnsupportedByFakeError,
  defaultFakeState,
  type FakeAbletonState,
  type FakeDevice,
} from "./fake-ableton-service.js";
export {
  FakeAgentService,
  type FakeAgentBehavior,
} from "./fake-agent-service.js";

export interface FakeApplication {
  application: HeadlessApplication;
  agent: FakeAgentService;
  ableton: FakeAbletonService;
  events: InMemoryEventPublisher;
}

/**
 * Builds the shared headless application on fake services so both the CLI and
 * the desktop adapter can be exercised against identical behavior.
 */
export function createFakeApplication(
  options: {
    ableton?: FakeAbletonState;
    agent?: FakeAgentBehavior;
  } = {},
): FakeApplication {
  const events = new InMemoryEventPublisher();
  const ableton = options.ableton
    ? new FakeAbletonService(options.ableton)
    : new FakeAbletonService();
  const agent = new FakeAgentService(events, options.agent ?? {});
  const application = new HeadlessApplication({
    agent,
    ableton,
    events,
    logger: noopLogger,
  });
  return { application, agent, ableton, events };
}
