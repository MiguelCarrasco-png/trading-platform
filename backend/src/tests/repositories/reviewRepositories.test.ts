jest.mock('../../adapters/supabase/client');
jest.mock('../../config/env', () => ({
  env: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    supabaseServiceRoleKey: 'test-service-key',
    nodeEnv: 'test',
    logLevel: 'error',
  },
}));

import { getSupabaseClient } from '../../adapters/supabase/client';
import { insertStrategyVersion, saveStrategyVersion } from '../../adapters/supabase/reviewRepositories';

const mockRpc = jest.fn();
const mockInsertChain = {
  insert: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  single: jest.fn(),
};
const mockFrom = jest.fn(() => mockInsertChain);

const row = {
  id: 'ver-1',
  strategy_id: 'strat-1',
  version_number: 2,
  config: { symbols: ['SPY'] },
  change_summary: 'tweak',
  created_by: 'user-1',
  created_at: '2026-10-20T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  (getSupabaseClient as jest.Mock).mockReturnValue({ rpc: mockRpc, from: mockFrom });
  mockFrom.mockReturnValue(mockInsertChain);
  mockInsertChain.insert.mockReturnThis();
  mockInsertChain.select.mockReturnThis();
});

describe('saveStrategyVersion', () => {
  const base = { strategyId: 'strat-1', name: 'n', config: {}, changeSummary: 'c', createdBy: 'user-1' };

  it('passes the algorithm version to the database function and maps it back', async () => {
    mockRpc.mockResolvedValue({ data: { ...row, algorithm_version: 4 }, error: null });
    const saved = await saveStrategyVersion({ ...base, algorithmVersion: 4 });
    expect(mockRpc).toHaveBeenCalledWith('save_strategy_version', expect.objectContaining({ p_algorithm_version: 4 }));
    expect(saved.algorithmVersion).toBe(4);
  });

  it('omits the argument when the version is unknown, so the database default applies', async () => {
    mockRpc.mockResolvedValue({ data: { ...row, algorithm_version: null }, error: null });
    const saved = await saveStrategyVersion(base);
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty('p_algorithm_version');
    expect(saved.algorithmVersion).toBeNull();
  });

  it('reads a row from before the column existed as unknown, not zero', async () => {
    mockRpc.mockResolvedValue({ data: row, error: null });
    expect((await saveStrategyVersion(base)).algorithmVersion).toBeNull();
  });

  it('throws when the database call fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(saveStrategyVersion(base)).rejects.toThrow(/saveStrategyVersion failed: boom/);
  });
});

describe('insertStrategyVersion', () => {
  it('stores the algorithm version with the new version', async () => {
    mockInsertChain.single.mockResolvedValue({ data: { ...row, algorithm_version: 3 }, error: null });
    const saved = await insertStrategyVersion({ strategyId: 'strat-1', config: {}, createdBy: 'user-1', algorithmVersion: 3 });
    expect(mockFrom).toHaveBeenCalledWith('strategy_versions');
    expect(mockInsertChain.insert).toHaveBeenCalledWith(expect.objectContaining({ algorithm_version: 3 }));
    expect(saved.algorithmVersion).toBe(3);
  });

  it('stores null when it is not known', async () => {
    mockInsertChain.single.mockResolvedValue({ data: row, error: null });
    await insertStrategyVersion({ strategyId: 'strat-1', config: {}, createdBy: 'user-1' });
    expect(mockInsertChain.insert).toHaveBeenCalledWith(expect.objectContaining({ algorithm_version: null }));
  });
});
