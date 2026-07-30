#!/usr/bin/env node
// Builds dist/ from src/ + the live repo list for the org.
// No dependencies: node >= 18 for global fetch.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORG = process.env.ORG || 'nightswatchhq';
const DISCORD = process.env.DISCORD_INVITE || 'https://discord.gg/CQewvyJ69Y';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function fetchRepos() {
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
  return out.filter((r) => !r.private && !r.archived && !r.disabled);
}

function card(repo) {
  const bits = [];
  if (repo.language) bits.push(esc(repo.language));
  if (repo.stargazers_count > 0) bits.push(`★ ${repo.stargazers_count}`);
  return `        <a class="card" href="${esc(repo.html_url)}">
          <div class="name">${esc(repo.name)}</div>
          ${repo.description ? `<p class="desc">${esc(repo.description)}</p>` : ''}
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

const repos = await fetchRepos();
const cfg = JSON.parse(await readFile(join(ROOT, 'data/categories.json'), 'utf8'));
const { html, count } = render(repos, cfg);

const generated = (process.env.SOURCE_DATE || new Date().toISOString()).slice(0, 10);
const page = (await readFile(join(ROOT, 'src/index.template.html'), 'utf8'))
  .replaceAll('{{REPOS}}', html)
  .replaceAll('{{REPO_COUNT}}', String(count))
  .replaceAll('{{DISCORD}}', esc(DISCORD))
  .replaceAll('{{GENERATED}}', generated);

if (page.includes('{{')) throw new Error('unreplaced placeholder left in output');

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist/index.html'), page);
await copyFile(join(ROOT, 'src/styles.css'), join(ROOT, 'dist/styles.css'));
await writeFile(join(ROOT, 'dist/.nojekyll'), '');

console.log(`built dist/ — ${count} repos, ${cfg.groups.length} groups, ${repos.length} fetched`);
