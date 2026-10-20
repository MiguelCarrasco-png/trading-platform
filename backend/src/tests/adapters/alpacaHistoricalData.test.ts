jest.mock('../../config/env', () => ({ env: { logLevel: 'error', alpacaDataRequestsPerMinute: 190 } }));

import { AlpacaHistoricalClient } from '../../adapters/alpaca/historicalData';
import { RateLimiter } from '../../utils/rateLimiter';

const START = Date.parse('2026-10-07T14:00:00Z');
const END = START + 5_000;

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function client(fetchImpl: jest.Mock, limiter = new RateLimiter(60_000)) {
  return new AlpacaHistoricalClient({ key: 'k', secret: 's' }, limiter, fetchImpl as unknown as typeof fetch, 'https://data.test/v2');
}

describe('AlpacaHistoricalClient', () => {
  it('pages through every record on the requested feed', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { quotes: [{ t: '2026-10-07T14:00:01.5Z', bp: 1 }], next_page_token: 'p2' }))
      .mockResolvedValueOnce(response(200, { quotes: [{ t: '2026-10-07T14:00:02.123456789Z', bp: 2 }], next_page_token: null }));

    const records = await client(fetchImpl).fetch('quotes', 'SPY', START, END, 'sip');

    expect(records.map((r) => r.bp)).toEqual([1, 2]);
    const [first, second] = fetchImpl.mock.calls.map((c) => new URL(c[0] as string));
    expect(first.pathname).toBe('/v2/stocks/SPY/quotes');
    expect(first.searchParams.get('feed')).toBe('sip');
    expect(first.searchParams.get('start')).toBe('2026-10-07T14:00:00.000Z');
    expect(first.searchParams.get('limit')).toBe('10000');
    expect(second.searchParams.get('page_token')).toBe('p2');
    expect(fetchImpl.mock.calls[0][1].headers['APCA-API-KEY-ID']).toBe('k');
  });

  it('treats the window as half-open, dropping records at its end', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {
      trades: [
        { t: '2026-10-07T14:00:04.999999999Z', p: 1 },
        { t: '2026-10-07T14:00:05Z', p: 2 },
        { t: '2026-10-07T14:00:05.000000500Z', p: 3 },
      ],
    }));
    const records = await client(fetchImpl).fetch('trades', 'SPY', START, END, 'iex');
    expect(records.map((r) => r.p)).toEqual([1]);
    expect(new URL(fetchImpl.mock.calls[0][0] as string).pathname).toBe('/v2/stocks/SPY/trades');
  });

  it('takes a rate-limiter slot for every page', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { quotes: [], next_page_token: 'p2' }))
      .mockResolvedValueOnce(response(200, { quotes: [] }));
    const limiter = new RateLimiter(60_000);
    const schedule = jest.spyOn(limiter, 'schedule');
    await client(fetchImpl, limiter).fetch('quotes', 'SPY', START, END, 'sip');
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("surfaces Alpaca's refusal, e.g. recent SIP data on the free plan", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response(403, { message: 'subscription does not permit querying recent SIP data' }),
    );
    await expect(client(fetchImpl).fetch('quotes', 'SPY', START, END, 'sip')).rejects.toThrow('(403)');
  });
});
