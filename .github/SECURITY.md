# Security Policy

## Supported versions

Only the latest release published on npm (`pi-firecode`) receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include the affected version, a description of the impact, and steps to reproduce.

## Scope

FireCode runs inside your Pi session with your user's permissions and sends requests through the models and credentials you configure.

Worker and reviewer sessions have an unsandboxed `bash`; that is a trusted capability by design, because they need to run tests. The guard on Worker `edit`/`write` (current checkout and the system temp directory only) and the read-only tool list for reviewers prevent accidents. They are not a sandbox, so "a Worker or reviewer can run an arbitrary command" is not a vulnerability. Isolation needs a container or a read-only mount.

In scope: flaws in the extension's own code, for example credential leakage, commands run without a model or user having asked for them, or a guard that fails to stop an accidental write it is meant to stop. Vulnerabilities in Pi itself or in model providers belong to those projects.
