import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { A2uiSurfaces } from './A2ui';
import {
  formatEur,
  SliceClient,
  type A2uiAction,
  type A2uiServerMessage,
  type Campaign,
  type CartLine,
  type MenuItem,
  type NearbyPizzeria,
  type OrderStatus,
  type OrderView,
  type Quote,
} from '@slice/shared';

const api = new SliceClient('');
// Dev-only: lets the demo play kitchen + courier from the tracker. Never ship a partner key to browsers.
const demoStaff = import.meta.env.DEV ? new SliceClient('', { partnerKey: import.meta.env.VITE_PARTNER_KEY ?? 'dev-partner-key' }) : null;

interface Spot {
  label: string;
  addressLine: string;
  lat: number;
  lng: number;
}

const SPOTS: Spot[] = [
  { label: 'Rosenthaler Platz', addressLine: 'Weinbergsweg 3, 10119 Berlin', lat: 52.5302, lng: 13.4011 },
  { label: 'Kottbusser Tor', addressLine: 'Skalitzer Str. 134, 10999 Berlin', lat: 52.4993, lng: 13.4184 },
  { label: 'Savignyplatz', addressLine: 'Grolmanstraße 28, 10623 Berlin', lat: 52.5062, lng: 13.3216 },
  { label: 'Marienplatz, Munich', addressLine: 'Marienplatz 1, 80331 München', lat: 48.1374, lng: 11.5755 },
];

const STAGES: Array<{ status: OrderStatus[]; label: string; hint: string }> = [
  { status: ['received', 'routed', 'payment_authorized'], label: 'Finding your oven', hint: 'Sent to the closest kitchen with room' },
  { status: ['accepted', 'preparing'], label: 'In the oven', hint: 'Stretched, topped, 90 seconds at 450°' },
  { status: ['ready'], label: 'Boxed', hint: 'Waiting for the courier' },
  { status: ['out_for_delivery'], label: 'On the way', hint: 'Riding to you now' },
  { status: ['delivered'], label: 'Delivered', hint: 'Buon appetito' },
];

const stageIndex = (s: OrderStatus) => STAGES.findIndex((st) => st.status.includes(s));

export function App() {
  const [spot, setSpot] = useState<Spot>(SPOTS[0]!);
  const [kitchens, setKitchens] = useState<NearbyPizzeria[] | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [orderId, setOrderId] = useState<string | null>(() => new URLSearchParams(location.search).get('order'));
  const [error, setError] = useState<string | null>(null);

  const kitchen = kitchens?.[0] ?? null;
  const lines: CartLine[] = useMemo(
    () => Object.entries(cart).filter(([, q]) => q > 0).map(([sku, qty]) => ({ sku, qty })),
    [cart],
  );

  useEffect(() => {
    setKitchens(null);
    setError(null);
    api.nearest(spot.lat, spot.lng, 3).then((r) => setKitchens(r.pizzerias)).catch((e) => setError(e.message));
  }, [spot]);

  useEffect(() => {
    api.menu(kitchen?.id).then((r) => setMenu(r.items)).catch((e) => setError(e.message));
  }, [kitchen?.id]);

  useEffect(() => {
    api.campaigns(true).then((r) => setCampaigns(r.campaigns)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!lines.length || !kitchen) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => {
      api.quote(spot.lat, spot.lng, lines).then((r) => setQuote(r.quote)).catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [lines, spot, kitchen]);

  const add = (sku: string, delta: number) => setCart((c) => ({ ...c, [sku]: Math.max(0, (c[sku] ?? 0) + delta) }));

  const onPlaced = (id: string) => {
    setOrderId(id);
    setCart({});
    history.replaceState(null, '', `?order=${id}`);
  };

  const campaign = campaigns[0];

  return (
    <div className="page">
      <header className="bar">
        <div className="brand">
          <span className="logo">Slice</span>
          <span className="brand-sub">Network</span>
        </div>
        <label className="deliver">
          <span>Deliver to</span>
          <select
            value={spot.label}
            onChange={(e) => setSpot(SPOTS.find((s) => s.label === e.target.value) ?? SPOTS[0]!)}
          >
            {SPOTS.map((s) => (
              <option key={s.label}>{s.label}</option>
            ))}
          </select>
        </label>
      </header>

      <section className="hero">
        <h1>
          Pizza from the
          <br />
          nearest oven.
        </h1>
        <KitchenLine kitchens={kitchens} />
        {campaign && (
          <p className="promo">
            <strong>{campaign.name}</strong>: {campaign.percentOff}% off {campaign.skus ? 'pizzas' : 'everything'} until{' '}
            {new Date(campaign.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.
          </p>
        )}
      </section>

      <AdSlot spot={spot} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <main className="layout">
        <section aria-label="Menu" className="menu">
          {(['pizza', 'side', 'drink', 'dessert'] as const).map((cat) => {
            const items = menu.filter((m) => m.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat} className="menu-group">
                <h2>{cat === 'pizza' ? 'Pizzas' : cat === 'side' ? 'On the side' : cat === 'drink' ? 'Drinks' : 'Something sweet'}</h2>
                <ul>
                  {items.map((m) => (
                    <li key={m.sku} className="item">
                      <div>
                        <h3>{m.name}</h3>
                        <p>{m.description}</p>
                        {m.tags.length > 0 && <p className="tags">{m.tags.join(', ')}</p>}
                      </div>
                      <div className="item-buy">
                        <span className="price">{formatEur(m.basePriceCents)}</span>
                        {cart[m.sku] ? (
                          <span className="stepper">
                            <button onClick={() => add(m.sku, -1)} aria-label={`Remove one ${m.name}`}>
                              −
                            </button>
                            <span aria-live="polite">{cart[m.sku]}</span>
                            <button onClick={() => add(m.sku, 1)} aria-label={`Add one more ${m.name}`}>
                              +
                            </button>
                          </span>
                        ) : (
                          <button className="add" onClick={() => add(m.sku, 1)} disabled={!kitchen}>
                            Add
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>

        <aside className="side" id="order">
          {orderId ? (
            <Ticket orderId={orderId} onNew={() => { setOrderId(null); history.replaceState(null, '', location.pathname); }} />
          ) : (
            <Checkout spot={spot} lines={lines} menu={menu} quote={quote} disabled={!kitchen} onPlaced={onPlaced} onError={setError} />
          )}
        </aside>
      </main>

      {!orderId && quote && (
        <a href="#order" className="mobile-cart">
          View order ({lines.reduce((n, l) => n + l.qty, 0)}) {formatEur(quote.totalCents)}
        </a>
      )}
      <Assistant spot={spot} />
    </div>
  );
}

function KitchenLine({ kitchens }: { kitchens: NearbyPizzeria[] | null }) {
  if (!kitchens) return <p className="kitchen-line">Looking for kitchens near you…</p>;
  const k = kitchens[0];
  if (!k) return <p className="kitchen-line">No kitchen delivers here yet. We've noted the interest.</p>;
  return (
    <p className="kitchen-line">
      <strong>{k.name}</strong> is{' '}
      {k.distanceKm} km away — about <strong>{k.etaMinutes} minutes</strong> to your door.
      {kitchens.length > 1 && <span className="backup"> If it's busy, {kitchens[1]!.name} takes over.</span>}
    </p>
  );
}

function Checkout(props: {
  spot: Spot;
  lines: CartLine[];
  menu: MenuItem[];
  quote: Quote | null;
  disabled: boolean;
  onPlaced: (id: string) => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState(props.spot.addressLine);
  const [sms, setSms] = useState(true);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAddress(props.spot.addressLine);
  }, [props.spot]);

  const q = props.quote;
  const [offers, setOffers] = useState<{ ui: A2uiServerMessage[]; asked: number; answered: number } | null>(null);
  const [competing, setCompeting] = useState(false);

  /** Let every nearby kitchen bid for this cart; the customer picks one of the themed offers. */
  const compete = async () => {
    setCompeting(true);
    try {
      const r = await api.chat({ tenant: 'slice', message: `get offers for ${props.lines.map((l) => `${l.qty} ${l.sku.replace(/-/g, ' ')}`).join(' and ')}`, context: { location: { lat: props.spot.lat, lng: props.spot.lng, addressLine: address }, source: 'web' } });
      const asked = (r.toolCalls[0]?.result as { providersAsked?: number })?.providersAsked ?? 0;
      setOffers({ ui: r.ui as A2uiServerMessage[], asked, answered: asked });
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setCompeting(false);
    }
  };
  const chooseOffer = async (a: A2uiAction) => {
    if (!name || !phone) return props.onError('Add your name and phone first, then pick an offer.');
    try {
      const r = await api.acceptOffer(String(a.context.offerId), { name, phone, addressLine: address });
      props.onPlaced(r.orderId);
    } catch (err) {
      props.onError((err as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.placeOrder(
        {
          customer: { name, phone, marketingConsent: marketing },
          delivery: { lat: props.spot.lat, lng: props.spot.lng, addressLine: address },
          items: props.lines,
          channel: 'web',
          notifyBy: sms ? ['sms', 'push'] : ['push'],
        },
        crypto.randomUUID(),
      );
      props.onPlaced(res.orderId);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!props.lines.length) {
    return (
      <div className="cart empty">
        <h2>Your order</h2>
        <p>Add a pizza and we'll send it to the closest oven with room.</p>
      </div>
    );
  }

  return (
    <form className="cart" onSubmit={submit}>
      <h2>Your order</h2>
      <ul className="cart-lines">
        {(q?.lines ?? props.lines.map((l) => ({ ...l, name: props.menu.find((m) => m.sku === l.sku)?.name ?? l.sku, lineTotalCents: 0 }))).map((l) => (
          <li key={l.sku}>
            <span>
              {l.qty}× {l.name}
            </span>
            <span>{l.lineTotalCents ? formatEur(l.lineTotalCents) : ''}</span>
          </li>
        ))}
      </ul>
      {q && (
        <dl className="sums">
          {q.discountCents > 0 && (
            <>
              <dt>{q.campaignCode}</dt>
              <dd>−{formatEur(q.discountCents)}</dd>
            </>
          )}
          <dt>Delivery{q.experimentVariant === 'treatment' ? ' (fast-lane price)' : ''}</dt>
          <dd>{q.deliveryFeeCents ? formatEur(q.deliveryFeeCents) : 'Free'}</dd>
          <dt className="total">Total</dt>
          <dd className="total">{formatEur(q.totalCents)}</dd>
        </dl>
      )}
      <label>
        Name
        <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>
      <label>
        Phone
        <input required value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="+49 …" />
      </label>
      <label>
        Address
        <input required value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
      </label>
      <label className="check">
        <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> Text me when it's on the way
      </label>
      <label className="check">
        <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /> Send me seasonal offers
      </label>
      <button className="primary" disabled={busy || props.disabled || !q}>
        {busy ? 'Placing order…' : q ? `Order for ${formatEur(q.totalCents)}` : 'Order'}
      </button>
      <button type="button" className="compete" onClick={compete} disabled={competing || props.disabled}>
        {competing ? 'Asking nearby kitchens…' : 'Let nearby kitchens compete'}
      </button>
      {offers && (
        <div className="offers">
          <p className="fine">{offers.asked} kitchens asked. Pick one (name and phone above are used):</p>
          <A2uiSurfaces messages={offers.ui} onAction={chooseOffer} />
        </div>
      )}
      <p className="fine">We hold the amount now and charge it when the order arrives.</p>
    </form>
  );
}

function Ticket({ orderId, onNew }: { orderId: string; onNew: () => void }) {
  const [view, setView] = useState<OrderView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => api.order(orderId).then(setView).catch((e) => setErr(e.message)), [orderId]);
  // Live updates from the order workflow over Server-Sent Events (courier GPS included).
  useEffect(() => {
    refresh();
    const es = new EventSource(`/v1/orders/${encodeURIComponent(orderId)}/stream`);
    es.addEventListener('order', (e) => setView(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => es.close();
    return () => es.close();
  }, [orderId, refresh]);

  if (err) return <div className="ticket"><p>{err}</p><button onClick={onNew}>Start a new order</button></div>;
  if (!view) return <div className="ticket"><p>Loading your order…</p></div>;

  const idx = stageIndex(view.status);
  const ended = view.status === 'cancelled' || view.status === 'failed';
  const cancellable = !ended && idx >= 0 && idx < 3;

  const advance = async () => {
    if (!demoStaff) return;
    const s = view.status;
    if (s === 'routed' || s === 'payment_authorized') await demoStaff.kitchen(orderId, 'accept', undefined, view.pizzeriaId ?? undefined);
    else if (s === 'accepted' || s === 'preparing') await demoStaff.kitchen(orderId, 'ready', undefined, view.pizzeriaId ?? undefined);
    else if (s === 'ready') await demoStaff.delivery(orderId, 'picked_up');
    else if (s === 'out_for_delivery') await demoStaff.delivery(orderId, 'delivered');
    refresh();
  };

  return (
    <div className="ticket" aria-live="polite">
      <div className="ticket-head">
        <span className="ticket-brand">{view.brandName ?? 'Slice Network'}</span>
        <span className="ticket-no">#{orderId.slice(-6)}</span>
      </div>
      <p className="ticket-kitchen">{view.pizzeriaName ?? 'Choosing a kitchen…'}</p>
      {view.attemptedPizzerias.length > 1 && !ended && (
        <p className="ticket-note">The first kitchen was full, so the next-closest one picked up your order.</p>
      )}
      {ended ? (
        <p className="ticket-ended">
          {view.status === 'cancelled' ? 'Cancelled. Your payment was released.' : `We couldn't complete this order (${view.failureReason}). You weren't charged.`}
        </p>
      ) : (
        <ol className="stages">
          {STAGES.map((st, i) => (
            <li key={st.label} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
              <span className="stage-label">{st.label}</span>
              {i === idx && <span className="stage-hint">{st.hint}</span>}
            </li>
          ))}
        </ol>
      )}
      {view.tracking && view.status === 'out_for_delivery' && (
        <div className="courier">
          <div className="courier-bar">
            <span style={{ width: `${Math.round(view.tracking.progress * 100)}%` }} />
          </div>
          <p>
            Courier {view.tracking.remainingKm} km away, about {view.tracking.etaMinutes} min
          </p>
        </div>
      )}
      {view.quote && (
        <p className="ticket-total">
          {view.quote.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
          <strong>{formatEur(view.quote.totalCents)}</strong>
        </p>
      )}
      <div className="ticket-actions">
        {cancellable && <button onClick={() => api.cancel(orderId).then(refresh).catch((e) => setErr(e.message))}>Cancel order</button>}
        {(view.status === 'delivered' || ended) && (
          <button onClick={() => window.dispatchEvent(new CustomEvent('slice:help', { detail: `I have a problem with my order ${orderId}` }))}>Get help</button>
        )}
        {demoStaff && !ended && view.status !== 'delivered' && (
          <button className="demo" onClick={advance} title="Plays the kitchen and courier (dev only)">
            Play next step (demo)
          </button>
        )}
        {(ended || view.status === 'delivered') && <button onClick={onNew}>Order again</button>}
      </div>
    </div>
  );
}

const TENANTS = [
  { id: 'slice', label: 'Slice pizza' },
  { id: 'flexgym', label: 'FlexGym' },
  { id: 'nearby', label: 'Anything nearby' },
];

/** The same deep agent for any business; answers come with themed A2UI surfaces you can tap. */
function Assistant({ spot }: { spot: Spot }) {
  const [open, setOpen] = useState(false);
  const [tenant, setTenant] = useState('slice');
  const [sessionId] = useState(() => `web-${crypto.randomUUID()}`);
  const [msgs, setMsgs] = useState<Array<{ role: 'user' | 'assistant'; content: string; ui?: A2uiServerMessage[] }>>([
    { role: 'assistant', content: 'Hi! Ask for offers, a class, the menu, or tell me if something went wrong.' },
  ]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, open]);

  const turn = async (input: { message?: string; action?: A2uiAction }, shown: string) => {
    setMsgs((m) => [...m, { role: 'user', content: shown }]);
    setBusy(true);
    try {
      const r = await api.chat({ tenant, sessionId: `${sessionId}-${tenant}`, ...input, context: { location: { lat: spot.lat, lng: spot.lng, addressLine: spot.addressLine }, source: 'web', a2ui: true } });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, ui: r.ui as A2uiServerMessage[] }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: 'assistant', content: `That didn't go through: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onHelp = (e: Event) => {
      setOpen(true);
      void turn({ message: (e as CustomEvent<string>).detail }, (e as CustomEvent<string>).detail);
    };
    window.addEventListener('slice:help', onHelp);
    return () => window.removeEventListener('slice:help', onHelp);
  });

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text.trim();
    setText('');
    await turn({ message: t }, t);
  };

  return (
    <div className={`helper ${open ? 'open' : ''}`}>
      {open && (
        <div className="chat" role="dialog" aria-label="Assistant">
          <div className="chat-tenants" role="tablist">
            {TENANTS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tenant === t.id} className={tenant === t.id ? 'on' : ''} onClick={() => setTenant(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="chat-log">
            {msgs.map((m, i) => (
              <div key={i} className={`msg-wrap ${m.role}`}>
                <p className={`msg ${m.role}`}>{m.content}</p>
                {m.ui && m.ui.length > 0 && <A2uiSurfaces messages={m.ui} onAction={(a) => turn({ action: a }, a.userMessage ?? a.name)} />}
              </div>
            ))}
            {busy && <p className="msg assistant">…</p>}
            <div ref={endRef} />
          </div>
          <form onSubmit={send} className="chat-input">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={tenant === 'flexgym' ? 'Any yoga tonight?' : tenant === 'nearby' ? 'I need running shoes' : 'Get offers for 2 margherita'} aria-label="Message" autoFocus />
            <button disabled={busy}>Send</button>
          </form>
        </div>
      )}
      <button className="assistant-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Close' : 'Ask Slice'}
      </button>
    </div>
  );
}

/** Generated ad for this spot (Thompson-sampled), rendered as an A2UI surface in the advertiser's theme. */
function AdSlot({ spot }: { spot: Spot }) {
  const [ad, setAd] = useState<{ id: string; ui: A2uiServerMessage[] } | null>(null);
  useEffect(() => {
    fetch(`/v1/ads?tenant=slice&lat=${spot.lat}&lng=${spot.lng}`)
      .then((r) => r.json())
      .then((d) => setAd(d.ad ? { id: d.ad.id, ui: d.ui } : null))
      .catch(() => setAd(null));
  }, [spot]);
  if (!ad) return null;
  return (
    <div className="adslot" aria-label="Sponsored">
      <span className="adslot-label">Sponsored</span>
      <A2uiSurfaces
        messages={ad.ui}
        onAction={() => {
          void fetch(`/v1/ads/${ad.id}/click`, { method: 'POST' });
          window.dispatchEvent(new CustomEvent('slice:help', { detail: 'What offers do you have near me?' }));
        }}
      />
    </div>
  );
}
