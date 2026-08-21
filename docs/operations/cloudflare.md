# Cloudflare handoff

Cloudflare names, account data, routes, domains, and credentials are
project-owned. A standalone migration records the existing Worker and active
deployment, validates the new repository and build, disables the old Git build
connection before enabling the new one, verifies a preview, and only then moves
production. Keep the previous version as a rollback point.

For Workers Static Assets, pin `compatibility_date`, keep preview URLs enabled
when appropriate, use an explicit build command and root directory, and verify
the production response, error route, security headers, canonical URL, robots
policy, sitemap, assets, and absence of unintended runtime origins.
