---
name: ship-change
description: Close out finished vapid.party work with verification, git hygiene, commit, push, and a clean final status. Use when a discrete code, docs, memory, or skill change is complete; when the user asks to land work; or before reporting that repo work is done.
---

# Ship Change

## Overview

Finish work in the repo's expected shape: verified, committed, pushed, and reported with any blocked checks called out.

## Workflow

1. Check current state:

```bash
git status --short --branch
```

2. Review the diff:

```bash
git diff --check
git diff --stat
git diff
```

3. Run checks relevant to the touched files:

```bash
npm run lint
npm run build
```

Run `npm test` when tests exist, changed behavior warrants it, or the user asked for it.

4. If skills changed, validate each changed skill:

```bash
python3 /home/pierce/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/<name>
```

5. Stage only intended files.
6. Commit with a concise message.
7. Push to `origin main` unless the repo is on a different active branch or the user requested another flow.
8. Re-run `git status --short --branch` and report the clean or blocked state.

## Guardrails

- Do not stage unrelated user changes.
- Do not hide failed checks; report the exact command and failure class.
- Do not commit secrets or local environment files.
- If push needs network approval, request it and continue once approved.
