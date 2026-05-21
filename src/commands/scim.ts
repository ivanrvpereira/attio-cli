import { readFileSync } from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { resolveApiKey } from '../config.js';
import { AttioApiError, AttioAuthError, AttioRateLimitError } from '../errors.js';
import { detectFormat, outputList, outputSingle, confirm, type OutputFormat } from '../output.js';

// ---------------------------------------------------------------------------
// SCIM base URL — SCIM lives at /scim/v2/..., not /v2/scim/...
// ---------------------------------------------------------------------------
const SCIM_BASE = 'https://api.attio.com';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

const SENSITIVE_KEY_PATTERN = /password|secret|token|authorization|api[_-]?key/i;

function redactForDebug(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDebug);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : redactForDebug(v);
    }
    return out;
  }
  return value;
}

async function safeReadJson(response: Response): Promise<{ json: any; raw: string }> {
  const raw = await response.text();
  if (!raw) return { json: null, raw };
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { json: null, raw };
  }
}

function parsePositiveInt(value: string | undefined, flagName: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flagName} must be a positive integer (got "${value}").`);
  }
  return n;
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const asSeconds = Number(retryAfter);
    if (!Number.isNaN(asSeconds)) {
      return Math.max(0, Math.ceil(asSeconds * 1000));
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }
  return INITIAL_BACKOFF_MS * Math.pow(2, attempt);
}

async function scimRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { apiKey?: string; debug?: boolean },
): Promise<T> {
  const apiKey = resolveApiKey(opts?.apiKey);
  const debug = opts?.debug ?? false;
  const url = `${SCIM_BASE}${path}`;

  if (debug) {
    console.error(chalk.dim(`→ ${method} ${url}`));
    if (body !== undefined) {
      console.error(chalk.dim(`  body: ${JSON.stringify(redactForDebug(body))}`));
    }
  }

  if (!apiKey) {
    throw new AttioAuthError('No API key configured');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/scim+json',
    Accept: 'application/json',
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s: ${method} ${path}`);
      }
      throw err;
    }
    clearTimeout(timer);

    if (debug) {
      console.error(chalk.dim(`← ${response.status} ${response.statusText}`));
    }

    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        const backoff = Math.max(100, getRetryDelayMs(response, attempt));
        if (debug) {
          console.error(chalk.dim(`  retrying in ${backoff}ms`));
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw new AttioRateLimitError('Rate limited after 3 retries');
    }

    if (response.status === 401) {
      throw new AttioAuthError('Invalid or expired API key');
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const { json, raw } = await safeReadJson(response);

    if (debug && !response.ok) {
      console.error(chalk.dim(`  error: ${JSON.stringify(redactForDebug(json ?? raw))}`));
    }

    if (!response.ok) {
      const errorType = json?.type ?? 'unknown_error';
      let errorDetail =
        json?.message ?? json?.detail ?? (raw && !json ? raw : response.statusText);
      if (json?.validation_errors?.length) {
        const details = json.validation_errors
          .map((e: any) => `${e.path?.join('.') || '?'}: ${e.message}`)
          .join('; ');
        errorDetail += ` [${details}]`;
      }
      throw new AttioApiError(response.status, errorType, errorDetail);
    }

    if (json === null) {
      throw new AttioApiError(
        response.status,
        'unknown_error',
        raw
          ? `Expected JSON response body but got non-JSON (${raw.slice(0, 200)})`
          : 'Expected JSON response body but got empty body',
      );
    }

    return json as T;
  }

  throw new AttioRateLimitError('Rate limited after 3 retries');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonInput(raw: string): any {
  if (raw.startsWith('@')) {
    return JSON.parse(readFileSync(raw.slice(1), 'utf-8'));
  }
  return JSON.parse(raw);
}

interface ScimListResponse {
  schemas?: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: any[];
}

function flattenUser(user: any): Record<string, string | number | boolean> {
  return {
    id: user.id ?? '',
    userName: user.userName ?? '',
    displayName: user.displayName ?? '',
    active: user.active ?? false,
    email: Array.isArray(user.emails) && user.emails.length > 0 ? user.emails[0].value : '',
  };
}

function flattenGroup(group: any): Record<string, string | number> {
  return {
    id: group.id ?? '',
    displayName: group.displayName ?? '',
    members: Array.isArray(group.members) ? group.members.length : 0,
  };
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const scim = program.command('scim').description('SCIM user/group provisioning (SCIM v2)');

  // -------------------------------------------------------------------------
  // scim schemas
  // -------------------------------------------------------------------------
  scim
    .command('schemas')
    .description('List SCIM schemas supported by this service provider')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const res = await scimRequest<ScimListResponse>('GET', '/scim/v2/Schemas', undefined, {
        apiKey: opts.apiKey,
        debug: opts.debug,
      });

      if (format === 'json') {
        outputList(res.Resources, { format });
        return;
      }

      // For table/csv, just show raw schema objects (they're schema definition objects)
      outputList(res.Resources, { format, idField: 'id' });
    });

  // -------------------------------------------------------------------------
  // scim users
  // -------------------------------------------------------------------------
  const users = scim.command('users').description('Manage SCIM users');

  users
    .command('list')
    .description('List SCIM users')
    .option('--filter <scim-filter>', 'SCIM filter expression (e.g. userName eq "alice@example.com")')
    .option('--start-index <n>', 'Pagination start index (1-based)', '1')
    .option('--count <n>', 'Number of results to return per page', '100')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const startIndex = parsePositiveInt(opts.startIndex, '--start-index', 1);
      const count = parsePositiveInt(opts.count, '--count', 100);
      const params = new URLSearchParams();
      params.set('startIndex', String(startIndex));
      params.set('count', String(count));
      if (opts.filter) {
        params.set('filter', opts.filter);
      }

      const res = await scimRequest<ScimListResponse>(
        'GET',
        `/scim/v2/Users?${params.toString()}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      const users = res.Resources ?? [];

      if (format === 'quiet') {
        for (const u of users) {
          console.log(u.id ?? '');
        }
        return;
      }

      if (format === 'json') {
        outputList(users, { format, idField: 'id' });
        return;
      }

      outputList(users.map(flattenUser), {
        format,
        columns: ['id', 'userName', 'displayName', 'active', 'email'],
        idField: 'id',
      });
    });

  users
    .command('get <id>')
    .description('Get a SCIM user by ID')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const user = await scimRequest<any>(
        'GET',
        `/scim/v2/Users/${encodeURIComponent(id)}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (format === 'json') {
        outputSingle(user, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenUser(user), { format, idField: 'id' });
    });

  users
    .command('create')
    .description('Create a SCIM user')
    .requiredOption('--data <json>', 'SCIM user JSON body or @file path')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const user = await scimRequest<any>('POST', '/scim/v2/Users', body, {
        apiKey: opts.apiKey,
        debug: opts.debug,
      });

      if (format === 'json') {
        outputSingle(user, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenUser(user), { format, idField: 'id' });
    });

  users
    .command('update <id>')
    .description('Patch (partially update) a SCIM user')
    .requiredOption('--data <json>', 'SCIM PATCH body JSON or @file path')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const user = await scimRequest<any>(
        'PATCH',
        `/scim/v2/Users/${encodeURIComponent(id)}`,
        body,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (!user) {
        console.error('Updated.');
        return;
      }

      if (format === 'json') {
        outputSingle(user, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenUser(user), { format, idField: 'id' });
    });

  users
    .command('replace <id>')
    .description('Replace (PUT) a SCIM user')
    .requiredOption('--data <json>', 'Full SCIM user JSON body or @file path')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const user = await scimRequest<any>(
        'PUT',
        `/scim/v2/Users/${encodeURIComponent(id)}`,
        body,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (!user) {
        console.error('Replaced.');
        return;
      }

      if (format === 'json') {
        outputSingle(user, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenUser(user), { format, idField: 'id' });
    });

  users
    .command('delete <id>')
    .description('Delete a SCIM user')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();

      if (!opts.yes) {
        const ok = await confirm(`Delete SCIM user ${id}?`);
        if (!ok) {
          console.error('Aborted.');
          return;
        }
      }

      await scimRequest<void>(
        'DELETE',
        `/scim/v2/Users/${encodeURIComponent(id)}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );
      console.error('Deleted.');
    });

  // -------------------------------------------------------------------------
  // scim groups
  // -------------------------------------------------------------------------
  const groups = scim.command('groups').description('Manage SCIM groups');

  groups
    .command('list')
    .description('List SCIM groups')
    .option('--filter <scim-filter>', 'SCIM filter expression (e.g. displayName eq "Engineering")')
    .option('--start-index <n>', 'Pagination start index (1-based)', '1')
    .option('--count <n>', 'Number of results to return per page', '100')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const startIndex = parsePositiveInt(opts.startIndex, '--start-index', 1);
      const count = parsePositiveInt(opts.count, '--count', 100);
      const params = new URLSearchParams();
      params.set('startIndex', String(startIndex));
      params.set('count', String(count));
      if (opts.filter) {
        params.set('filter', opts.filter);
      }

      const res = await scimRequest<ScimListResponse>(
        'GET',
        `/scim/v2/Groups?${params.toString()}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      const groups = res.Resources ?? [];

      if (format === 'quiet') {
        for (const g of groups) {
          console.log(g.id ?? '');
        }
        return;
      }

      if (format === 'json') {
        outputList(groups, { format, idField: 'id' });
        return;
      }

      outputList(groups.map(flattenGroup), {
        format,
        columns: ['id', 'displayName', 'members'],
        idField: 'id',
      });
    });

  groups
    .command('get <id>')
    .description('Get a SCIM group by ID')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const group = await scimRequest<any>(
        'GET',
        `/scim/v2/Groups/${encodeURIComponent(id)}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (format === 'json') {
        outputSingle(group, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenGroup(group), { format, idField: 'id' });
    });

  groups
    .command('create')
    .description('Create a SCIM group')
    .requiredOption('--data <json>', 'SCIM group JSON body or @file path')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const group = await scimRequest<any>('POST', '/scim/v2/Groups', body, {
        apiKey: opts.apiKey,
        debug: opts.debug,
      });

      if (format === 'json') {
        outputSingle(group, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenGroup(group), { format, idField: 'id' });
    });

  groups
    .command('update <id>')
    .description('Patch (partially update) a SCIM group')
    .requiredOption('--data <json>', 'SCIM PATCH body JSON or @file path')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const group = await scimRequest<any>(
        'PATCH',
        `/scim/v2/Groups/${encodeURIComponent(id)}`,
        body,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (!group) {
        console.error('Updated.');
        return;
      }

      if (format === 'json') {
        outputSingle(group, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenGroup(group), { format, idField: 'id' });
    });

  groups
    .command('replace <id>')
    .description('Replace (PUT) a SCIM group')
    .requiredOption('--data <json>', 'Full SCIM group JSON body or @file path')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      const body = parseJsonInput(opts.data);

      const group = await scimRequest<any>(
        'PUT',
        `/scim/v2/Groups/${encodeURIComponent(id)}`,
        body,
        { apiKey: opts.apiKey, debug: opts.debug },
      );

      if (!group) {
        console.error('Replaced.');
        return;
      }

      if (format === 'json') {
        outputSingle(group, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenGroup(group), { format, idField: 'id' });
    });

  groups
    .command('delete <id>')
    .description('Delete a SCIM group')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();

      if (!opts.yes) {
        const ok = await confirm(`Delete SCIM group ${id}?`);
        if (!ok) {
          console.error('Aborted.');
          return;
        }
      }

      await scimRequest<void>(
        'DELETE',
        `/scim/v2/Groups/${encodeURIComponent(id)}`,
        undefined,
        { apiKey: opts.apiKey, debug: opts.debug },
      );
      console.error('Deleted.');
    });
}
