/**
 * Bonsai default multi-language widget copy: the UI strings the embed script
 * renders (welcome message, input placeholder, send/close labels, etc.).
 * Editors customise and add locales via the copy editor. Ships with Dutch as
 * the default locale to match `DEFAULT_WIDGET_THEME`, plus an English
 * fallback. The shape is intentionally open (stored as JSON) so the builder
 * and widget can evolve without backend migrations.
 */
export const DEFAULT_WIDGET_COPY: Record<string, Record<string, string>> = {
  nl: {
    welcome: 'Hoi! Stel gerust je vraag.',
    inputPlaceholder: 'Typ je bericht...',
    sendLabel: 'Versturen',
    closeLabel: 'Sluiten',
    headerTitle: 'Bonsai',
    headerSubtitle: 'Hoe kunnen we helpen?',
  },
  en: {
    welcome: 'Hi! Ask us anything.',
    inputPlaceholder: 'Type your message...',
    sendLabel: 'Send',
    closeLabel: 'Close',
    headerTitle: 'Bonsai',
    headerSubtitle: 'How can we help?',
  },
};

export const DEFAULT_WIDGET_COPY_LOCALE = 'nl';
