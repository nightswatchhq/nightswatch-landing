#!/usr/bin/env node
// Builds dist/ from src/ + the live repo list for the org.
// No dependencies: node >= 18 for global fetch.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORG = process.env.ORG || 'nightswatchhq';
const DISCORD = process.env.DISCORD_INVITE || 'https://discord.gg/CQewvyJ69Y';
// Canonical origin, no trailing slash. Override with SITE_URL when a custom domain lands.
const SITE_URL = (process.env.SITE_URL || 'https://nightswatch-landing.vercel.app').replace(/\/+$/, '');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SNAPSHOT = join(ROOT, 'data/repos.snapshot.json');

// Only the fields the page actually renders — keeps the committed snapshot small
// and its diffs readable.
const slim = (r) => ({
  name: r.name,
  html_url: r.html_url,
  description: r.description,
  language: r.language,
  stargazers_count: r.stargazers_count,
  pushed_at: r.pushed_at,
});

async function fetchFromApi() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `${ORG}-landing` };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const out = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out
    .filter((r) => !r.private && !r.archived && !r.disabled)
    .map(slim)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Vercel builds from shared IPs where the unauthenticated GitHub API (60 req/hr per IP)
// regularly 403s. Deploys must not depend on that, so the committed snapshot is the
// fallback — refreshed daily by .github/workflows/refresh-repos.yml.
async function getRepos() {
  if (process.env.USE_SNAPSHOT !== '1') {
    try {
      const live = await fetchFromApi();
      if (live.length) return { repos: live, source: 'github api' };
      console.warn('! GitHub API returned no repos; falling back to snapshot');
    } catch (err) {
      console.warn(`! GitHub API unavailable (${err.message}); falling back to snapshot`);
    }
  }
  try {
    return { repos: JSON.parse(await readFile(SNAPSHOT, 'utf8')), source: 'snapshot' };
  } catch (err) {
    throw new Error(`no live API and no usable snapshot at data/repos.snapshot.json: ${err.message}`);
  }
}

// House style: no em dashes on the site. Descriptions come from GitHub and can be edited
// by anyone with push access, so normalise here rather than let a description edit break
// the build. The warning names the repo so it can be fixed properly at the source.
const dashed = [];
function noDash(text, repoName) {
  if (!text || !text.includes('—')) return text;
  dashed.push(repoName);
  return text.replace(/\s*—\s*/g, ', ').replace(/,\s*,/g, ',');
}

function card(repo) {
  const bits = [];
  if (repo.language) bits.push(esc(repo.language));
  if (repo.stargazers_count > 0) bits.push(`★ ${repo.stargazers_count}`);
  return `        <a class="card" href="${esc(repo.html_url)}">
          <div class="name">${esc(repo.name)}</div>
          ${repo.description ? `<p class="desc">${esc(noDash(repo.description, repo.name))}</p>` : ''}
          ${bits.length ? `<div class="meta">${bits.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
        </a>`;
}

function render(repos, cfg) {
  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const hidden = new Set((cfg.hide || []).map((n) => n.toLowerCase()));
  const claimed = new Set(hidden);
  const sections = [];

  for (const g of cfg.groups) {
    const picked = g.repos
      .map((n) => {
        claimed.add(n.toLowerCase());
        return byName.get(n.toLowerCase());
      })
      .filter(Boolean);
    if (!picked.length) continue;
    sections.push(`      <div class="group">
        <h3>${esc(g.title)}</h3>
        <p class="blurb">${esc(g.blurb)}</p>
        <div class="grid">
${picked.map(card).join('\n')}
        </div>
      </div>`);
  }

  // Anything new in the org that nobody has categorised yet still shows up.
  const rest = repos
    .filter((r) => !claimed.has(r.name.toLowerCase()))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  if (rest.length) {
    sections.push(`      <div class="group">
        <h3>Also in the org</h3>
        <p class="blurb">Newer or uncategorised work.</p>
        <div class="grid">
${rest.map(card).join('\n')}
        </div>
      </div>`);
  }

  const shown = repos.filter((r) => !hidden.has(r.name.toLowerCase())).length;
  return { html: sections.join('\n'), count: shown };
}

// `--snapshot` refreshes the committed repo list and stops; the daily workflow uses it.
if (process.argv.includes('--snapshot')) {
  const fresh = await fetchFromApi();
  if (!fresh.length) throw new Error('refusing to write an empty snapshot');
  await writeFile(SNAPSHOT, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`snapshot refreshed: ${fresh.length} repos`);
  process.exit(0);
}

const { repos, source } = await getRepos();
const cfg = JSON.parse(await readFile(join(ROOT, 'data/categories.json'), 'utf8'));
const { html, count } = render(repos, cfg);

const generated = (process.env.SOURCE_DATE || new Date().toISOString()).slice(0, 10);
const page = (await readFile(join(ROOT, 'src/index.template.html'), 'utf8'))
  .replaceAll('{{REPOS}}', html)
  .replaceAll('{{REPO_COUNT}}', String(count))
  .replaceAll('{{DISCORD}}', esc(DISCORD))
  .replaceAll('{{SITE_URL}}', esc(SITE_URL))
  .replaceAll('{{GENERATED}}', generated);

if (page.includes('{{')) throw new Error('unreplaced placeholder left in output');

// House style: no em dashes anywhere on the site. Repo descriptions come from GitHub,
// so this catches one drifting back in via a description edit rather than a code change.
if (page.includes('—')) {
  const offenders = [...page.matchAll(/[^\n]{0,60}—[^\n]{0,60}/g)].map((m) => m[0].trim());
  throw new Error(`em dash found in output (house style forbids it):\n  ${offenders.join('\n  ')}`);
}

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist/index.html'), page);
await copyFile(join(ROOT, 'src/styles.css'), join(ROOT, 'dist/styles.css'));
await writeFile(join(ROOT, 'dist/.nojekyll'), '');

if (dashed.length) {
  console.warn(`! em dashes normalised in descriptions for: ${[...new Set(dashed)].join(', ')}`);
  console.warn('  fix them on GitHub so the source text matches the site.');
}

console.log(`built dist/: ${count} repos from ${source}, ${cfg.groups.length} groups`);
