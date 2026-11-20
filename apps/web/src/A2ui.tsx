import type { CSSProperties, ReactNode } from 'react';
import { THEME_METADATA_KEY, type A2uiAction, type A2uiComponent, type A2uiServerMessage, type Theme } from '@slice/shared';

/**
 * A small A2UI v1.0 renderer for the basic catalogue (Column, Row, Card, Text, Button, Divider).
 * Each surface is skinned with the provider theme it carries in createSurface.metadata, so offers
 * from a sneaker shop, a gym and a pizzeria each look like themselves inside one conversation.
 */
interface SurfaceState {
  id: string;
  theme: Theme | null;
  components: Map<string, A2uiComponent>;
}

export function surfacesFrom(messages: A2uiServerMessage[]): SurfaceState[] {
  const out = new Map<string, SurfaceState>();
  for (const m of messages) {
    if ('createSurface' in m) {
      const theme = (m.createSurface.metadata?.[THEME_METADATA_KEY] as Theme | undefined) ?? null;
      out.set(m.createSurface.surfaceId, { id: m.createSurface.surfaceId, theme, components: new Map() });
    } else if ('updateComponents' in m) {
      const s = out.get(m.updateComponents.surfaceId);
      if (s) for (const c of m.updateComponents.components) s.components.set(c.id, c);
    } else if ('deleteSurface' in m) {
      out.delete(m.deleteSurface.surfaceId);
    }
  }
  return [...out.values()];
}

const moodFont: Record<string, string> = {
  playful: "'Bagel Fat One', system-ui, sans-serif",
  bold: "'Arial Black', 'Helvetica Neue', system-ui, sans-serif",
  premium: "Georgia, 'Times New Roman', serif",
  calm: 'inherit',
  neutral: 'inherit',
};

function themeVars(t: Theme | null): CSSProperties {
  if (!t) return {};
  return {
    ['--s-primary' as string]: t.primaryColor ?? 'var(--tomato)',
    ['--s-accent' as string]: t.accentColor ?? 'var(--crust)',
    ['--s-display' as string]: moodFont[t.mood ?? 'neutral'] ?? 'inherit',
  };
}

export function A2uiSurfaces({ messages, onAction }: { messages: A2uiServerMessage[]; onAction: (a: A2uiAction) => void }) {
  const surfaces = surfacesFrom(messages);
  if (!surfaces.length) return null;
  return (
    <div className="a2ui">
      {surfaces.map((s) => (
        <div key={s.id} className={`a2ui-surface mood-${s.theme?.mood ?? 'neutral'}`} style={themeVars(s.theme)}>
          {s.theme?.logoText && <span className="a2ui-logo">{s.theme.logoText}</span>}
          {render(s, 'root', onAction)}
        </div>
      ))}
    </div>
  );
}

function render(s: SurfaceState, id: string, onAction: (a: A2uiAction) => void): ReactNode {
  const c = s.components.get(id);
  if (!c) return null;
  const kids = (ids: unknown) => (ids as string[]).map((k) => <span key={k}>{render(s, k, onAction)}</span>);
  switch (c.component) {
    case 'Column':
      return <div className="a2ui-col">{kids(c.children)}</div>;
    case 'Row':
      return <div className="a2ui-row">{kids(c.children)}</div>;
    case 'Card':
      return <div className="a2ui-card">{render(s, c.child as string, onAction)}</div>;
    case 'Divider':
      return <hr className="a2ui-divider" />;
    case 'Text': {
      const v = String(c.variant ?? 'body');
      const text = typeof c.text === 'string' ? c.text : '';
      return v === 'h1' || v === 'h2' || v === 'h3' ? <p className={`a2ui-${v}`}>{text}</p> : <p className={`a2ui-${v}`}>{text}</p>;
    }
    case 'Button': {
      const ev = (c.action as { event?: { name: string; context: Record<string, unknown>; userMessage?: string } })?.event;
      const label = String(s.components.get(c.child as string)?.text ?? 'OK');
      return (
        <button
          className={`a2ui-btn ${c.variant === 'borderless' ? 'quiet' : ''}`}
          onClick={() =>
            ev &&
            onAction({ name: ev.name, surfaceId: s.id, sourceComponentId: c.id, timestamp: new Date().toISOString(), context: ev.context, userMessage: ev.userMessage ?? label })
          }
        >
          {label}
        </button>
      );
    }
    default:
      return null; // unknown components are skipped, as the spec allows
  }
}
