# Codex Project Instructions

Scope: this file applies only to the `hansungshowcase/production-status` project.

- Modify only this project unless the user explicitly names another target.
- For any code modification request, default to using parallel sub-agents immediately for implementation, review, or verification; only skip them when the change is truly trivial, cannot be safely parallelized, or the user explicitly asks not to.
- If a code change is too small or too tightly coupled to split safely, still involve a watcher/reviewer sub-agent before finalizing and note why implementation stayed local.
- Before committing substantial code or UI changes, ask a watcher/reviewer sub-agent to validate the plan or patch direction, then address any concrete risks before deployment.
- If a problem is not being resolved after reasonable attempts, do not keep reasoning alone. Convene available teammates/sub-agents to review the situation, compare assumptions, and diversify into approaches that have not yet been tried.
- For difficult, ambiguous, high-risk, or broad-impact work, convene available teammates/sub-agents before implementation, compare options, decide on a final approach, and then execute the selected fix. Do not proceed from a single-agent guess when team review is available.
- When a team review produces a likely answer, do not report it immediately as a conclusion. Apply the fix or complete the work first, verify the outcome, and then provide the final report.
- Do not touch code that is already working correctly. Existing working behavior is part of the system contract.
- Modify code only when there is a clear reason to believe the result will be better than the current state.
- Fix only the code directly responsible for the observed problem. Keep edits narrow, targeted, and proportional to the issue.
- Avoid broad rewrites, cosmetic churn, dependency changes, formatting churn, or unrelated refactors unless they are required to solve the specific problem.
- Before editing, identify the exact failure, affected files, and expected improvement. If that cannot be stated clearly, investigate more before changing code.
- After editing, verify that the targeted problem is fixed and that previously working behavior was not disturbed.
- Keep production UI text inside its containers on mobile and desktop. Do not ship layouts where labels or buttons overflow their cells.
- When changes are meant for Vercel production, build, commit, push to `main`, and verify that the deployed bundle reflects the change.
