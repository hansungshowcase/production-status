# Codex Project Instructions

Scope: this file applies only to the `hansungshowcase/production-status` project.

- Modify only this project unless the user explicitly names another target.
- For any code modification request, default to using parallel sub-agents immediately for implementation, review, or verification; only skip them when the change is truly trivial, cannot be safely parallelized, or the user explicitly asks not to.
- If a code change is too small or too tightly coupled to split safely, still involve a watcher/reviewer sub-agent before finalizing and note why implementation stayed local.
- Before committing substantial code or UI changes, ask a watcher/reviewer sub-agent to validate the plan or patch direction, then address any concrete risks before deployment.
- Keep production UI text inside its containers on mobile and desktop. Do not ship layouts where labels or buttons overflow their cells.
- When changes are meant for Vercel production, build, commit, push to `main`, and verify that the deployed bundle reflects the change.
