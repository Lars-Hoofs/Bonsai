/**
 * Bonsai default widget theme: a circular gradient launcher that is white in
 * the centre, sensible typography, rounded corners, bottom-right position, and
 * Dutch welcome copy. Tenants customise this via the visual builder; the shape
 * is intentionally open (stored as JSON) so the builder and widget can evolve
 * without backend migrations.
 */
export const DEFAULT_WIDGET_THEME: Record<string, unknown> = {
  version: 1,
  launcher: {
    iconMode: 'gradient',
    size: 60,
    corner: 'br',
  },
  gradient: { from: '#7C3AED', to: '#2563EB', centerColor: '#FFFFFF' },
  window: {
    width: 380,
    height: 560,
    radius: 16,
    background: '#FFFFFF',
    foreground: '#0F172A',
    accent: '#7C3AED',
    fontFamily: 'Inter, system-ui, sans-serif',
    openAnimation: 'slide-up',
  },
  header: { title: 'Bonsai', subtitle: 'Hoe kunnen we helpen?', avatar: null },
  welcome: {
    message: 'Hoi! Stel gerust je vraag.',
    suggestions: ['Wat zijn de openingstijden?', 'Ik wil iets retourneren'],
  },
  language: 'nl',
};
