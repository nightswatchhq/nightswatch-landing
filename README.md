# nightswatch-landing

Landing page for **The Night's Watch** — an open community for the people who build and
hold the data layer of web3.

Join us: <https://discord.gg/CQewvyJ69Y>

## What this is

A single static page. No framework, no bundler, no webfonts, no third-party requests at
runtime. The only build step fetches the org's public repo list from the GitHub API and
renders it into the page, so the showcase stays current on its own.

```
src/index.template.html   the page, with {{PLACEHOLDER}} slots
src/styles.css            all styling, dark default + light toggle
data/categories.json      which repos appear under which heading
scripts/build.mjs         fetch repos, fill the template, write dist/
```

## Build locally

Needs Node 18+ (for global `fetch`). No `npm install`.

```sh
node scripts/build.mjs
open dist/index.html
```

Unauthenticated GitHub API calls are rate-limited to 60/hour. If you hit that:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs
```

Environment overrides: `ORG`, `DISCORD_INVITE`, `GITHUB_TOKEN`, `SOURCE_DATE`.

## Adding a repo to the showcase

New public repos in the org appear automatically under **Also in the org**. To file one
under a proper heading, add its name to the relevant group in `data/categories.json`.
To keep one off the page entirely, add it to `hide`.

Archived, disabled and private repos are excluded automatically.

## Deployment

GitHub Actions builds and publishes to GitHub Pages on every push to `main`, plus a
daily rebuild so new repos show up without a commit.
