import { createReadStream, createWriteStream, statSync } from 'fs';
import { basename } from 'path';
import { Command } from 'commander';
import { AttioClient } from '../client.js';
import { resolveApiKey } from '../config.js';
import { AttioApiError } from '../errors.js';
import { detectFormat, outputList, outputSingle, confirm, type OutputFormat } from '../output.js';

const BASE_URL = 'https://api.attio.com/v2';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Flattening helpers
// ---------------------------------------------------------------------------

function flattenFileEntry(item: any): Record<string, string | number> {
  const id = item.id?.file_id || '';
  const fileType: string = item.file_type || '';
  const name: string = item.name || item.external_provider_file_id || '';
  const contentSize: number | string = item.content_size ?? '';
  const createdAt: string = item.created_at || '';
  const objectSlug: string = item.object_slug || '';
  const recordId: string = item.record_id || '';
  const storageProvider: string = item.storage_provider || '';
  const parentFolderId: string = item.parent_folder_id || '';

  return {
    id,
    file_type: fileType,
    name,
    size_bytes: contentSize,
    created_at: createdAt,
    parent_object: objectSlug,
    parent_record_id: recordId,
    storage_provider: storageProvider,
    parent_folder_id: parentFolderId,
  };
}

// ---------------------------------------------------------------------------
// Direct-fetch helpers (used for multipart upload and binary download)
// ---------------------------------------------------------------------------

async function directFetch(method: string, path: string, init: RequestInit): Promise<Response> {
  const apiKey = resolveApiKey();
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(url, { ...init, headers });
  return response;
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new AttioApiError(response.status, 'unknown_error', response.statusText);
  }
  const errorType = json?.type ?? 'unknown_error';
  const errorDetail = json?.message ?? json?.detail ?? response.statusText;
  throw new AttioApiError(response.status, errorType, errorDetail);
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const cmd = program
    .command('files')
    .description('Manage files and folders (beta)');

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  cmd
    .command('list')
    .description('List files and folders for a record')
    .requiredOption('--object <slug>', 'Object slug or ID (required)')
    .requiredOption('--record-id <uuid>', 'Record UUID to filter files by (required)')
    .option('--storage-provider <provider>', 'Filter by storage provider (attio, dropbox, box, google-drive, microsoft-onedrive)')
    .option('--parent-folder-id <uuid>', 'Filter by parent folder ID')
    .option('--limit <n>', 'Maximum number of files to return (1–200)', '50')
    .option('--cursor <cursor>', 'Pagination cursor from a previous response')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const params = new URLSearchParams();
      params.set('object', opts.object);
      params.set('record_id', opts.recordId);
      if (opts.storageProvider) params.set('storage_provider', opts.storageProvider);
      if (opts.parentFolderId) params.set('parent_folder_id', opts.parentFolderId);
      params.set('limit', String(Math.min(200, Math.max(1, Number(opts.limit) || 50))));
      if (opts.cursor) params.set('cursor', opts.cursor);

      const res = await client.get<{ data: any[]; pagination: { next_cursor: string | null } }>(
        `/files?${params.toString()}`
      );
      const items = res.data;

      if (format === 'quiet') {
        for (const item of items) {
          console.log(item.id?.file_id ?? '');
        }
        return;
      }

      if (format === 'json') {
        outputList(items, { format });
        return;
      }

      outputList(items.map(flattenFileEntry), {
        format,
        columns: ['id', 'file_type', 'name', 'size_bytes', 'storage_provider', 'parent_object', 'parent_record_id', 'created_at'],
        idField: 'id',
      });

      if (res.pagination?.next_cursor) {
        process.stderr.write(`\nNext page cursor: ${res.pagination.next_cursor}\n`);
      }
    });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------
  cmd
    .command('get <id>')
    .description('Get a file or folder by ID')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const res = await client.get<{ data: any }>(`/files/${encodeURIComponent(id)}`);
      const item = res.data;

      if (format === 'json') {
        outputSingle(item, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenFileEntry(item), { format, idField: 'id' });
    });

  // -------------------------------------------------------------------------
  // create  (native folder, connected-file, or connected-folder — JSON body)
  // -------------------------------------------------------------------------
  cmd
    .command('create')
    .description('Create a folder or connected file/folder entry on a record')
    .requiredOption('--object <slug>', 'Object slug or ID (required)')
    .requiredOption('--record-id <uuid>', 'Record UUID (required)')
    .requiredOption(
      '--file-type <type>',
      'Entry type: folder | connected-file | connected-folder (required)',
    )
    .option('--name <name>', 'Folder name (required for file-type=folder)')
    .option('--storage-provider <provider>', 'External storage provider (required for connected-* types)')
    .option('--external-provider-file-id <id>', 'File/folder ID in the external provider (required for connected-* types)')
    .option('--microsoft-drive-id <id>', 'Microsoft drive ID (only for microsoft-onedrive)')
    .option('--parent-folder-id <uuid>', 'Parent folder ID (optional)')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const fileType: string = opts.fileType;
      const validTypes = ['folder', 'connected-file', 'connected-folder'];
      if (!validTypes.includes(fileType)) {
        throw new Error(`--file-type must be one of: ${validTypes.join(', ')}`);
      }

      const body: Record<string, any> = {
        object: opts.object,
        record_id: opts.recordId,
        file_type: fileType,
      };

      if (fileType === 'folder') {
        if (!opts.name) throw new Error('--name is required for file-type=folder');
        body.name = opts.name;
        if (opts.parentFolderId) body.parent_folder_id = opts.parentFolderId;
      } else {
        // connected-file or connected-folder
        if (!opts.storageProvider) throw new Error('--storage-provider is required for connected-* types');
        if (!opts.externalProviderFileId) throw new Error('--external-provider-file-id is required for connected-* types');
        body.storage_provider = opts.storageProvider;
        body.external_provider_file_id = opts.externalProviderFileId;
        if (opts.microsoftDriveId !== undefined) body.microsoft_drive_id = opts.microsoftDriveId;
      }

      const res = await client.post<{ data: any }>('/files', body);
      const item = res.data;

      if (format === 'json') {
        outputSingle(item, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenFileEntry(item), { format, idField: 'id' });
    });

  // -------------------------------------------------------------------------
  // upload  (multipart/form-data — direct fetch, not AttioClient)
  // -------------------------------------------------------------------------
  cmd
    .command('upload <file-path>')
    .description('Upload a file to native Attio storage for a record (max 50 MB)')
    .requiredOption('--object <slug>', 'Object slug or ID (required)')
    .requiredOption('--record-id <uuid>', 'Record UUID (required)')
    .option('--parent-folder-id <uuid>', 'Parent folder ID (optional)')
    .action(async (filePath: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      // Validate file size before sending
      let fileSize: number;
      try {
        fileSize = statSync(filePath).size;
      } catch (err: any) {
        throw new Error(`Cannot read file: ${filePath} — ${err.message}`);
      }
      if (fileSize > MAX_UPLOAD_BYTES) {
        throw new Error(`File exceeds the 50 MB maximum (${fileSize} bytes).`);
      }

      const fileName = basename(filePath);
      const fileData = createReadStream(filePath);

      // Build multipart/form-data using Node 18+ built-in FormData
      const formData = new FormData();

      // Read file into a buffer so we can wrap it in a Blob
      const chunks: Buffer[] = [];
      for await (const chunk of fileData) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);
      const fileBlob = new Blob([fileBuffer]);

      formData.append('file', fileBlob, fileName);
      formData.append('object', opts.object as string);
      formData.append('record_id', opts.recordId as string);
      if (opts.parentFolderId) {
        formData.append('parent_folder_id', opts.parentFolderId as string);
      }

      const response = await directFetch('POST', '/files/upload', {
        method: 'POST',
        body: formData,
      });

      await throwIfNotOk(response);

      const json = await response.json() as { data: any };
      const item = json.data;

      if (format === 'json') {
        outputSingle(item, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenFileEntry(item), { format, idField: 'id' });
    });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------
  cmd
    .command('delete <id>')
    .description('Delete a file or folder by ID (deleting a folder removes all descendants)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();

      if (!opts.yes) {
        const ok = await confirm(`Delete file/folder ${id}?`);
        if (!ok) {
          console.error('Aborted.');
          return;
        }
      }

      const client = new AttioClient(opts.apiKey, opts.debug);
      await client.delete(`/files/${encodeURIComponent(id)}`);
      console.error('Deleted.');
    });

  // -------------------------------------------------------------------------
  // download
  // -------------------------------------------------------------------------
  cmd
    .command('download <id>')
    .description('Download a file by ID (follows redirect to signed URL)')
    .option('--output <path>', 'Write downloaded content to a file instead of stdout')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();

      // The API returns a 302 redirect to a signed URL.
      // fetch() follows redirects by default, so we'll get the final binary response.
      const response = await directFetch('GET', `/files/${encodeURIComponent(id)}/download`, {
        method: 'GET',
      });

      await throwIfNotOk(response);

      if (!response.body) {
        throw new Error('No response body returned from download endpoint.');
      }

      const outputPath: string | undefined = opts.output;

      if (outputPath) {
        const writer = createWriteStream(outputPath);
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(Buffer.from(value));
          }
        } finally {
          writer.end();
          reader.releaseLock();
        }
        process.stderr.write(`Downloaded to ${outputPath}\n`);
      } else {
        // Stream to stdout
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            process.stdout.write(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }
    });
}
