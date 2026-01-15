# Tasks

- [ ] Fetch existing PR review comments and issue comments; inject into prompt with guidance to avoid repeats and respond when relevant.
- [ ] Track “since last review” changes (store last reviewed commit SHA, compare with current head, review only new files/changes).
- [ ] Deduplicate warnings by hashing issue text + file/line.
- [ ] Threaded follow-ups: if a comment already exists on a line, reply instead of posting a new one.
- [ ] Consider diff since previous bot review and adjust recommendations; resolve/close prior bot comments when fixed with an explanation.
