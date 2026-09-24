# Playbook: Trace Forensics

> **Trigger:** Investigating distributed request traces, latency spikes across network boundaries, or downstream timeouts.

Follow execution spans across network boundaries to pinpoint latency spikes and serialization costs.

---

## Step 1: Extract Span Timings
- Inspect trace headers, OpenTelemetry spans, or bridge log timestamps.
- Identify the exact segment where latency inflated (e.g. DNS lookup, TLS handshake, queue wait time, model TTFT).

## Step 2: Correlate Client and Upstream Events
- Match the client request ID with the corresponding upstream provider call in ModelHitch or reverse proxy logs.
- Identify whether delay originated in the local transport layer or within the upstream provider's generation pipeline.

## Step 3: Eliminate Serialization and Streaming Overhead
- Inspect payload sizes. Check for uncompressed transfer or unnecessary chunk buffering.
- Verify that Server-Sent Events (SSE) stream tokens immediately without artificial batching buffers.
