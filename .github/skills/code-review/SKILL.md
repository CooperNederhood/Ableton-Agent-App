---
name: code-review
description: Call before you make a PR to enforce good coding practices.
---

Check the following:

- **CHECK FOR CODE SPRAWL.** Make sure you are extending existing code rather than just rolling a fresh solution. If you are adding new functionality, audit what is already in the codebase and see if you can actually just generalize and extend something that already exists.
- **CHECK FOR OBJECT BASED, MODULAR, EXTENDABLE CODE.** Are you using good object-oriented coding practices and building code that can be extended upon and updated easily tomorrow?
- **CHECK FOR MEANINGFUL TEST COVERAGE.** Have you added _meaningful_ unit tests that actually guarantee behavior? Or are the tests mostly trivial validations?
- **CHECK THAT HUMAN-FACING ./docs/ FOLDER IS UP TO DATE.** The `./docs` folder is so a human, who has little context on this repo and is trying to learn the core constructs and architectural patterns, can have a place to understand the codebase. Is this up to date? Dont make it bloated tho. Make sure high level and key structures are documented with ELI5 simplicity. Favor structured text, tables, and formatting to ease mental load on the human developer.
- **CHECK FOR SPECULATIVE GUARDS.** Does the change add checks, rejections, or retries for failures nobody has actually observed? Runtime rejections should only protect the user's project (wrong target, unintended recording or edits, data loss, failed cleanup); anything else should be logged, not enforced. Remove guards and tests that exist only for hypothetical failures.
- **CHECK THAT DOCS ARE A GUIDE, NOT A LEDGER.** `./docs` must not gain run receipts, test counts, failure histories, or to-do lists. Those belong in the PR, issues, or git history.
