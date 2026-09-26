import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type Identity, resolveIdentity } from './identity.ts';
import { LabelList } from './LabelList.tsx';
import type { PluginInfo } from './onlyoffice.ts';

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

type IdentityState = { status: 'loading' } | { status: 'unknown' } | { status: 'known'; identity: Identity };

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const [identity, setIdentity] = useState<IdentityState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<IdentityState> => {
      const resolved = await resolveIdentity(await pluginReady);
      return resolved === null ? { status: 'unknown' } : { status: 'known', identity: resolved };
    };
    load()
      .then((state) => {
        if (!cancelled) {
          setIdentity(state);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentity({ status: 'unknown' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pluginReady]);

  return (
    <main class="panel">
      <section class="identity" data-testid="identity" data-source={identity.status === 'known' ? identity.identity.source : undefined}>
        {identity.status === 'loading' && <p class="muted">Connecting…</p>}
        {identity.status === 'unknown' && <p class="muted">Signed-in user unknown</p>}
        {identity.status === 'known' && (
          <>
            <span class="identity-name" data-testid="identity-name">
              {identity.identity.name}
            </span>
            <span class="identity-account" data-testid="identity-account">
              {identity.identity.account}
            </span>
          </>
        )}
      </section>
      <LabelList />
    </main>
  );
}
