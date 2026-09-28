import type { Clearance } from '../src/directory/clearance.ts';
import type { ClearanceStore } from '../src/directory/store.ts';

// Stands for PostgreSQL: remembers what the service adds, and finds it again.
export class MemoryClearanceStore implements ClearanceStore {
  #added: Clearance[] = [];

  get added(): Clearance[] {
    return this.#added;
  }

  async prepare(): Promise<void> {}

  async addMissing(clearances: Clearance[]): Promise<number> {
    this.#added.push(...clearances);
    return clearances.length;
  }

  async clearanceOf(email: string, policy: string): Promise<Clearance | null> {
    return this.#added.find((clearance) => clearance.email === email && clearance.policy === policy) ?? null;
  }

  async list(): Promise<Clearance[]> {
    return [...this.#added];
  }

  async update(clearance: Clearance): Promise<boolean> {
    const index = this.#added.findIndex((entry) => entry.email === clearance.email && entry.policy === clearance.policy);
    if (index === -1) {
      return false;
    }
    this.#added[index] = clearance;
    return true;
  }

  async close(): Promise<void> {}
}
