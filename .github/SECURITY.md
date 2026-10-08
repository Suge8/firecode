# Security Policy

## Supported versions

Only the latest release published on npm (`pi-firecode`) receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include the affected version, a description of the impact, and steps to reproduce.

## Scope

FireCode runs inside your Pi session with your user's permissions and sends requests through the models and credentials you configure. Reports about the extension's own code are in scope, for example credential leakage, unintended command execution, or Worker sandbox escapes. Vulnerabilities in Pi itself or in model providers belong to those projects.
