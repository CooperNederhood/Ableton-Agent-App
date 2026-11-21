# Failure triage

Find the layer that went wrong, then reproduce it in the fastest test that can
show it.

| Layer                | What you see                                                | First step                                                     |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Agent planning       | Wrong, missing, or out-of-order tool calls in the trace     | Check the system prompt and tool descriptions                  |
| Approval             | Call denied, or "could not request permission"              | Check the approval and preflight path for the real reason      |
| Tool                 | Tool returned an error                                      | Call the same application or bridge method directly            |
| Bridge / protocol    | Validation error, timeout, or framing error                 | Send the bridge command directly and read the structured error |
| Remote Script / Live | `lom_error`, stale object, or Live did something unexpected | Reproduce in Live 11, fix the Python, add a fake-LOM test      |
| Max device           | Listener error or capture never completes                   | Check the device's progress events and Max console             |
| Assertion            | Agent and tools succeeded but the check failed              | Read Live state directly; the check may be wrong               |
| Timeout              | Turn or bridge deadline hit                                 | Check whether the work actually happened before retrying       |
| Setup / cleanup      | Fixture, process, or cleanup failure                        | Fix the setup; this says nothing about the product             |
