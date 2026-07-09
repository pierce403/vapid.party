---
name: curator
description: Maintain vapid.party's repo-local memory and skill structure. Use when Codex learns a durable workflow, repeated pitfall, validation pattern, project convention, or collaborator preference; when adding, revising, consolidating, or pruning MEMORY.md, memory/, SKILLS.md, or skills/; or when adapting recurse.bot-style operating guidance for this repo.
---

# Curator

## Overview

Keep the repo's agent guidance small, accurate, and discoverable. Turn repeated work into concise notes or reusable skills, then validate the result before landing it.

## Workflow

1. Read `AGENTS.md`, `MEMORY.md`, and `SKILLS.md`.
2. Decide where the learning belongs:
   - `AGENTS.md`: repo-wide rule or sharp edge every agent must see.
   - `MEMORY.md`: index entry for durable notes or logs.
   - `memory/notes/`: reusable project knowledge.
   - `memory/logs/`: dated record of completed work and lessons.
   - `SKILLS.md` and `skills/<name>/SKILL.md`: repeated procedure.
3. Keep entries concise and remove stale or duplicate guidance.
4. Do not record secrets, private keys, bearer tokens, API keys, or raw customer data.
5. Validate changed skills with:

```bash
python3 /home/pierce/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/<name>
```

## When Adding A Skill

- Add a skill only when the workflow is likely to repeat.
- Use lowercase hyphen-case for the folder and `name`.
- Put trigger conditions in the frontmatter `description`.
- Keep the body procedural; omit background that a capable coding agent already knows.
- Update `SKILLS.md` in the same change.

## When Updating Memory

- Search before adding:

```bash
rg -n "keyword|topic" MEMORY.md memory
```

- Prefer editing an existing note when the new information refines it.
- Add a dated log for completed structure/workflow passes that future agents may need to understand.
