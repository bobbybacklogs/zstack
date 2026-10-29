# Optional private web-agent client

Obtain `cass-mh-kit-0.2.0.tgz` from your private MH Kit release/plugin and place it in this directory before installing dependencies. The archive is intentionally untracked in this public repository.

Core zStack works without the archive. For web research, run `npm install --save-prod --package-lock=false ./vendor/cass-mh-kit-0.2.0.tgz` after copying the archive, and configure this installation’s private `MH_AGENT_API_KEY` and optional `MH_AGENT_URL`. Missing client/configuration produces an explicit research-unavailable error rather than falling back to another model or provider.

The client is declared as an optional peer dependency: normal public installs do not contact a private registry or download the private archive.

This command adds the private package to the deployment-local manifest. Keep that local dependency change and the archive out of public commits. Using `--no-save` can cause npm to omit an optional peer even when supplied explicitly.
