---
'@ever-works/contracts': minor
---

Local AI completions on fleet nodes: a new fleet job kind `ai-completion` (ONE model request a node relays to a healthy local AI provider), in every lockstep table (`FLEET_JOB_KINDS`, `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC`). New module `fleet-ai-completion.types.ts`: the wire-API vocabulary (`openai-chat`, `openai-responses`, `anthropic-messages`), the payload and result shapes with their normalisers and bounds (gzip+base64 bodies, decoded and encoded caps, timeouts), request-body validation (`stream` forced off), usage reading, the failure vocabulary, the local-AI lane tables, and the model-tag helpers (`fleetLocalModelTagSlug`, the one normalisation the node's `local-model:` tags use). New tag `FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY` (`local-ai-completions`) in the local-AI family. Additive.
