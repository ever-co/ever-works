---
'@ever-works/contracts': minor
---

Local AI on fleet nodes: `FleetAgentTaskModelResult` gains an optional `costBasis` (`'cli' | 'local'`; absent means the CLI's own estimate, `'local'` means the run's model was served by a local AI provider on the node and its `costUsd` of `0` is free by construction), with `isFleetLocalModelResult`. New capability-tag constants for the local-AI family (`FLEET_LOCAL_AI_CAPABILITY`, `FLEET_LOCAL_AI_KIND_CAPABILITY_PREFIX`, `FLEET_LOCAL_MODEL_CAPABILITY_PREFIX`, `FLEET_LOCAL_AGENT_CAPABILITY_PREFIX`) with `fleetLocalAgentCapability` and `isFleetLocalAiCapability`. Additive: existing results and callers are unchanged.
