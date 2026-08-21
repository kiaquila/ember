# Baseline releases

1. Change managed files and regression tests in a focused pull request.
2. Run `npm run preflight`.
3. Choose the SemVer version and run
   `npm run manifest:web-design -- --version <version> --update-lock true`.
4. Commit the manifest with the managed changes and re-run preflight.
5. After that commit exists, tag its immutable full SHA and publish release notes
   that describe compatibility and required project decisions. The SHA is not
   embedded in its own commit; consumers record the requested archive SHA in
   their lock after validating the manifest and every file.

Patch releases fix compatible policy or documentation. Minor releases add
backward-compatible capabilities or profiles. Major releases change schema,
required check names, mandatory files, or sync semantics and require a deliberate
migration pull request in every consumer.
