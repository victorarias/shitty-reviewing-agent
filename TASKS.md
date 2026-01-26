# Tasks

- [x] Fetch existing PR review comments and issue comments; inject into prompt with guidance to avoid repeats and respond when relevant.
- [x] Track “since last review” changes (store last reviewed commit SHA, compare with current head, review only new files/changes).
- [x] Avoid repeats via context/tools (no hard dedupe); require explicit thread choice when ambiguity exists.
- [x] Threaded follow-ups: if a comment already exists on a line, reply instead of posting a new one.
- [x] Consider diff since previous bot review and adjust recommendations; resolve/close prior bot comments when fixed with an explanation.
