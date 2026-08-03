# Tested Platforms

This file records manual compatibility checks for the current Pocket Vault beta.
It is evidence of observed behavior, not a permanent guarantee for future
Telegram or operating-system releases.

Last manual verification: **2026-08-04**.

The exact Telegram build numbers and OS versions were not recorded during the
initial test pass. The table therefore says `current client (build not
recorded)` instead of inventing version numbers. Future passes should record
the exact values before changing this document.

## Core flow matrix

| Platform | Telegram client | DeviceStorage | SecureStorage | Create | Unlock | CRUD | Lock | Destroy | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| iOS | Current client; build not recorded | Yes | Not required | Pass | Pass | Pass | Pass | Pass | Manually verified |
| Windows | Telegram Desktop; build not recorded | Yes | Not required | Pass | Pass | Pass | Pass | Pass | Manually verified |
| Android | Not recorded | Unknown | Not required | Not tested | Not tested | Not tested | Not tested | Not tested | Pending |
| macOS | Not recorded | Unknown | Not required | Not tested | Not tested | Not tested | Not tested | Not tested | Pending |
| Linux | Not recorded | Unknown | Not required | Not tested | Not tested | Not tested | Not tested | Not tested | Pending |

`SecureStorage` is not part of the current authentication design on any
platform. The master passphrase is not persisted for quick unlock, so a client
may be supported with `DeviceStorage` alone.

## Manual checks covered on iOS and Windows

- application launch through Telegram;
- vault creation and restart persistence;
- unlock with the correct passphrase and rejection of an incorrect one;
- create, read, update, and delete entry flows;
- secret reveal and clipboard copy;
- manual lock and subsequent passphrase requirement;
- inactivity timeout behavior;
- Russian and English interface selection;
- light and dark themes;
- passwordless vault destruction.

Automated tests additionally exercise storage callback failures, readback
verification, partial-save cancellation, active-pointer repair behavior,
session expiration, clock rollback, password rotation, and destruction. Those
tests do not replace real-client testing.

## Required data for the next verification pass

For each platform, record:

- device model or desktop architecture;
- operating-system version;
- Telegram application name and exact version/build;
- Pocket Vault commit or release;
- cold-start and WebView-resume behavior;
- KDF duration during create, unlock, and password change;
- theme, language, focus, keyboard, clipboard, and lifecycle behavior;
- persistence after Telegram and device restart;
- behavior after a Telegram client update;
- any platform-specific limitations.
