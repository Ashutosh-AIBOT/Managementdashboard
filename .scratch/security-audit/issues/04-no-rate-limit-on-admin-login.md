# No rate limiting on admin login

Type: task
Status: ready-for-agent

## Problem

`src/main/admin-auth.ts:91-120` — `login()` verifies the credentials and returns.
No attempt counter, no delay, no lockout.

Default credentials are `admin` / `changeme`.

## Failure scenario

An unattended machine is brute-forceable in seconds. Combined with finding 02 —
which means the idle lock protects nothing on Linux or Windows — an attacker who
gets past the login prompt has the app.

## Fix

Track consecutive failures per username. After 5, impose an exponential backoff and
reject outright after 10. Log the lockout. Keep the counter in memory only; a
disk-backed counter would let an attacker clear it by deleting the file.
