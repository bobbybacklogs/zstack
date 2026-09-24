# Playbook: Runtime Forensics

> **Trigger:** Debugging active daemon crashes, hung processes, socket exhaustion, or live server state.

Inspect running processes directly using OS-level and runtime diagnostic tools.

---

## Step 1: Identify Process State
- Check process liveness, PID, port bindings, and memory usage:
  - Windows: `Get-NetTCPConnection -LocalPort <port>`, `Get-Process -Id <pid>`
  - Linux/macOS: `lsof -i :<port>`, `ps aux | grep <process>`
- Check daemon logs (e.g. `~/.modelhitch/bridge.log`).

## Step 2: Probe Health Endpoints
- Issue direct HTTP probes to live health or status endpoints:
  - Example: `curl http://127.0.0.1:3939/healthz` or `curl http://127.0.0.1:3939/v1/models`
- Capture status code, response latency, and headers.

## Step 3: Isolate Socket, Lock, or Resource Leaks
- If connections hang, check for unclosed streams, missing timeout handlers, or deadlocks in concurrency queues (`principles/separate-before-serializing-shared-state.md`).
- Verify that graceful shutdown and retry logic are idempotent (`principles/make-operations-idempotent.md`).
