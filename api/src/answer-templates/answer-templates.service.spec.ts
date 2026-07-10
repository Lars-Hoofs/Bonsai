import { templateMatches } from './answer-templates.service';

describe('templateMatches', () => {
  describe('keyword triggers', () => {
    it('matches a whole-word keyword case-insensitively', () => {
      expect(
        templateMatches(
          { triggerType: 'keyword', trigger: 'retour' },
          'Hoe werkt een RETOUR bij jullie?',
        ),
      ).toBe(true);
    });

    it('does not match a substring that is not a whole word', () => {
      expect(
        templateMatches(
          { triggerType: 'keyword', trigger: 'retour' },
          'Ik heb een retourneringsvraag',
        ),
      ).toBe(false);
    });

    it('does not match when the keyword is absent', () => {
      expect(
        templateMatches(
          { triggerType: 'keyword', trigger: 'garantie' },
          'Wat zijn de openingstijden?',
        ),
      ).toBe(false);
    });

    it('escapes regex metacharacters so a `.` is literal, not a wildcard', () => {
      // 'a.b' must be treated literally: it must NOT match 'axb' (which it
      // would if the '.' were an unescaped regex wildcard).
      expect(
        templateMatches(
          { triggerType: 'keyword', trigger: 'a.b' },
          'iets over axb',
        ),
      ).toBe(false);
      expect(
        templateMatches(
          { triggerType: 'keyword', trigger: 'a.b' },
          'iets over a.b hier',
        ),
      ).toBe(true);
    });
  });

  describe('intent triggers', () => {
    it('matches when every token appears as a whole word (order-independent)', () => {
      expect(
        templateMatches(
          { triggerType: 'intent', trigger: 'openingstijden weekend' },
          'zijn jullie in het weekend open qua openingstijden',
        ),
      ).toBe(true);
    });

    it('does not match when only some tokens are present', () => {
      expect(
        templateMatches(
          { triggerType: 'intent', trigger: 'openingstijden weekend' },
          'wat zijn de openingstijden doordeweeks',
        ),
      ).toBe(false);
    });

    it('collapses extra whitespace in the trigger', () => {
      expect(
        templateMatches(
          { triggerType: 'intent', trigger: '  retour   kosten  ' },
          'wat zijn de kosten van een retour',
        ),
      ).toBe(true);
    });
  });

  it('never matches an empty/whitespace-only trigger', () => {
    expect(
      templateMatches({ triggerType: 'keyword', trigger: '   ' }, 'anything'),
    ).toBe(false);
    expect(
      templateMatches({ triggerType: 'intent', trigger: '' }, 'anything'),
    ).toBe(false);
  });
});
