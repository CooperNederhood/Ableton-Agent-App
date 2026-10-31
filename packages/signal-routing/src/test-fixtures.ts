import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  LocalObservabilityJournal,
  createNonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";

export async function createIngressJournalFixture(
  cleanup: Array<() => void | Promise<void>>,
) {
  const parent = resolve(".test-artifacts");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "ingress-journal-"));
  cleanup.push(() => rm(root, { recursive: true, force: false }));
  const journal = await LocalObservabilityJournal.open({
    path: join(root, "journal.sqlite"),
  });
  cleanup.push(() => journal.shutdown());
  const failures: unknown[] = [];
  const recorder = createNonBlockingObservabilityRecorder(journal, {
    onFailure: (failure) => failures.push(failure),
  });
  return { journal, recorder, failures };
}

export const midiSample = {
  schema: "midi-sample/v1" as const,
  sample_index: 0,
  complete: true,
  end_reason: "boundary",
  start_tick: 0,
  end_tick: 1920,
  ppq: 480,
  start_beat: 0,
  end_beat: 4,
  length_beats: 4,
  tempo_bpm_at_start: 120,
  time_signature_at_start: [4, 4] as [number, number],
  notes: [
    {
      channel: 1,
      pitch: 60,
      name: "C4",
      velocity: 100,
      onset_beats: 0,
      duration_beats: 1,
      continued_from_previous: false,
      continues_into_next: false,
    },
  ],
};
