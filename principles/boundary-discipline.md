# Boundary Discipline

> **Apply when:** Wiring external API inputs, HTTP request handlers, CLI arguments, or database integrations.

Enforce strict validation at the perimeter; trust internal types; keep domain logic free of framework glue.

## Core Rules

1. **Parse, don't validate.** When untrusted data enters the application (HTTP request body, environment variable, IPC message), parse it through a schema validator (Zod, TypeBox, Pydantic) to construct a validated domain type immediately.
2. **Pure domain core.** Business logic, algorithms, and domain models should have zero dependencies on web frameworks (Express, Fastify), database drivers, or CLI libraries.
3. **Fail fast at the gate.** Reject malformed requests immediately with actionable, structured errors before they pollute internal services.
