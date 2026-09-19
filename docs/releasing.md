# Releasing

Versions are published to npm by the `release` workflow when a GitHub release is published. It uses npm's
trusted publishing (OIDC), so no npm token is stored in GitHub, and the package gets a provenance statement.

## One-time setup

1. Create the package on npm with a first manual publish (`npm publish --access public` from a clean checkout), or reserve the name.
2. On npmjs.com, open the package → **Settings** → **Trusted publishing** and add a GitHub Actions publisher: repository `arthurdaquinosilva/cinder`, workflow `release.yml`, environment `npm`.
3. In the GitHub repository, create an environment named `npm` (Settings → Environments). Add required reviewers if you want a manual approval step.

## Each release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Run the checks:
   ```sh
   npm test
   npm run docs:check
   npm pack --dry-run      # look over the file list
   ```
3. Commit, tag and push: `git tag v0.1.0 && git push --tags`.
4. Create a GitHub release from the tag. The workflow runs the tests, then publishes to npm.
