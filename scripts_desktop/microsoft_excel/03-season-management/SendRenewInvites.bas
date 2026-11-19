' VBA stub for Excel — Send renewal invites via BTS automation API.
' Populate with HTTP + JWT helper routines before use.
'
' Suggested steps:
' 1. Reference "Microsoft Scripting Runtime" and "Microsoft XML, v6.0" (or WinHTTP).
' 2. Implement HMAC-SHA256 to mint JWTs using AUTOMATION_JWT_SECRET.
' 3. Collect invitation rows from the active worksheet (similar headers: email, renewUrl…).
' 4. POST to {BTS_BASE_URL}/api/automation/scripts/season.send-renew-invites/jobs
'    with JSON body matching the inline "invitees" format.
' 5. Surface the job id/status through message boxes or a dedicated BTS ribbon tab.
'
' This folder mirrors admin “Operate” scripts — keep one module per task so
' the Excel experience stays aligned with updates to 02/03/04 tooling.

