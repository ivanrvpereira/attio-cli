import { readFileSync } from 'fs';
import { Command } from 'commander';
import { AttioClient } from '../client.js';
import { detectFormat, outputList, outputSingle, type OutputFormat } from '../output.js';

function parseJsonInput(raw: string): any {
  if (raw.startsWith('@')) {
    return JSON.parse(readFileSync(raw.slice(1), 'utf-8'));
  }
  return JSON.parse(raw);
}

export function register(program: Command): void {
  const cmd = program
    .command('lists')
    .description('Manage lists');

  cmd
    .command('list')
    .description('List all lists')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const res = await client.get<{ data: any[] }>('/lists');
      const lists = res.data;

      if (format === 'quiet') {
        for (const l of lists) {
          console.log(l.id?.list_id ?? '');
        }
        return;
      }

      if (format === 'json') {
        outputList(lists, { format });
        return;
      }

      const flat = lists.map((l: any) => ({
        id: l.id?.list_id || '',
        api_slug: l.api_slug || '',
        name: l.name || '',
        parent_object: l.parent_object || '',
      }));

      outputList(flat, {
        format,
        columns: ['id', 'api_slug', 'name', 'parent_object'],
        idField: 'id',
      });
    });

  cmd
    .command('get <list>')
    .description('Get a list by ID or slug')
    .action(async (list: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const res = await client.get<{ data: any }>(`/lists/${list}`);
      const listData = res.data;

      if (format === 'json') {
        outputSingle(listData, { format, idField: 'id' });
        return;
      }

      const flat: Record<string, any> = {
        id: listData.id?.list_id || '',
        api_slug: listData.api_slug || '',
        name: listData.name || '',
        parent_object: listData.parent_object || '',
        workspace_access: listData.workspace_access || '',
        created_by_actor_type: listData.created_by_actor?.type || '',
        created_by_actor_id: listData.created_by_actor?.id || '',
      };

      outputSingle(flat, { format, idField: 'id' });
    });

  cmd
    .command('create')
    .description('Create a new list')
    .requiredOption('--name <name>', 'Human-readable name of the list')
    .requiredOption('--api-slug <slug>', 'Snake-case API slug for the list')
    .requiredOption('--parent-object <object>', 'UUID or slug of the parent object type')
    .option(
      '--workspace-access <level>',
      'Workspace-wide access level: full-access, read-and-write, read-only (omit to keep private)',
    )
    .option(
      '--data <json>',
      'Full request body as JSON or @file.json (overrides all other flags)',
    )
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      let body: Record<string, any>;

      if (opts.data) {
        const parsed = parseJsonInput(opts.data);
        // Accept either raw data shape or pre-wrapped { data: ... }
        body = parsed.data !== undefined ? parsed : { data: parsed };
      } else {
        const data: Record<string, any> = {
          name: opts.name,
          api_slug: opts.apiSlug,
          parent_object: opts.parentObject,
          workspace_access: opts.workspaceAccess ?? null,
          workspace_member_access: [],
        };
        body = { data };
      }

      const res = await client.post<{ data: any }>('/lists', body);
      outputSingle(res.data, { format, idField: 'id' });
    });

  cmd
    .command('views <list>')
    .description('List views for a list')
    .action(async (list: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const res = await client.get<{ data: any[] }>(`/lists/${encodeURIComponent(list)}/views`);
      const views = res.data;

      if (format === 'quiet') {
        for (const v of views) {
          console.log(v.id?.view_id ?? '');
        }
        return;
      }

      if (format === 'json') {
        outputList(views, { format });
        return;
      }

      const flat = views.map((v: any) => ({
        id: v.id?.view_id || '',
        title: v.title || '',
        created_at: v.created_at || '',
      }));

      outputList(flat, {
        format,
        columns: ['id', 'title', 'created_at'],
        idField: 'id',
      });
    });
}
