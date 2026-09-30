import type { FastifyInstance } from 'fastify';
import { forbidden, NO_FRAMING } from './administration.ts';
import { isAdministrator } from './auth/administrators.ts';
import { requireSession } from './auth/routes.ts';
import { isJournalCategory, type Journal, type JournalFilters } from './journal.ts';
import { type JournalQuery, renderJournalPage } from './pages.ts';
import { firstInstant, instantAfter } from './validity-period.ts';

const PAGE_SIZE = 50;

// Administrators read the journal, newest first, filtered by document, by
// person, by period and by category. Nobody else learns from it that a
// document exists, or who works on it.
export function registerJournalAdmin(app: FastifyInstance, journal: Journal): FastifyInstance {
  app.get<{ Querystring: Record<string, unknown> }>('/admin/journal', async (request, reply) => {
    const { user } = requireSession(request);
    if (!isAdministrator(user)) {
      return forbidden(reply);
    }
    const query = journalQueryOf(request.query);
    const page = await journal.page(filtersOf(query), PAGE_SIZE);
    return reply.header('Content-Security-Policy', NO_FRAMING).type('text/html; charset=utf-8').send(renderJournalPage(user, query, page));
  });
  return app;
}

// The filters as the page's form sends them, each empty when left out.
function journalQueryOf(query: Record<string, unknown>): JournalQuery {
  const text = (name: string): string => {
    const value = query[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const category = text('category');
  const before = text('before');
  return {
    document: text('document'),
    person: text('person'),
    from: text('from'),
    through: text('through'),
    category: isJournalCategory(category) ? category : '',
    // An entry's identifier, which a bigint holds.
    before: /^\d{1,18}$/.test(before) ? before : '',
  };
}

// A period covers whole days, UTC, from the first to the last.
function filtersOf(query: JournalQuery): JournalFilters {
  const from = firstInstant(query.from, null);
  const until = instantAfter(query.through, null);
  return {
    document: query.document === '' ? null : query.document,
    person: query.person === '' ? null : query.person,
    from: from === '' ? null : new Date(from),
    until: until === '' ? null : new Date(until),
    category: query.category === '' ? null : query.category,
    before: query.before === '' ? null : query.before,
  };
}
