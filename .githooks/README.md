# Git hooks

Enable them once per clone:

```sh
git config core.hooksPath .githooks
```

Git will not do this for you. Hooks live outside the repo by default, and a
repository cannot switch them on by itself — a clone that ran arbitrary code
from the code it just downloaded would be a security hole. So every new clone
needs the line above, or `pre-commit` simply never runs.

## `pre-commit`

Refreshes the "Updated" dates on `master/index.html` from git history and
re-sorts the cards newest-first, then stages the result into the commit being
made. See `scripts/update-master-dates.py`.

A page with staged changes is dated *now* rather than by its last commit — the
hook runs before its own commit exists, so otherwise every date would lag one
commit behind the change it describes.

If `master/index.html` has unstaged edits and its dates are stale, the hook
refuses to stage it and stops the commit: running `git add` on a file you are
part-way through editing would sweep work into a commit you did not intend it
for. Fix it by hand:

```sh
scripts/update-master-dates.py && git add master/index.html
```

To bypass the hook for one commit, use `git commit --no-verify`.
