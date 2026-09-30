// Tasks on a document that must not overlap run one at a time, in the order
// they arrive; each document has its own queue.
export class DocumentQueues {
  #queues = new Map<string, Promise<unknown>>();

  async run<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(documentId) ?? Promise.resolve();
    const run = runAfter(previous, task);
    // The caller receives the task's failure; the queue only waits for it.
    const settled = run.catch(() => null);
    this.#queues.set(documentId, settled);
    try {
      return await run;
    } finally {
      if (this.#queues.get(documentId) === settled) {
        this.#queues.delete(documentId);
      }
    }
  }
}

async function runAfter<T>(previous: Promise<unknown>, task: () => Promise<T>): Promise<T> {
  await previous;
  return task();
}
