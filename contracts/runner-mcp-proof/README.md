# Runner MCP proof contract

`v1/contract.json` is the shared contract for the signed run-bound proof used by the Registry MCP test Worker. Runner API, the GHA gateway, and this MCP host validate against the same versioned file in CI.

Published versions are immutable. A breaking change adds `v2/contract.json`; it does not edit `v1/contract.json`. Consumer CI checks out this repository's `main` branch and reads the explicitly versioned fixture path.

The accepted run IDs are the two formats emitted by the VM Runner and sandbox Runner API. A valid signature must still bind the proof to the exact run ID and task ID from the request headers. Matching the format alone never authorizes a call.

The MCP host test signs ephemeral proofs with an in-memory Ed25519 key. No private test key or reusable signed proof is stored in this repository.
