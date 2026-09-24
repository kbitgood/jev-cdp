# Jev CDP agent instructions

## Preparing the next npm release

When the user says they are ready to publish the next version, or asks to commit, push, and publish, prepare the release through the push and leave the npm publish command for the user to run. Do this work without asking for a separate confirmation to commit or push when the request already authorizes those steps.

1. Inspect the working tree, current branch, recent commits, release scripts, and the version in `package.json`. Check the currently published npm version and choose the next appropriate version.
2. Review the changes going into the release. Update `package.json` and any versioned documentation or tests. Keep `check-published-version` in the repository so the post-publish check works.
3. Run `bun run check`. Build or run the packaged CLI as appropriate, then run `bun publish --dry-run` and inspect the package contents. Resolve failures before proceeding.
4. Commit the release changes, push the intended branch, and verify that the remote has the commit and the working tree is clean. Do not publish the package on the user's behalf.
5. End with the exact command below, run from the repository root, so the user can authenticate if needed, publish, and wait until the package version is live on npm:

```bash
((npm whoami >/dev/null 2>&1) || npm login --auth-type=web) && bun publish && bun check-published-version
```
