import { describe, it, expect, vi } from 'vitest';

/**
 * Bootstrap 选择逻辑测试
 * 验证 auto 模式按优先级选 delivery + 指定模式 + 全部不可用抛错
 */

// ---- 内联接口 ----

interface CompatResult {
  available: boolean;
  reason?: string;
}

interface Delivery {
  readonly name: string;
  checkCompatibility(): Promise<CompatResult>;
  initialize(config: unknown): Promise<void>;
}

// ---- 简化 bootstrap 逻辑 ----

async function selectDelivery(
  candidates: Delivery[],
  mode: string,
): Promise<Delivery> {
  if (mode !== 'auto') {
    const target = candidates.find(d => d.name === mode);
    if (!target) {
      throw new Error(`Unknown delivery mode: ${mode}`);
    }
    return target;
  }

  for (const candidate of candidates) {
    const result = await candidate.checkCompatibility();
    if (result.available) {
      return candidate;
    }
  }

  throw new Error('No compatible delivery method found');
}

// ---- Helper to create mock deliveries ----

function makeMockDelivery(name: string, available: boolean): Delivery {
  return {
    name,
    checkCompatibility: vi.fn().mockResolvedValue({ available, reason: available ? undefined : `${name} unavailable` }),
    initialize: vi.fn().mockResolvedValue(undefined),
  };
}

// ---- Tests ----

describe('bootstrap — selectDelivery', () => {
  it('auto mode: skips unavailable, picks first available', async () => {
    const d1 = makeMockDelivery('terminal', false);
    const d2 = makeMockDelivery('sdk', true);
    const d3 = makeMockDelivery('pipe', true);

    const selected = await selectDelivery([d1, d2, d3], 'auto');

    expect(selected.name).toBe('sdk');
    expect(d1.checkCompatibility).toHaveBeenCalled();
    expect(d2.checkCompatibility).toHaveBeenCalled();
    // d3 should NOT be checked (short-circuit after d2 is available)
    expect(d3.checkCompatibility).not.toHaveBeenCalled();
  });

  it('auto mode: picks first candidate if all are available', async () => {
    const d1 = makeMockDelivery('terminal', true);
    const d2 = makeMockDelivery('sdk', true);
    const d3 = makeMockDelivery('pipe', true);

    const selected = await selectDelivery([d1, d2, d3], 'auto');

    expect(selected.name).toBe('terminal');
  });

  it('specified mode: directly selects the named delivery', async () => {
    const d1 = makeMockDelivery('terminal', true);
    const d2 = makeMockDelivery('sdk', true);
    const d3 = makeMockDelivery('pipe', true);

    const selected = await selectDelivery([d1, d2, d3], 'sdk');

    expect(selected.name).toBe('sdk');
    // checkCompatibility should NOT be called for specified mode
    expect(d1.checkCompatibility).not.toHaveBeenCalled();
    expect(d2.checkCompatibility).not.toHaveBeenCalled();
  });

  it('auto mode: throws Error when all deliveries are unavailable', async () => {
    const d1 = makeMockDelivery('terminal', false);
    const d2 = makeMockDelivery('sdk', false);
    const d3 = makeMockDelivery('pipe', false);

    await expect(selectDelivery([d1, d2, d3], 'auto')).rejects.toThrow(
      'No compatible delivery method found',
    );
  });

  it('specified mode: throws Error for unknown delivery name', async () => {
    const d1 = makeMockDelivery('terminal', true);
    const d2 = makeMockDelivery('sdk', true);

    await expect(selectDelivery([d1, d2], 'tmux')).rejects.toThrow(
      'Unknown delivery mode: tmux',
    );
  });

  it('auto mode with single candidate that is available', async () => {
    const d1 = makeMockDelivery('pipe', true);

    const selected = await selectDelivery([d1], 'auto');

    expect(selected.name).toBe('pipe');
  });

  it('specified mode: uses delivery even if checkCompatibility would return false (by design)', async () => {
    const d1 = makeMockDelivery('terminal', false);
    const d2 = makeMockDelivery('sdk', false);

    const selected = await selectDelivery([d1, d2], 'sdk');

    expect(selected.name).toBe('sdk');
    // checkCompatibility should NOT be called — specified mode trusts the user
    expect(d1.checkCompatibility).not.toHaveBeenCalled();
    expect(d2.checkCompatibility).not.toHaveBeenCalled();
  });

  it('auto mode with empty candidates list throws Error', async () => {
    await expect(selectDelivery([], 'auto')).rejects.toThrow(
      'No compatible delivery method found',
    );
  });
});
