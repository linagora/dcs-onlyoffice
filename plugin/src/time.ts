// Fails with the message once the promise has not settled in time.
export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const done = new AbortController();
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
    done.signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    done.abort();
  }
}
