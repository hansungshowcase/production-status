# Codex Project Instructions

Scope: this file applies only to the `hansungshowcase/production-status` project.

- Modify only this project unless the user explicitly names another target.
- For code implementation work, use parallel sub-agents when the task can be safely split or reviewed in parallel.
- Before committing substantial code or UI changes, ask a watcher/reviewer sub-agent to validate the plan or patch direction, then address any concrete risks before deployment.
- Keep production UI text inside its containers on mobile and desktop. Do not ship layouts where labels or buttons overflow their cells.
- When changes are meant for Vercel production, build, commit, push to `main`, and verify that the deployed bundle reflects the change.
