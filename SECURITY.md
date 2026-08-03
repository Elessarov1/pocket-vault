# Security Policy

Pocket Vault is a security-oriented beta project. Public source code improves
transparency, but it does not mean that the project has received an independent
security audit.

## Supported versions

| Version | Security support |
| --- | --- |
| Current deployed beta and current `master` | Yes |
| Older deployments, commits, and third-party forks | No |

Until stable releases exist, security fixes are applied only to the current
codebase. Users should update their Telegram client and use the latest deployed
Pocket Vault version.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Elessarov1/pocket-vault/security/advisories/new)
whenever it is available. Do not disclose an unpatched vulnerability in a
public issue or discussion.

If private reporting is unavailable, open a minimal issue asking the maintainer
to establish a private channel. Do not include exploit details or user data in
that issue.

Include only the information needed to reproduce and assess the problem:

- the affected Pocket Vault revision or deployment;
- the Telegram client, operating system, and their versions;
- a description of the impact and required attacker capabilities;
- reproducible steps using synthetic data;
- a proof of concept, if it can be shared safely;
- any suggested remediation or disclosure constraints.

Never send a real master passphrase, vault export, ciphertext copied from a
user, authentication token, Telegram session data, or another real secret.
Create a disposable test vault with synthetic values instead.

## What counts as a security issue

Examples include:

- recovery of plaintext or cryptographic keys without the master passphrase;
- persistence or transmission of the master passphrase contrary to the
  documented design;
- cryptographic nonce reuse, broken authentication, or incorrect key handling;
- bypass of the lock lifecycle that exposes an existing unlocked session;
- injection or supply-chain behavior that can read vault data;
- unintended network transmission of vault contents;
- deletion, overwrite, or rollback behavior that violates the documented
  persistence guarantees;
- a vulnerability in Pocket Vault that exposes Telegram or device data outside
  the vault's intended scope.

## Out of scope

The following are generally outside Pocket Vault's security boundary unless a
Pocket Vault defect materially enables them:

- a compromised operating system, Telegram client, WebView, browser, or device;
- keyloggers, screen capture, shoulder surfing, or clipboard readers already
  running with the user's privileges;
- phishing bots, unofficial deployments, modified builds, and third-party
  forks;
- weak, reused, or disclosed master passphrases;
- denial of service, local storage eviction, device loss, and the absence of a
  backup or export feature;
- vulnerabilities in Telegram, GitHub Pages, or another platform component
  that are not caused by Pocket Vault;
- reports that require publishing or sharing real user secrets.

The complete boundary and assumptions are documented in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Response and disclosure

The maintainer will try to acknowledge a report, assess its impact, prepare a
fix, and coordinate disclosure as time permits. This project does not promise a
specific response or remediation SLA and does not currently operate a bug
bounty program.

Public credit may be offered after a fix is available, subject to the
reporter's preference and responsible disclosure. Reports that expose user
data, publish an unpatched issue without coordination, or rely on destructive
testing may not be acknowledged.
