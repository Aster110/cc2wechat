import type { Delivery } from '../interfaces/index.js';

export async function selectDelivery(
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
