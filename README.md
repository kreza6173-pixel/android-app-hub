# Privacy Audit — a Shevery ADB Module

A local, offline privacy dashboard for Android. It scans installed apps for sensitive
background permissions and lets you revoke them with one tap — no root required on
most devices, with extra tools unlocked automatically when Shizuku is running as root.

Built for [Shevery](https://github.com/HmnDev-Tech/shevery)'s ADB Modules system.

## What it does

- **Scans** every installed app (or just third-party apps, your choice) for:
  Camera, Microphone, Location (including background location), and Storage /
  all-files access.
- **Scores** your device with a "Privacy Index" — a single percentage that reflects
  how much sensitive access is currently granted across your apps.
- **Flags** apps that are effectively idle (Android's app-standby bucket) but still
  hold sensitive grants — the permissions most likely to have been forgotten about.
- **Revokes or restores** any flagged permission with one tap, with a confirmation
  step whenever the action touches a system app.
- **On rooted devices**, adds a Root Tools tab to freeze or force-stop idle apps —
  gated behind an explicit confirmation, never automatic.
- Runs entirely **offline**, as a local WebUI with no network calls.

## Requirements

- [Shevery](https://github.com/HmnDev-Tech/shevery) with Shizuku started, either from
  ADB or from root.
- Module access mode set to **Full**, or **Custom** with "WebUI Shell Bridge" enabled
  (required for the dashboard to talk to your device — see the module's Attention
  section in Shevery's docs).

## Install

1. Download `privacy-audit.zip` from this page's release assets.
2. In Shevery, open **ADB Modules** → install the ZIP.
3. Enable the module and set its access mode to **Full** (or Custom + WebUI Shell
   Bridge).
4. Open the module's WebUI to run your first scan, or tap the module card's
   **Action** button for a quick text summary.

## How permissions are changed

Nothing happens automatically. Every toggle is a manual, one-tap action, and the
module never touches a fixed list of protected system packages (`android`,
`com.android.systemui`, `com.android.settings`, Google Play services, and a few
others) regardless of mode. Ordinary runtime permissions are changed with
`pm revoke` / `pm grant`; all-files access is changed through `cmd appops` since it's
a special access grant rather than a normal runtime permission. Every command the
module runs is visible in the built-in console drawer at the bottom of the screen —
nothing happens off-screen.

## Known limitation

App labels and icons come from Android's resource system, which isn't reachable from
a shell script — so the dashboard lists package IDs (e.g. `com.example.app`) rather
than the app's display name. Everything else (permission state, standby bucket,
revoke/grant) is read straight from `dumpsys` / `pm` / `appops` / `am`, live, every
scan.

## Safety notes

- Revoking a permission an app depends on can break a feature of that app until you
  grant it back — the dashboard makes that reversible in one tap, but it can't know
  which features you actually use.
- Freeze and Force-stop (root-only) act immediately. Use them on apps you don't
  recognize or don't use — not as a general-purpose app manager.
- This module reads and changes permission grants only. It does not collect,
  transmit, or store any data outside your device.

## License

MIT — see [LICENSE](LICENSE).

---

## خلاصه فارسی

یک ماژول ADB برای Shevery که اپ‌های نصب‌شده رو برای دسترسی‌های حساس (دوربین،
میکروفون، لوکیشن، حافظه) اسکن می‌کنه و با یک لمس، هر دسترسی رو لغو یا بازمی‌گردونه.
روی ADB بدون روت کار می‌کنه؛ روی گوشی روت‌شده ابزارهای اضافه (فریز/Force-stop برای
اپ‌های غیرفعال) هم فعال می‌شن. کاملاً آفلاین و بدون هیچ ارتباط شبکه‌ای اجرا می‌شه؛ هیچ
اقدامی بدون تایید دستی شما انجام نمی‌گیرد.
