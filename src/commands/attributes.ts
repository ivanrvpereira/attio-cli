import { readFileSync } from 'fs';
import { Command } from 'commander';
import { AttioClient } from '../client.js';
import { detectFormat, outputList, outputSingle, type OutputFormat } from '../output.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonInput(raw: string): any {
  if (raw.startsWith('@')) {
    return JSON.parse(readFileSync(raw.slice(1), 'utf-8'));
  }
  return JSON.parse(raw);
}

function parseBoolFlag(value: string, flagName: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flagName} must be "true" or "false" (got "${value}").`);
}

/**
 * Resolve the API path prefix from --object / --list flags.
 * Exactly one of the two must be set; throws if neither or both are provided.
 */
function resolveTargetPath(opts: { object?: string; list?: string }): string {
  const hasObject = Boolean(opts.object);
  const hasList = Boolean(opts.list);

  if (hasObject && hasList) {
    throw new Error('Specify either --object or --list, not both.');
  }
  if (!hasObject && !hasList) {
    throw new Error('You must specify either --object <slug> or --list <id>.');
  }

  if (hasObject) {
    return `/objects/${encodeURIComponent(opts.object!)}`;
  }
  return `/lists/${encodeURIComponent(opts.list!)}`;
}

function flattenAttribute(attr: any): Record<string, string | number | boolean> {
  return {
    api_slug: attr.api_slug || '',
    title: attr.title || '',
    type: attr.type || '',
    is_required: attr.is_required ?? false,
    is_unique: attr.is_unique ?? false,
    is_multiselect: attr.is_multiselect ?? false,
    is_archived: attr.is_archived ?? false,
    created_at: attr.created_at || '',
  };
}

function flattenOption(opt: any): Record<string, string | boolean> {
  return {
    id: opt.id?.option_id || opt.id || '',
    title: opt.title || '',
    is_archived: opt.is_archived ?? false,
  };
}

function flattenStatus(status: any): Record<string, string | boolean> {
  return {
    id: status.id?.status_id || status.id || '',
    title: status.title || '',
    celebration_enabled: status.celebration_enabled ?? false,
    target_time_in_status: status.target_time_in_status || '',
    is_archived: status.is_archived ?? false,
  };
}

// ---------------------------------------------------------------------------
// Shared option declarations (added to each sub-command that needs them)
// ---------------------------------------------------------------------------

function addTargetOptions(cmd: Command): Command {
  return cmd
    .option('--object <slug>', 'Target object slug (e.g. people, companies)')
    .option('--list <id>', 'Target list ID or slug');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const attributes = program
    .command('attributes')
    .description('Manage object and list attributes');

  // -------------------------------------------------------------------------
  // attributes list
  // -------------------------------------------------------------------------
  addTargetOptions(
    attributes
      .command('list')
      .description('List attributes for an object or list'),
  ).action(async (_options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);
    const res = await client.get<{ data: any[] }>(`${base}/attributes`);
    const items = res.data;

    if (format === 'quiet') {
      for (const attr of items) {
        console.log(attr.api_slug || '');
      }
      return;
    }

    if (format === 'json') {
      outputList(items, { format, idField: 'api_slug' });
      return;
    }

    outputList(items.map(flattenAttribute), {
      format,
      columns: ['api_slug', 'title', 'type', 'is_required', 'is_unique', 'is_multiselect'],
      idField: 'api_slug',
    });
  });

  // -------------------------------------------------------------------------
  // attributes get <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    attributes
      .command('get <attribute>')
      .description('Get a single attribute by slug or ID'),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);
    const res = await client.get<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}`,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'api_slug' });
      return;
    }

    outputSingle(flattenAttribute(res.data), { format, idField: 'api_slug' });
  });

  // -------------------------------------------------------------------------
  // attributes create
  // -------------------------------------------------------------------------
  addTargetOptions(
    attributes
      .command('create')
      .description('Create a new attribute')
      .option('--title <title>', 'Attribute title')
      .option('--type <type>', 'Attribute type (text, number, select, status, …)')
      .option('--api-slug <slug>', 'API slug for the attribute')
      .option('--description <text>', 'Description')
      .option('--is-required', 'Mark as required')
      .option('--is-unique', 'Enforce uniqueness')
      .option('--is-multiselect', 'Allow multiple values')
      .option(
        '--data <json>',
        'Full request body JSON ({ "data": { ... } }) or @file.json. Overrides individual flags.',
      ),
  ).action(async (_options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      if (!opts.title) {
        throw new Error('--title is required when not using --data.');
      }
      if (!opts.type) {
        throw new Error('--type is required when not using --data.');
      }
      const data: Record<string, any> = {
        title: opts.title,
        type: opts.type,
      };
      if (opts.apiSlug) data.api_slug = opts.apiSlug;
      if (opts.description) data.description = opts.description;
      if (opts.isRequired) data.is_required = true;
      if (opts.isUnique) data.is_unique = true;
      if (opts.isMultiselect) data.is_multiselect = true;
      body = { data };
    }

    const res = await client.post<{ data: any }>(`${base}/attributes`, body);
    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'api_slug' });
      return;
    }
    outputSingle(flattenAttribute(res.data), { format, idField: 'api_slug' });
  });

  // -------------------------------------------------------------------------
  // attributes update <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    attributes
      .command('update <attribute>')
      .description('Update an existing attribute')
      .option('--title <title>', 'New title')
      .option('--api-slug <slug>', 'New API slug')
      .option('--description <text>', 'New description')
      .option('--is-required <bool>', 'Set required (true/false)')
      .option('--is-unique <bool>', 'Set unique (true/false)')
      .option('--is-archived <bool>', 'Set archived (true/false)')
      .option(
        '--data <json>',
        'Full request body JSON ({ "data": { ... } }) or @file.json. Overrides individual flags.',
      ),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      const data: Record<string, any> = {};
      if (opts.title) data.title = opts.title;
      if (opts.apiSlug) data.api_slug = opts.apiSlug;
      if (opts.description !== undefined) data.description = opts.description;
      if (opts.isRequired !== undefined) data.is_required = parseBoolFlag(opts.isRequired, '--is-required');
      if (opts.isUnique !== undefined) data.is_unique = parseBoolFlag(opts.isUnique, '--is-unique');
      if (opts.isArchived !== undefined) data.is_archived = parseBoolFlag(opts.isArchived, '--is-archived');

      if (Object.keys(data).length === 0) {
        throw new Error('Nothing to update. Provide at least one flag or --data.');
      }
      body = { data };
    }

    const res = await client.patch<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}`,
      body,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'api_slug' });
      return;
    }
    outputSingle(flattenAttribute(res.data), { format, idField: 'api_slug' });
  });

  // =========================================================================
  // attributes options sub-group
  // =========================================================================
  const options = attributes
    .command('options')
    .description('Manage select options for an attribute');

  // -------------------------------------------------------------------------
  // attributes options list <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    options
      .command('list <attribute>')
      .description('List select options for an attribute'),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);
    const res = await client.get<{ data: any[] }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/options`,
    );
    const items = res.data;

    if (format === 'quiet') {
      for (const opt of items) {
        console.log(opt.id?.option_id || opt.id || '');
      }
      return;
    }

    if (format === 'json') {
      outputList(items, { format, idField: 'id' });
      return;
    }

    outputList(items.map(flattenOption), {
      format,
      columns: ['id', 'title', 'is_archived'],
      idField: 'id',
    });
  });

  // -------------------------------------------------------------------------
  // attributes options create <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    options
      .command('create <attribute>')
      .description('Create a select option for an attribute')
      .option('--title <title>', 'Option title (required when not using --data)')
      .option('--data <json>', 'Full request body JSON or @file.json. Overrides individual flags.'),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      if (!opts.title) {
        throw new Error('--title is required when not using --data.');
      }
      body = { data: { title: opts.title } };
    }

    const res = await client.post<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/options`,
      body,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'id' });
      return;
    }
    outputSingle(flattenOption(res.data), { format, idField: 'id' });
  });

  // -------------------------------------------------------------------------
  // attributes options update <attribute> <option>
  // -------------------------------------------------------------------------
  addTargetOptions(
    options
      .command('update <attribute> <option>')
      .description('Update a select option')
      .option('--title <title>', 'New title')
      .option('--is-archived <bool>', 'Archive or restore (true/false)')
      .option('--data <json>', 'Full request body JSON or @file.json. Overrides individual flags.'),
  ).action(async (attribute: string, option: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      const data: Record<string, any> = {};
      if (opts.title) data.title = opts.title;
      if (opts.isArchived !== undefined) data.is_archived = parseBoolFlag(opts.isArchived, '--is-archived');

      if (Object.keys(data).length === 0) {
        throw new Error('Nothing to update. Provide at least one flag or --data.');
      }
      body = { data };
    }

    const res = await client.patch<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/options/${encodeURIComponent(option)}`,
      body,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'id' });
      return;
    }
    outputSingle(flattenOption(res.data), { format, idField: 'id' });
  });

  // =========================================================================
  // attributes statuses sub-group
  // =========================================================================
  const statuses = attributes
    .command('statuses')
    .description('Manage status values for a status-type attribute');

  // -------------------------------------------------------------------------
  // attributes statuses list <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    statuses
      .command('list <attribute>')
      .description('List statuses for a status-type attribute'),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);
    const res = await client.get<{ data: any[] }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/statuses`,
    );
    const items = res.data;

    if (format === 'quiet') {
      for (const s of items) {
        console.log(s.id?.status_id || s.id || '');
      }
      return;
    }

    if (format === 'json') {
      outputList(items, { format, idField: 'id' });
      return;
    }

    outputList(items.map(flattenStatus), {
      format,
      columns: ['id', 'title', 'celebration_enabled', 'target_time_in_status', 'is_archived'],
      idField: 'id',
    });
  });

  // -------------------------------------------------------------------------
  // attributes statuses create <attribute>
  // -------------------------------------------------------------------------
  addTargetOptions(
    statuses
      .command('create <attribute>')
      .description('Create a status value for a status-type attribute')
      .option('--title <title>', 'Status title (required when not using --data)')
      .option('--celebration-enabled', 'Enable celebration effect on arrival')
      .option('--target-time <duration>', 'Target time as ISO-8601 duration (e.g. P1D)')
      .option('--data <json>', 'Full request body JSON or @file.json. Overrides individual flags.'),
  ).action(async (attribute: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      if (!opts.title) {
        throw new Error('--title is required when not using --data.');
      }
      const data: Record<string, any> = { title: opts.title };
      if (opts.celebrationEnabled) data.celebration_enabled = true;
      if (opts.targetTime) data.target_time_in_status = opts.targetTime;
      body = { data };
    }

    const res = await client.post<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/statuses`,
      body,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'id' });
      return;
    }
    outputSingle(flattenStatus(res.data), { format, idField: 'id' });
  });

  // -------------------------------------------------------------------------
  // attributes statuses update <attribute> <status>
  // -------------------------------------------------------------------------
  addTargetOptions(
    statuses
      .command('update <attribute> <status>')
      .description('Update a status value')
      .option('--title <title>', 'New title')
      .option('--celebration-enabled <bool>', 'Enable/disable celebration effect (true/false)')
      .option('--target-time <duration>', 'Target time as ISO-8601 duration (e.g. P1D)')
      .option('--is-archived <bool>', 'Archive or restore (true/false)')
      .option('--data <json>', 'Full request body JSON or @file.json. Overrides individual flags.'),
  ).action(async (attribute: string, status: string, _options: any, command: Command) => {
    const opts = command.optsWithGlobals();
    const client = new AttioClient(opts.apiKey, opts.debug);
    const format: OutputFormat = detectFormat(opts);

    const base = resolveTargetPath(opts);

    let body: any;
    if (opts.data) {
      body = parseJsonInput(opts.data);
    } else {
      const data: Record<string, any> = {};
      if (opts.title) data.title = opts.title;
      if (opts.celebrationEnabled !== undefined)
        data.celebration_enabled = parseBoolFlag(opts.celebrationEnabled, '--celebration-enabled');
      if (opts.targetTime !== undefined) data.target_time_in_status = opts.targetTime;
      if (opts.isArchived !== undefined) data.is_archived = parseBoolFlag(opts.isArchived, '--is-archived');

      if (Object.keys(data).length === 0) {
        throw new Error('Nothing to update. Provide at least one flag or --data.');
      }
      body = { data };
    }

    const res = await client.patch<{ data: any }>(
      `${base}/attributes/${encodeURIComponent(attribute)}/statuses/${encodeURIComponent(status)}`,
      body,
    );

    if (format === 'json') {
      outputSingle(res.data, { format, idField: 'id' });
      return;
    }
    outputSingle(flattenStatus(res.data), { format, idField: 'id' });
  });
}
