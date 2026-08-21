#!/usr/bin/env node
// Builds dist/ from src/ + the live repo list for the org.
// No dependencies: node >= 18 for global fetch.

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
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

// House style also bans emoji. Same reasoning as em dashes: a description edit on
// GitHub should not be able to put one on the page.
const emojid = [];
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu;
function noEmoji(text, repoName) {
  if (!text || !EMOJI.test(text)) return text;
  emojid.push(repoName);
  return text.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}

function clean(text, repoName) {
  return noEmoji(noDash(text, repoName), repoName);
}

// Descriptions run long. Trim on a word boundary rather than mid-word.
function clip(text, n) {
  if (!text || text.length <= n) return text;
  const cut = text.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,.;:]$/, '') + '…';
}

// A flagship, in the bento. The first one spans four columns, the rest two.
function cell(repo, tag, wide) {
  const desc = clip(clean(repo.description, repo.name), wide ? 220 : 130);
  const meta = [];
  if (repo.language) meta.push(esc(repo.language));
  if (repo.stargazers_count > 0) meta.push(`${repo.stargazers_count} stars`);
  return `        <a class="cell ${wide ? 'c-feature' : 'c-third'}" href="${esc(repo.html_url)}" data-reveal>
          <div>
            ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
            <div class="name">${esc(repo.name)}</div>
            ${desc ? `<p>${esc(desc)}</p>` : ''}
          </div>
          ${meta.length ? `<div class="meta">${meta.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
        </a>`;
}

// Everything else, as one compact line: name, description, language.
function row(repo) {
  const desc = clip(clean(repo.description, repo.name), 90);
  return `          <a class="row" href="${esc(repo.html_url)}">
            <span class="rname">${esc(repo.name)}</span>
            <span class="rdesc">${esc(desc || '')}</span>
            ${repo.language ? `<span class="rlang">${esc(repo.language)}</span>` : ''}
          </a>`;
}

function render(repos, cfg) {
  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const hidden = new Set((cfg.hide || []).map((n) => n.toLowerCase()));
  const claimed = new Set(hidden);
  const sections = [];

  // The bento leads. Featured repos are claimed so they do not appear twice.
  const featured = (cfg.feature || [])
    .map((f, i) => {
      const repo = byName.get(f.repo.toLowerCase());
      if (!repo) { console.warn(`! featured repo not in the org: ${f.repo}`); return null; }
      claimed.add(f.repo.toLowerCase());
      return cell(repo, f.tag, i === 0);
    })
    .filter(Boolean)
    .join('\n');


  for (const g of cfg.groups) {
    const picked = g.repos
      .map((n) => {
        claimed.add(n.toLowerCase());
        return byName.get(n.toLowerCase());
      })
      .filter(Boolean);
    if (!picked.length) continue;
    sections.push(`        <div class="group" data-reveal>
          <h3>${esc(g.title)}</h3>
          <p class="blurb">${esc(g.blurb)}</p>
          <div class="rows">
${picked.map(row).join('\n')}
          </div>
        </div>`);
  }

  // Anything new in the org that nobody has categorised yet still shows up.
  const rest = repos
    .filter((r) => !claimed.has(r.name.toLowerCase()))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  if (rest.length) {
    sections.push(`        <div class="group" data-reveal>
          <h3>Also in the org</h3>
          <p class="blurb">Newer or uncategorised work.</p>
          <div class="rows">
${rest.map(row).join('\n')}
          </div>
        </div>`);
  }

  const shown = repos.filter((r) => !hidden.has(r.name.toLowerCase())).length;
  const langs = {};
  for (const r of repos) if (r.language) langs[r.language] = (langs[r.language] || 0) + 1;
  return { html: sections.join('\n'), featured, count: shown, langs };
}

const generatedISO = process.env.SOURCE_DATE || new Date().toISOString();
const generated = generatedISO.slice(0, 10);

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
const { html, featured, count, langs } = render(repos, cfg);

// The terminal in the hero shows real `gh` output. Build the language lines from
// the same data the page is generated from, so the transcript cannot drift away
// from the truth the way a hand-written one would.
const ORG_OPENED = Date.UTC(2026, 4, 8);   // 8 May 2026, when the org was created
const orgDays = Math.floor((Date.parse(generatedISO) - ORG_OPENED) / 86400000);
const langLines = Object.entries(langs)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 5)
  .map(([lang, n]) => {
    const pad = ' '.repeat(Math.max(0, 4 - String(n).length));
    return `            <div class="tline tline--out"><span class="tline-body">${pad}` +
           `<span class="n">${n}</span> ${esc(lang)}</span></div>`;
  })
  .join('\n');
// The same counts again as prose, for the screen reader on the terminal panel.
const langProse = Object.entries(langs)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 5)
  .map(([lang, n]) => `${n} ${lang}`)
  .join(', ');

const page = (await readFile(join(ROOT, 'src/index.template.html'), 'utf8'))
  .replaceAll('{{REPOS}}', html)
  .replaceAll('{{FEATURED}}', featured)
  .replaceAll('{{FEATURE_COUNT}}', ['Nought','One','Two','Three','Four','Five','Six','Seven','Eight'][(cfg.feature || []).length] || String((cfg.feature || []).length))
  .replaceAll('{{LANG_LINES}}', langLines)
  .replaceAll('{{LANG_PROSE}}', esc(langProse))
  .replaceAll('{{REPO_COUNT}}', String(count))
  .replaceAll('{{REPO_LIVE}}', String(repos.length))
  .replaceAll('{{RUST_COUNT}}', String(langs.Rust || 0))
  .replaceAll('{{SOLIDITY_COUNT}}', String(langs.Solidity || 0))
  .replaceAll('{{ORG_DAYS}}', String(orgDays))
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

// Everything in src/static is served at the site root.
for (const entry of await readdir(join(ROOT, 'src/static'), { withFileTypes: true })) {
  if (!entry.isFile()) continue;   // src/static is flat by design; skip anything else
  await copyFile(join(ROOT, 'src/static', entry.name), join(ROOT, 'dist', entry.name));
}

if (dashed.length) {
  console.warn(`! em dashes normalised in descriptions for: ${[...new Set(dashed)].join(', ')}`);
  console.warn('  fix them on GitHub so the source text matches the site.');
}
if (emojid.length) {
  console.warn(`! emoji stripped from descriptions for: ${[...new Set(emojid)].join(', ')}`);
  console.warn('  fix them on GitHub so the source text matches the site.');
}

console.log(`built dist/: ${count} repos from ${source}, ${cfg.groups.length} groups`);
