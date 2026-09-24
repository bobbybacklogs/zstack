# Type System Discipline

> **Apply when:** Designing types, interfaces, data contracts, or function signatures.

Make illegal states unrepresentable. Leverage types to enforce domain correctness at compile time.

## Core Rules

1. **Unrepresentable illegal states.** Replace boolean flags with tagged unions. For example, instead of `{ isLoading: boolean, data?: Data, error?: Error }`, model `{ status: 'idle' } | { status: 'loading' } | { status: 'success', data: Data } | { status: 'error', error: Error }`.
2. **Brand primitive values.** Disambiguate raw strings and numbers. An `AccountId` should not be assignable to a `UserId`. Use branded types (`type UserId = string & { readonly __brand: unique symbol }`).
3. **No loose types.** Ban `any`, unstructured `object`, or loose type assertions (`as unknown as Target`). If a type cast is required, wrap it in a narrow, well-tested type guard function.
