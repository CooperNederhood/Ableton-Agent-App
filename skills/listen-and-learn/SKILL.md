---
name: listen-and-learn
description: Ear-training quiz on one track. A hidden quiz agent writes a MIDI clip, you transcribe it by listening, then check the real notes and propose memory about what you got wrong.
argument-hint: "[track] [topic, e.g. 'syncopated hi-hats']"
---

# Listen and learn

Use this to get better at hearing specific instruments, such as Live's stock
Drum Rack kits. The **quiz** sub-agent writes a MIDI clip you cannot see. You
listen to it, write down the pattern, and only then read the real notes. When
you were wrong, you turn the mistake into a memory proposal so you hear it
correctly next time.

The quiz agent's replies are hidden from you by design; the app only tells you
that it finished.

**The whole point is that you do NOT peek at the MIDI.** The quiz measures
what you can hear, so the order below is the rule, not a suggestion:

1. Listen to the clip.
2. Write the pattern you heard as an ASCII grid in the sandbox, and show it
   in chat.
3. **Only then** read the real notes.
4. Check whether your hearing was right.

Until your answer is saved (step 5), never call `ableton_midi_notes`, never
search Set History for the clip, and ignore any note count a Session or clip
inspect shows. If you read or saw the notes early, stop: tell the user this
quiz is void, and start a new one on a fresh slot.

## 1. Prepare

1. Find the track the user named. It must be a MIDI track with an instrument
   and an Audio listener device (`ableton_listening` action
   `inspect-listeners`). If there is no listener on it, stop and ask the user
   to add one.
2. Note the instrument. For a Drum Rack, list its pads
   (`devices.inspect_drum_rack_pads`) so you can name each lane.
3. Read any memory topic about listening to this instrument or kit and apply
   it during this quiz.
4. Pick the first empty Session slot on the track.

## 2. Ask for a quiz

Call `task` with `agent_type: "quiz"` and `mode: "sync"`. In the prompt give
the topic (the user's, or one you choose to probe a known weak spot), and the
track's name, index, and reference and the exact scene index of the empty
slot. Do not suggest a pattern.

## 3. Confirm the clip exists

Inspect the Session to confirm that slot now holds a MIDI clip named "Quiz".
Use only its location, length, and loop. Do not read, mention, or reason from
its note count or anything else about its notes. If it is missing, report that
the quiz agent failed and stop.

## 4. Listen

Play the clip with `ableton_listening` action `play-session-and-listen`, then
read the measurements with `ableton_context`. You must read them; the listen
result alone is not an answer. Listen again, or look at other features, until
you have a confident answer or no new evidence. Everything you conclude here
must come from audio.

## 5. Write your answer down before you check

Your next step is writing, not checking. **Do not call `ableton_midi_notes`
yet.**

Write your transcription as an ASCII grid with one row per drum pad (or per
pitch) and one column per 16th note, one block per bar. Save it in the
sandbox with `bash`, for example `cat > listen-answer.txt <<'EOF' … EOF` in
the scratch directory, then show the same grid in chat. If bash cannot write
files in this session, the chat copy is your saved answer.

```text
          1 . . . 2 . . . 3 . . . 4 . . .
Kick      x . . . . . . . x . . x . . . .
Snare     . . . . x . . . . . . . x . . .
Hi-hat    x . x . x . x . x . x . x . x .
```

Mark accents with `X`, and give your confidence for each row and the audio
evidence behind it. Once it is saved, do not change it.

## 6. Check against the real notes

Only after step 5 is saved, read the clip's notes with `ableton_midi_notes`
action `query`. Map drum notes to pad names. Read `listen-answer.txt` back,
show the real grid under it in the same format, and score your answer as it
was written: correct hits, missed notes, extra notes, wrong pads or pitches,
and timing errors.

## 7. Learn

If everything matched, say so and skip to the last step. Otherwise reflect on
each mistake:

- What did you hear, and what was really there?
- Which measurement misled you, and which one would have told them apart?
- What will you do differently next time with this instrument?

Then load the `update-memory` skill and propose what you learned. Write
lessons that help future quizzes and real sessions, not a log of this quiz,
for example: "On {kit}, {pad A} and {pad B} both read as {evidence};
{feature} tells them apart." Use System scope for Live's stock instruments and
kits, and Project scope for the user's own sounds. Merge into an existing
listening topic for the instrument when there is one.

Finally, ask the user whether to keep or delete the Quiz clip.
