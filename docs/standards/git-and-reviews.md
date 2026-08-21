# Git and reviews

Use a focused branch and pull request. Required checks must be green for the
current head; resolve review threads and do not rely on stale approval after a
material change. Never weaken the trusted default-branch guard and consume that
weaker proposed copy in the same pull request.

Baseline updates are normal pull requests. Their diff must show the upstream
version and full source SHA, every managed file change, lock changes, and any
conflict that required a local decision. Merges and deployment remain human
decisions.
