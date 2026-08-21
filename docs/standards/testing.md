# Testing

Every project exposes its real validation commands through
`.web-design/project.json`. A check must exercise the implementation; placeholder
commands that always pass are not acceptable for a developed product.

Before merge, run repository policy, managed-file drift checks, project tests,
and production build. For visual products also record manual checks at the
smallest and largest supported viewports, keyboard focus and navigation,
reduced-motion behavior, console/network errors, and the critical conversion or
interaction path. Test deployable output rather than relying only on source-file
inspection.
