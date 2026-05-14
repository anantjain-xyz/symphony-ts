---
name: screenshot
description: Capture Playwright screenshots of a user-facing change and embed them in the GitHub PR description via a temporary commit + follow-up revert. Use whenever the workflow asks for proof-of-testing screenshots on a user-facing change.
---

# Screenshot

The PR description is the home for proof-of-testing screenshots. They are hosted as raw GHE blobs at a commit SHA whose contents are removed by a follow-up revert commit — the blob keeps serving until the branch is deleted (typically after squash-merge).

## Preconditions

- Playwright MCP available (`mcp__plugin_playwright_playwright__browser_navigate`, `..._take_screenshot`).
- A PR exists for the current branch (use `symphony-push` first if not).
- `gh auth status` succeeds against the repo's host.
- **For coinbase-www dev captures**: `$UNIFIED_SESSION_MANAGER_COOKIE` is set in the environment. If unset and the target URL is a coinbase-www dev URL (`localhost:3000` or `coinbase-dev.cbhq.net`), stop and write a blocker brief in the workpad per `WORKFLOW.md`'s escape hatch — do **not** capture the auth wall.

## Steps

0. **Bring up dev (coinbase-www only).** Skip this step entirely for non-coinbase-www repos.

   a. **Detect dev server.** Check whether `https://localhost:3000` is responding:
      ```sh
      curl -ks -o /dev/null -w '%{http_code}' https://localhost:3000 || echo "down"
      ```
      If the response is `down` or non-2xx/3xx, start it in the background:
      ```sh
      yarn nx run app:start --env=dev > /tmp/symphony-dev-server.log 2>&1 &
      ```
      Poll the curl above (max 90s, 3s interval) until it returns 2xx/3xx. If it never comes up, tail `/tmp/symphony-dev-server.log` for the error and surface it.

   b. **Verify the cookie env var.** Fail fast if missing:
      ```sh
      [ -n "$UNIFIED_SESSION_MANAGER_COOKIE" ] || { echo "UNIFIED_SESSION_MANAGER_COOKIE not set — cannot capture authenticated dev screenshots"; exit 1; }
      ```
      On failure, write a blocker brief in the workpad (escape hatch in `WORKFLOW.md`) and stop. Do not proceed with an unauthenticated capture.

   c. **Inject the cookie** into the Playwright browser context *before* the first navigation, using `mcp__playwright__browser_run_code_unsafe`:
      ```js
      await context.addCookies([{
        name: 'unified-session-manager-cookie',
        value: process.env.UNIFIED_SESSION_MANAGER_COOKIE,
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
        secure: true,
      }]);
      ```
      `cb-gssc` is **not** required for dev — only set it for prod captures, which this skill does not target.

   d. After injection, proceed to Step 1. The first `browser_navigate` should land on the authenticated app, not the auth wall. If it lands on the auth wall anyway, the cookie is stale — surface that as a blocker rather than retrying with the form.

1. **Capture comprehensively.** Navigate to the URL with `browser_navigate`, then `browser_take_screenshot` with `fullPage: true` to capture the entire page — full-page is the default; only fall back to element-scoped (`target: "<ref-from-snapshot>"`) when the page is impractically tall (infinite scroll, very long forms) or when the visible diff is genuinely a single component. Save under the workspace at `.symphony/screenshots/<descriptive-name>.png`. The Playwright sandbox blocks `/tmp/...` and any path outside the workspace + `.playwright-mcp/` roots.

   **Capture every state that matters to a reviewer**, not just the happy path. For a typical user-facing change that means multiple files — e.g. `01-default.png`, `02-loading.png`, `03-error.png`, `04-mobile.png`, `05-hover.png`. Resize the viewport with `browser_resize` between shots when the change is responsive. Err on the side of more screenshots: the screenshot commit is reverted in a follow-up so it doesn't bloat master after squash-merge, and a missing state is the most common reviewer ask. Number filenames so they sort and embed in a deterministic order.

2. **Stage and commit** all the screenshots together:
   ```sh
   git add .symphony/screenshots/
   git commit -m "chore: temporary screenshots for PR description (will be removed)" --no-verify
   ```
   `--no-verify` is allowed here because this commit is throwaway and lint/format hooks would reject the binary paths. This is the *only* skill that bypasses hooks.

3. **Push.** If the remote is ahead, rebase the screenshot commit onto it first (`git fetch && git rebase origin/<branch>`); a merge commit pollutes the throwaway history.
   ```sh
   git push origin "$(git branch --show-current)"
   ```

4. **Build the raw URLs** at the new commit SHA — one base, one URL per file.
   ```sh
   sha=$(git log -1 --format=%H)
   repo_url=$(gh repo view --json url -q .url)
   for f in .symphony/screenshots/*.png; do
     name=$(basename "$f")
     echo "${repo_url}/raw/${sha}/.symphony/screenshots/${name}"
   done
   ```

5. **Update PR body.** Read the current body, append (or replace) a `## Screenshots` section, write back. Never clobber existing sections. Embed every captured screenshot — one image per state — with a short caption derived from the filename so reviewers can scan them.
   ```sh
   pr=$(gh pr view --json number -q .number)
   body=$(gh pr view --json body -q .body)
   block=$(printf '\n\n## Screenshots\n\n')
   for f in .symphony/screenshots/*.png; do
     name=$(basename "$f" .png)
     url="${repo_url}/raw/${sha}/.symphony/screenshots/${name}.png"
     block+=$(printf '**%s**\n\n![%s](%s)\n\n' "$name" "$name" "$url")
   done
   gh pr edit "$pr" --body "${body}${block}"
   ```
   Use a heredoc or a built-up shell variable for the `--body` arg so newlines stay literal. Group related captures (e.g. mobile vs desktop) under sub-headings if it makes the PR easier to scan.

6. **Verify the images render** in the PR (visual confirmation by the operator, or a `curl -I "$raw_url"` returning 200 if running unattended). Confirm before proceeding to step 7. After revert the URLs still resolve (the blob stays reachable through branch history) and the screenshot commit is still in the branch — recoverable via `git log` if you ever need to re-derive a URL.

7. **Revert and push** to remove the screenshots from `HEAD` without rewriting history:
   ```sh
   git revert --no-edit HEAD --no-verify
   git push origin "$(git branch --show-current)"
   ```
   `--no-verify` carries the same throwaway-plumbing exception as step 2. If the push is rejected as non-fast-forward, run the `pull` skill (merge `origin/<branch>`), then re-run the push — no force needed. The screenshot commit's SHA stays in branch history, so the raw URLs captured in step 4 remain valid.

8. **Cleanup workspace artifacts**: the revert already removed `.symphony/screenshots/` from the working tree; just `rm -rf .playwright-mcp` (nothing should appear in `git status` afterward).

## Caveats

- **Blob lifetime.** The raw URL resolves as long as the screenshot commit is reachable from a remote branch. While the PR is open, the branch keeps it alive; after squash-merge + branch delete, GHE will GC it. Adequate for normal PR review windows, not for permanent documentation. If the change requires an enduring screenshot (e.g., a runbook), commit it to a real path on master via a separate PR.
- **History footprint.** The PR branch will end with two extra commits (the screenshot add + its revert). Squash-merge collapses both to a net-zero diff in the master commit, so this is purely cosmetic in the PR's "Commits" tab.

## Don't

- Don't force-push to undo the screenshot commit. The revert in step 7 is the *only* sanctioned teardown — force-push is destructive and gets blocked by the harness.
- Don't squash or amend the revert commit out of the PR branch — that would reintroduce the screenshots into `HEAD` and break the squash-merge net-zero assumption.
- Don't skip step 6 (visual verification). A broken URL in the PR body is harder to fix than re-capturing.
- Don't ship a single happy-path screenshot when the change has multiple states. If the diff touches loading / error / empty / mobile, capture each — reviewers will ask for them anyway.
- Don't crop or element-scope when `fullPage` works. Tight crops hide regressions in the surrounding chrome that a full-page shot would reveal.
- Don't reuse this skill for screenshots that need to live longer than the PR — see "Caveats".
- Don't carry the `--no-verify` exception into other skills; it's specific to this throwaway plumbing (now both the add and the revert).
- Don't fall back to filling the on-page auth form. The cookie-injection path is the contract; a stale cookie is a blocker, not a recoverable state.
- Don't capture against `coinbase-dev.cbhq.net` directly or against any prod URL — the skill targets the local dev server (`https://localhost:3000`).
- Don't set `cb-gssc`. It's only required for prod, and this skill never targets prod.
