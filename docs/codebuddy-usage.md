# CodeBuddy credit usage

ADE reads credits for the native **international personal account** signed in to CodeBuddy. It does not sum conversation charges to estimate a subscription balance.

The [official usage page](https://www.codebuddy.ai/profile/plans-usage) ships its account-bound credit summary through `POST /billing/meter/get-user-resource-summary`. The public user-center build `5b1a5c66f165def64e193518deb6a4eb04e5c385` uses cookies in a browser and a Bearer token in its embedded authenticated client. Its response `data.CreditGroups` records named pools with `CycleTotalCapacity`, `CycleUsedCapacity` and `CycleRemainCapacity`. ADE shows nonempty pools separately, including the observed used/total credit amounts. No reset time is present in that summary; ADE leaves it unknown.

CodeBuddy Code 2.173.0 stores the native account in `CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info` beneath Windows Local AppData, macOS Application Support, or Linux `~/.local/share`. ADE bounds this read to 64 KiB, honors the native logout marker, requires an unexpired Bearer token for `www.codebuddy.ai` and a personal account, then sends it only to the fixed HTTPS summary endpoint with the native user ID header. It revalidates that credential after the response. Credentials remain backend-only. Requests have a ten-second timeout, a 128 KiB response limit and no redirects; usage shares ADE's in-flight request and quota cache.

Enterprise, mainland, API-key and protected credential formats remain unavailable rather than borrowing another account or exporting/decrypting credentials. The official page remains available for those accounts. The CLI supports protected credential fields, although this host's installed account uses its plaintext native format.

Verification on 2026-10-23: a read-only request with the existing native personal sign-in returned HTTP 200, `code: 0`, and the documented credit-group fields. No agent conversation or test suite was run.
