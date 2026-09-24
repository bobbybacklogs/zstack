# Separate Before Serializing Shared State

> **Apply when:** Multiple concurrent agents, background jobs, or threads access shared files, databases, or memory structures.

Eliminate shared state by partitioning ownership before attempting to coordinate through locks or queues.

## Core Rules

1. **Partition ownership.** If two processes or subagents need to write data, divide the workspace or namespace so each actor has exclusive ownership of its partition.
2. **Shared state is a design smell.** Locks, mutexes, and distributed transactions are difficult to debug and prone to deadlocks. Isolate state and communicate across clean boundaries via messages or events instead.
3. **Immutable data flows.** Favor passing immutable snapshots between processing stages rather than mutating shared in-memory objects.
