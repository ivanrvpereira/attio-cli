import { Command } from 'commander';
import { AttioClient } from '../client.js';
import { detectFormat, outputList, outputSingle, type OutputFormat } from '../output.js';

interface ObjectsListResponse {
  data: Record<string, any>[];
}

interface ObjectGetResponse {
  data: Record<string, any>;
}

export function register(program: Command): void {
  const objects = program
    .command('objects')
    .description('Manage workspace objects');

  objects
    .command('list')
    .description('List all objects in the workspace')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const response = await client.get<ObjectsListResponse>('/objects');
      const items = response.data;

      outputList(items, {
        format,
        columns: ['api_slug', 'singular_noun', 'plural_noun'],
        idField: 'api_slug',
      });
    });

  objects
    .command('get')
    .description('Get details of a specific object')
    .argument('<slug>', 'Object API slug (e.g. people, companies)')
    .action(async function (this: Command, slug: string) {
      const opts = this.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const response = await client.get<ObjectGetResponse>(`/objects/${encodeURIComponent(slug)}`);
      const obj = response.data;

      outputSingle(obj, { format, idField: 'api_slug' });
    });

  objects
    .command('views')
    .description('List views for an object')
    .argument('<object>', 'Object API slug or UUID (e.g. people, companies)')
    .action(async function (this: Command, object: string) {
      const opts = this.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const response = await client.get<{ data: any[] }>(`/objects/${encodeURIComponent(object)}/views`);
      const views = response.data;

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
