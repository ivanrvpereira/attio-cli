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

function flattenMeeting(meeting: any): Record<string, string | number | boolean> {
  return {
    id: meeting.id?.meeting_id || '',
    title: meeting.title || '',
    start: meeting.start || '',
    end: meeting.end || '',
    is_all_day: meeting.is_all_day ?? false,
    participants: Array.isArray(meeting.participants) ? meeting.participants.length : 0,
  };
}

async function listMeetings(opts: any): Promise<any[]> {
  const client = new AttioClient(opts.apiKey, opts.debug);
  const limit = Number(opts.limit) || 50;
  const all = !!opts.all;

  const baseParams = new URLSearchParams();
  baseParams.set('limit', String(limit));
  if (opts.linkedObject) baseParams.set('linked_object', opts.linkedObject);
  if (opts.linkedRecordId) baseParams.set('linked_record_id', opts.linkedRecordId);
  if (opts.participants) baseParams.set('participants', opts.participants);
  if (opts.sort) baseParams.set('sort', opts.sort);
  if (opts.endsFrom) baseParams.set('ends_from', opts.endsFrom);
  if (opts.startsBefore) baseParams.set('starts_before', opts.startsBefore);
  if (opts.timezone) baseParams.set('timezone', opts.timezone);

  const allMeetings: any[] = [];
  let cursor = opts.cursor as string | undefined;

  while (true) {
    const params = new URLSearchParams(baseParams);
    if (cursor) params.set('cursor', cursor);

    const res = await client.get<{ data: any[]; pagination?: { next_cursor?: string | null } }>(
      `/meetings?${params.toString()}`,
    );

    allMeetings.push(...res.data);

    if (!all) break;
    cursor = res.pagination?.next_cursor ?? undefined;
    if (!cursor) break;
  }

  return allMeetings;
}

export function register(program: Command): void {
  const cmd = program
    .command('meetings')
    .description('Manage meetings (Beta API)');

  cmd
    .command('list')
    .description('List meetings (Beta API)')
    .option('--limit <n>', 'Maximum meetings per page', '50')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--all', 'Auto-paginate through all pages')
    .option('--linked-object <object>', 'Filter by linked object slug or ID')
    .option('--linked-record-id <id>', 'Filter by linked record ID')
    .option('--participants <emails>', 'Comma-separated participant email addresses')
    .option('--sort <order>', 'Sort order (e.g. start_asc, start_desc)')
    .option('--ends-from <iso-timestamp>', 'Only include meetings ending after this time')
    .option('--starts-before <iso-timestamp>', 'Only include meetings starting before this time')
    .option('--timezone <tz>', 'Timezone used with date filters (defaults to UTC)')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const format: OutputFormat = detectFormat(opts);

      if (opts.linkedRecordId && !opts.linkedObject) {
        throw new Error('--linked-record-id requires --linked-object.');
      }

      const meetings = await listMeetings(opts);

      if (format === 'quiet') {
        for (const meeting of meetings) {
          console.log(meeting.id?.meeting_id || '');
        }
        return;
      }

      if (format === 'json') {
        outputList(meetings, { format, idField: 'id' });
        return;
      }

      outputList(meetings.map(flattenMeeting), {
        format,
        columns: ['id', 'title', 'start', 'end', 'is_all_day', 'participants'],
        idField: 'id',
      });
    });

  cmd
    .command('get <id>')
    .description('Get a meeting by ID (Beta API)')
    .action(async (id: string, _options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      const res = await client.get<{ data: any }>(`/meetings/${encodeURIComponent(id)}`);
      const meeting = res.data;

      if (format === 'json') {
        outputSingle(meeting, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenMeeting(meeting), { format, idField: 'id' });
    });

  cmd
    .command('create')
    .description('Create a meeting (Beta API)')
    .option('--title <title>', 'Title of the meeting (required unless --data)')
    .option('--description <text>', 'Description of the meeting (required unless --data)')
    .option('--start-at <datetime>', 'Start datetime, ISO 8601 (required unless --data, e.g. 2027-11-27T14:00:00Z)')
    .option('--end-at <datetime>', 'End datetime, ISO 8601 (required unless --data, e.g. 2027-11-27T15:00:00Z)')
    .option('--start-timezone <tz>', 'IANA timezone for start (e.g. America/New_York)')
    .option('--end-timezone <tz>', 'IANA timezone for end (e.g. America/New_York)')
    .option('--all-day', 'Mark as an all-day meeting (start/end treated as dates, not datetimes)')
    .option(
      '--participant <email>',
      'Add a participant by email (repeatable). Format: email or email:organizer:status',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--linked-object <slug>', 'Object slug/UUID for a linked record (use with --linked-record-id)')
    .option('--linked-record-id <uuid>', 'Record UUID to link to this meeting')
    .option('--external-ref <ref>', 'External reference string for deduplication')
    .option('--data <json>', 'Full request body as JSON or @file.json (overrides individual flags)')
    .action(async (_options: any, command: Command) => {
      const opts = command.optsWithGlobals();
      const client = new AttioClient(opts.apiKey, opts.debug);
      const format: OutputFormat = detectFormat(opts);

      let body: any;

      if (opts.data) {
        body = parseJsonInput(opts.data);
      } else {
        const missing: string[] = [];
        if (!opts.title) missing.push('--title');
        if (!opts.description) missing.push('--description');
        if (!opts.startAt) missing.push('--start-at');
        if (!opts.endAt) missing.push('--end-at');
        if (missing.length > 0) {
          throw new Error(
            `Missing required option${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} (or use --data).`,
          );
        }

        const isAllDay = !!opts.allDay;

        const start = isAllDay
          ? { date: opts.startAt }
          : { datetime: opts.startAt, ...(opts.startTimezone ? { timezone: opts.startTimezone } : {}) };

        const end = isAllDay
          ? { date: opts.endAt }
          : { datetime: opts.endAt, ...(opts.endTimezone ? { timezone: opts.endTimezone } : {}) };

        // Parse participants: each value may be plain email, or "email:organizer:status"
        const participants = ((opts.participant as string[]) ?? []).map((raw: string) => {
          const parts = raw.split(':');
          const email_address = parts[0];
          const is_organizer = parts[1] ? parts[1] === 'true' || parts[1] === 'organizer' : false;
          const status = (parts[2] as 'accepted' | 'tentative' | 'declined' | 'pending') || 'pending';
          return { email_address, is_organizer, status };
        });

        if (participants.length === 0) {
          throw new Error('Provide at least one --participant <email> (or use --data for advanced cases).');
        }

        const linked_records: any[] = [];
        if (opts.linkedObject && opts.linkedRecordId) {
          linked_records.push({ object: opts.linkedObject, record_id: opts.linkedRecordId });
        } else if (opts.linkedObject || opts.linkedRecordId) {
          throw new Error('--linked-object and --linked-record-id must be used together.');
        }

        const externalRef = opts.externalRef || `cli-${Date.now()}`;

        const data: Record<string, any> = {
          title: opts.title,
          description: opts.description,
          start,
          end,
          is_all_day: isAllDay,
          participants,
          external_ref: externalRef,
        };

        if (linked_records.length > 0) {
          data.linked_records = linked_records;
        }

        body = { data };
      }

      const res = await client.post<{ data: any }>('/meetings', body);
      const meeting = res.data;

      if (format === 'json') {
        outputSingle(meeting, { format, idField: 'id' });
        return;
      }

      outputSingle(flattenMeeting(meeting), { format, idField: 'id' });
    });
}
