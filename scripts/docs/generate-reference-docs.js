import fs from 'fs';
import path from 'path';

import { adminScriptGroups } from '../../src/config/adminScripts.js';
import { paymentProviders } from '../../src/services/payments/index.js';
import {
  registerDefaultAutomationTasks,
  listTasks
} from '../../src/services/automation/index.js';
import * as models from '../../src/models/index.js';

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs');
registerDefaultAutomationTasks();

function writeDoc(filename, content) {
  const target = path.join(DOCS_DIR, filename);
  fs.writeFileSync(target, content.trimStart() + '\n', 'utf8');
  console.log(`updated ${path.relative(ROOT, target)}`);
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function code(value) {
  return `\`${String(value ?? '')}\``;
}

function frontMatter(title, navOrder) {
  return `---\ntitle: ${title}\nnav_order: ${navOrder}\n---\n`;
}

function autoNotice(source) {
  return [
    '> Generated from code.',
    `> Source: ${source}`,
    '> Regenerate with: `npm run docs:refs`',
    ''
  ].join('\n');
}

function formatTemplates(templates = []) {
  if (!Array.isArray(templates) || templates.length === 0) return '—';
  return templates.map((entry) => code(entry)).join('<br>');
}

function formatScriptMode(script) {
  if (script?.automation?.taskId) return `automation (${script.automation.taskId})`;
  return 'cli';
}

function renderScriptsCatalog() {
  const groups = [...adminScriptGroups].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const sections = groups.map((group) => {
    const rows = [...(group.scripts || [])]
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((script) => {
        const label = script.path ? `${code(script.path)}<br><small>${mdEscape(script.label || script.id)}</small>` : code(script.id || '');
        return `| ${label} | ${mdEscape(script.description || '—')} | ${code(script.command || '')} | ${mdEscape(formatScriptMode(script))} | ${formatTemplates(script.templates)} |`;
      })
      .join('\n');

    return [
      `## ${group.label}`,
      '',
      group.description || '',
      '',
      '| Script | Purpose | Command | Mode | Templates |',
      '| --- | --- | --- | --- | --- |',
      rows,
      ''
    ].join('\n');
  }).join('\n');

  return `${frontMatter('Catalogue des scripts', 60)}
# Catalogue des scripts

${autoNotice('src/config/adminScripts.js')}
The repository consolidates all operational scripts under a shared catalog exposed in the admin UI and in CLI workflows.

Each section below is rendered directly from the metadata in ${code('src/config/adminScripts.js')}.

${sections}
## Console d'administration

- Base URL: ${code('/admin')} (subject to ${code('BASE_PATH')}).
- Authentication: Basic auth (${code('ADMIN_USER')}/${code('ADMIN_PASS')}) or bearer token (${code('ADMIN_TOKEN')}).
- Features: monitoring panels, exports, script runner, and automation job controls.
`;
}

function taskParamList(task) {
  const props = task?.schema?.properties || {};
  const keys = Object.keys(props);
  if (keys.length === 0) return '—';
  return keys.map((key) => code(key)).join(', ');
}

function taskScopes(task) {
  const scopes = Array.isArray(task?.scopes) ? task.scopes : [];
  return scopes.length ? scopes.map((scope) => code(scope)).join(', ') : '—';
}

function renderAutomationApi() {
  const tasks = [...listTasks()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rows = tasks.map((task) => {
    return `| ${code(task.id)} | ${mdEscape(task.summary || task.description || '—')} | ${taskScopes(task)} | ${task.allowDryRun === false ? 'no' : 'yes'} | ${mdEscape(taskParamList(task))} |`;
  }).join('\n');

  const details = tasks.map((task) => {
    const tags = Array.isArray(task.tags) && task.tags.length
      ? task.tags.map((tag) => code(tag)).join(', ')
      : '—';
    return [
      `## ${task.id}`,
      '',
      `- Version: ${code(task.version || '—')}`,
      `- Summary: ${task.summary || task.description || '—'}`,
      `- Dry-run: ${task.allowDryRun === false ? 'disabled' : 'supported'}`,
      `- Scopes: ${taskScopes(task)}`,
      `- Tags: ${tags}`,
      `- Parameters: ${taskParamList(task)}`,
      ''
    ].join('\n');
  }).join('\n');

  return `${frontMatter('Automation API', 70)}
# Automation API

${autoNotice('src/routes/automation/index.js, src/services/automation/tasks/*, src/middlewares/automation-auth.js')}
## Entry point

- Base path: ${code('/api/automation')}

## Authentication model

- JWT secret: ${code('AUTOMATION_JWT_SECRET')}
- Optional issuer check: ${code('AUTOMATION_JWT_ISSUER')}
- Optional audience check: ${code('AUTOMATION_JWT_AUDIENCE')}
- Optional IP allowlist: ${code('AUTOMATION_ALLOWED_IPS')}
- Accepted token sources: ${code('Authorization: Bearer ...')}, ${code('x-automation-token')}, or query ${code('token')}

## HTTP surfaces

- ${code('GET /scripts')} lists available tasks.
- ${code('GET /scripts/:id')} reads one task definition.
- ${code('POST /scripts/:id/jobs')} creates a job and optionally runs it synchronously.
- ${code('GET /jobs')} lists jobs.
- ${code('GET /jobs/:jobId')} reads one job.
- ${code('GET /jobs/:jobId/logs')} reads serialized logs.

## Registered tasks

| Task ID | Summary | Scopes | Dry-run | Parameters |
| --- | --- | --- | --- | --- |
${rows}

${details}`;
}

function renderPayments() {
  const providers = Object.values(paymentProviders).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rows = providers.map((provider) => {
    const docs = provider.docs || {};
    return `| ${code(provider.id)} | ${mdEscape(provider.label || provider.id)} | ${code(docs.defaultApiBase || '—')} | ${code(docs.stubCommand || '—')} | ${docs.webhookDriven ? 'yes' : 'no'} |`;
  }).join('\n');

  const details = providers.map((provider) => {
    const docs = provider.docs || {};
    const envList = Array.isArray(docs.env) && docs.env.length
      ? docs.env.map((entry) => `- ${code(entry)}`).join('\n')
      : '- —';
    const notes = Array.isArray(docs.notes) && docs.notes.length
      ? docs.notes.map((entry) => `- ${entry}`).join('\n')
      : '- —';
    return [
      `## ${provider.label || provider.id}`,
      '',
      `- Provider ID: ${code(provider.id)}`,
      `- Default API base: ${code(docs.defaultApiBase || '—')}`,
      `- Stub command: ${code(docs.stubCommand || '—')}`,
      `- Uses webhook/async confirmation: ${docs.webhookDriven ? 'yes' : 'no'}`,
      '',
      '### Environment variables',
      '',
      envList,
      '',
      '### Notes',
      '',
      notes,
      ''
    ].join('\n');
  }).join('\n');

  return `${frontMatter('Payments', 80)}
# Payments

${autoNotice('src/services/payments/* and src/services/payments/index.js')}
## Provider switch

BTS selects its payment adapter through ${code('PAYMENT_PROVIDER')}.

## Shared payment surfaces

- checkout intent creation
- return/back/error URL construction
- payment status normalization
- intent polling and webhook reconciliation via ${code('/pay/*')}

## Registered providers

| Provider | Label | Default API base | Local stub | Webhook-driven |
| --- | --- | --- | --- | --- |
${rows}

${details}
See also [stubs.md](stubs.md) for local simulator usage.
`;
}

function topLevelPaths(schema) {
  const names = Object.keys(schema.paths || {})
    .filter((name) => !name.includes('.'))
    .filter((name) => name !== '_id' && name !== '__v');
  return names.sort((a, b) => a.localeCompare(b));
}

function schemaTypeLabel(pathDef) {
  if (!pathDef) return 'unknown';
  if (pathDef.instance === 'Array') {
    const caster = pathDef.caster;
    return caster?.instance ? `Array<${caster.instance}>` : 'Array';
  }
  return pathDef.instance || 'Mixed';
}

function formatIndexes(model) {
  const indexes = model.schema.indexes();
  if (!indexes.length) return '—';
  return indexes.map(([spec, opts]) => {
    const fields = Object.entries(spec).map(([key, value]) => `${key}:${value}`).join(', ');
    const flags = [];
    if (opts?.name) flags.push(`name=${opts.name}`);
    if (opts?.unique) flags.push('unique');
    if (opts?.sparse) flags.push('sparse');
    if (opts?.expireAfterSeconds != null) flags.push(`ttl=${opts.expireAfterSeconds}`);
    return `${code(fields)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  }).join('<br>');
}

function modelGroup(name) {
  const groups = {
    catalog: ['Venue', 'SeatCatalog', 'ZoneCatalog', 'TariffPriceCatalog'],
    runtime: ['Season', 'Zone', 'Seat', 'ZoneHold', 'Order'],
    events: ['Event', 'Ticket', 'QrBankCode', 'ScanLog', 'SeatHold'],
    audience: ['Subscriber', 'Campaign', 'AutomationJob', 'Counter']
  };
  for (const [group, members] of Object.entries(groups)) {
    if (members.includes(name)) return group;
  }
  return 'other';
}

function renderDataModel() {
  const modelEntries = Object.entries(models)
    .filter(([, value]) => value && value.modelName && value.schema)
    .sort(([a], [b]) => a.localeCompare(b));

  const groupTitles = {
    catalog: 'Catalogue',
    runtime: 'Runtime saison / vente',
    events: 'Événements et contrôle',
    audience: 'Audience / opérations',
    other: 'Autres'
  };

  const grouped = new Map();
  for (const [name, model] of modelEntries) {
    const group = modelGroup(name);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push([name, model]);
  }

  const summaryRows = modelEntries.map(([name, model]) => {
    const pathCount = topLevelPaths(model.schema).length;
    const indexCount = model.schema.indexes().length;
    return `| ${code(name)} | ${mdEscape(groupTitles[modelGroup(name)] || 'Other')} | ${pathCount} | ${indexCount} |`;
  }).join('\n');

  const details = Array.from(grouped.entries()).map(([group, entries]) => {
    const sections = entries.map(([name, model]) => {
      const fields = topLevelPaths(model.schema)
        .map((field) => `- ${code(field)}: ${code(schemaTypeLabel(model.schema.paths[field]))}`)
        .join('\n');
      return [
        `### ${name}`,
        '',
        '#### Top-level fields',
        '',
        fields || '- —',
        '',
        '#### Indexes',
        '',
        formatIndexes(model),
        ''
      ].join('\n');
    }).join('\n');

    return `## ${groupTitles[group] || group}\n\n${sections}`;
  }).join('\n');

  return `${frontMatter('Data Model', 120)}
# Data Model

${autoNotice('src/models/*.js')}
## Model inventory

| Model | Family | Top-level fields | Indexes |
| --- | --- | --- | --- |
${summaryRows}

${details}`;
}

writeDoc('scripts-catalog.md', renderScriptsCatalog());
writeDoc('automation-api.md', renderAutomationApi());
writeDoc('payments.md', renderPayments());
writeDoc('data-model.md', renderDataModel());
