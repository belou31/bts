-- AppleScript stub for Numbers — Export tariff catalog via BTS automation API.
-- Populate with HTTP + JWT helper routines before use.
--
-- Suggested steps:
-- 1. Save this file as ~/Library/Scripts/Applications/Numbers/ExportTariffs.scpt
--    (open in Script Editor, File > Save As..., File Format: Script).
-- 2. Implement HMAC-SHA256 to mint JWTs using AUTOMATION_JWT_SECRET, e.g. via
--    `do shell script "openssl dgst -sha256 -hmac " & quoted form of secret & " ..."`.
-- 3. POST to {BTS_BASE_URL}/api/automation/scripts/tariff.export-catalog/jobs
--    (runMode=sync) via `do shell script "curl -s -X POST ..."`.
-- 4. Parse the JSON response's job.result.payload.entries and write them into
--    the frontmost Numbers document's active sheet/table (tell application "Numbers").
-- 5. Surface the outcome via `display dialog`.
--
-- This folder mirrors admin "Operate" scripts — keep one script per task so
-- the Numbers experience stays aligned with updates to 02/03/04 tooling.

on run
	display dialog "TODO: Implement BTS tariff export automation for Numbers." buttons {"OK"} default button "OK"
end run
