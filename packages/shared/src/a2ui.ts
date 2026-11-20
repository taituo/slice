/**
 * A2UI (Agent-to-UI) v1.0 message builders. Agents describe UI as data; every client (web, React
 * Native, XR, partner apps over A2A) renders it with its own native components.
 *
 * Theming: v1.0 has no `theme` on createSurface, so each surface carries the provider's look in
 * `createSurface.metadata["slice.theme"]`. Renderers that know it re-skin the surface (a gym's
 * calm green, a sneaker shop's neon); renderers that don't simply ignore it.
 */

export const A2UI_VERSION = 'v1.0';
export const A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v1.0';
export const A2UI_MIME = 'application/a2ui+json';
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
export const THEME_METADATA_KEY = 'slice.theme';

export interface Theme {
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  radius?: number;
  mood?: 'playful' | 'calm' | 'bold' | 'premium' | 'neutral';
  logoText?: string;
}

export type DataBinding = { '@path': string };
export type Dyn<T> = T | DataBinding;

export interface A2uiComponent {
  id: string;
  component: string;
  [prop: string]: unknown;
}

export type A2uiServerMessage =
  | { version: string; createSurface: { surfaceId: string; catalogId: string; metadata?: Record<string, unknown>; dataModel?: unknown } }
  | { version: string; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: string; updateDataModel: { surfaceId: string; path?: string; value: unknown } }
  | { version: string; deleteSurface: { surfaceId: string } };

/** Renderer → agent event (sent back in a DataPart with mimeType application/a2ui+json). */
export interface A2uiAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
  userMessage?: string;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** UAX #31-style identifier: letters, digits, underscore; never starts with a digit. */
export function a2uiId(raw: string): string {
  const id = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return ID_RE.test(id) ? id : `c_${id}`;
}

export class Surface {
  private components: A2uiComponent[] = [];
  readonly surfaceId: string;
  constructor(surfaceId: string, private readonly theme?: Theme) {
    this.surfaceId = a2uiId(surfaceId);
  }
  private add(c: A2uiComponent): string {
    this.components.push(c);
    return c.id;
  }
  text(id: string, text: Dyn<string>, variant: 'h1' | 'h2' | 'h3' | 'body' | 'caption' = 'body') {
    return this.add({ id: a2uiId(id), component: 'Text', text, variant });
  }
  column(id: string, children: string[]) {
    return this.add({ id: a2uiId(id), component: 'Column', children });
  }
  row(id: string, children: string[], justify: 'start' | 'spaceBetween' | 'end' = 'spaceBetween') {
    return this.add({ id: a2uiId(id), component: 'Row', children, justify, align: 'center' });
  }
  card(id: string, child: string) {
    return this.add({ id: a2uiId(id), component: 'Card', child });
  }
  divider(id: string) {
    return this.add({ id: a2uiId(id), component: 'Divider', axis: 'horizontal' });
  }
  /** A button that sends an `action` event back to the agent. */
  button(id: string, label: string, actionName: string, context: Record<string, unknown>, variant: 'primary' | 'borderless' = 'primary') {
    const labelId = this.text(`${id}_label`, label);
    return this.add({
      id: a2uiId(id),
      component: 'Button',
      child: labelId,
      variant,
      action: { event: { name: actionName, context, userMessage: label } },
    });
  }
  /** Messages: createSurface (with theme metadata) + updateComponents. The component with id `root` mounts first. */
  build(rootChildren: string[]): A2uiServerMessage[] {
    this.add({ id: 'root', component: 'Column', children: rootChildren });
    return [
      {
        version: A2UI_VERSION,
        createSurface: {
          surfaceId: this.surfaceId,
          catalogId: A2UI_BASIC_CATALOG,
          ...(this.theme ? { metadata: { [THEME_METADATA_KEY]: this.theme } } : {}),
        },
      },
      { version: A2UI_VERSION, updateComponents: { surfaceId: this.surfaceId, components: this.components } },
    ];
  }
}

/** Structural validation used by tests and before anything leaves the server. */
export function validateA2ui(messages: A2uiServerMessage[]): string[] {
  const errors: string[] = [];
  const known = new Map<string, Set<string>>();
  for (const m of messages) {
    if (m.version !== A2UI_VERSION) errors.push(`bad version ${m.version}`);
    if ('createSurface' in m) known.set(m.createSurface.surfaceId, new Set());
    if ('updateComponents' in m) {
      const ids = known.get(m.updateComponents.surfaceId);
      if (!ids) {
        errors.push(`updateComponents before createSurface: ${m.updateComponents.surfaceId}`);
        continue;
      }
      for (const c of m.updateComponents.components) {
        if (!ID_RE.test(c.id)) errors.push(`invalid id ${c.id}`);
        if (ids.has(c.id)) errors.push(`duplicate id ${c.id}`);
        ids.add(c.id);
      }
      for (const c of m.updateComponents.components) {
        const refs = [...((c.children as string[] | undefined) ?? []), ...(c.child ? [c.child as string] : [])];
        for (const r of refs) if (!ids.has(r)) errors.push(`${c.id} references missing ${r}`);
      }
      if (!ids.has('root')) errors.push(`surface ${m.updateComponents.surfaceId} has no root`);
    }
  }
  return errors;
}
