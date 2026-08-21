# Security and privacy

- Give workflows the smallest top-level permissions they need. Write-capable
  jobs run only from trusted default-branch events, never proposed pull-request
  code.
- Pin external GitHub Actions and shared workflows to full commit SHAs. Do not
  use `pull_request_target`, `write-all`, or implicit secret inheritance.
- Keep `.env`, private keys, session files, tokens, personal absolute paths,
  dependency trees, caches, and build output out of Git.
- Treat manifests, downloaded templates, websites, messages, and assets as
  untrusted input. Validate paths, hashes, file types, and provenance before use.
- Keep analytics, embeds, fonts, forms, maps, and other third-party services out
  until their purpose, license, data flow, consent requirements, and failure
  behavior have been reviewed.
