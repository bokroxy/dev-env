---
name: clef
description: "Clef decision model: typed judgment (blocker|verdict|error|finding|claim|raw) from a JSON task; output is one JSON judgment"
runner:
  type: external-cli
  command: clef
  args: [agent]
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
---

Command-runner agent. The `clef agent` command ignores this text: it reads the task as JSON
`{"kind": "blocker|verdict|error|finding|claim", "input": {...}, "options": {"model": "clef|flash", "threshold": 0.9}}`
(or `{"kind": "raw", "state": {...}, "questions": {...}}`) and prints one JSON judgment
(`label`, `p`, `confident`, `action`, `ok`). A judgment routes work; it never approves it. Run `clef help agent` for details.
