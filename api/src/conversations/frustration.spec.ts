import {
  explicitHumanRequest,
  isFrustrated,
  negativeSentiment,
} from './frustration';

describe('explicitHumanRequest', () => {
  it.each([
    'ik wil een medewerker spreken',
    'Kan ik met een medewerker praten?',
    'ik wil graag met een mens praten',
    'ik wil een persoon spreken',
    'kan ik met iemand praten',
    'ik wil geen bot meer',
    'stuur me door naar geen bot',
    'talk to a human please',
    'I want to speak to an agent',
    'can I speak to a real person',
    'connect me with a real person',
  ])('detects NL/EN human-request phrase: %s', (text) => {
    expect(explicitHumanRequest(text)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(explicitHumanRequest('IK WIL EEN MEDEWERKER SPREKEN')).toBe(true);
    expect(explicitHumanRequest('TALK TO A HUMAN')).toBe(true);
  });

  it.each([
    'wat zijn de openingstijden',
    'what are your opening hours',
    'hallo, hoe gaat het?',
    'thanks for your help',
  ])('does not false-positive on neutral message: %s', (text) => {
    expect(explicitHumanRequest(text)).toBe(false);
  });
});

describe('negativeSentiment', () => {
  it.each([
    'dit is belachelijk',
    'wat een waardeloze service',
    'dit is echt kut',
    'ik snap er niks aan',
    'dit is gewoon slecht',
    'this is useless',
    'that is terrible',
    'this is ridiculous',
    'this is stupid',
  ])('detects negative/frustrated message: %s', (text) => {
    expect(negativeSentiment(text)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(negativeSentiment('DIT IS BELACHELIJK')).toBe(true);
    expect(negativeSentiment('THIS IS TERRIBLE')).toBe(true);
  });

  it.each([
    'wat zijn de openingstijden',
    'what are your opening hours',
    'kunt u mij helpen met mijn bestelling',
    'hoe laat gaat de winkel open',
    'can you help me track my order',
  ])('does not false-positive on neutral message: %s', (text) => {
    expect(negativeSentiment(text)).toBe(false);
  });
});

describe('isFrustrated', () => {
  it('is true on an explicit human request regardless of refusal streak', () => {
    expect(
      isFrustrated({
        latestVisitorText: 'ik wil een medewerker',
        consecutiveRefusals: 0,
        refusalStreakThreshold: 2,
      }),
    ).toBe(true);
  });

  it('is true on negative sentiment regardless of refusal streak', () => {
    expect(
      isFrustrated({
        latestVisitorText: 'dit is belachelijk',
        consecutiveRefusals: 0,
        refusalStreakThreshold: 2,
      }),
    ).toBe(true);
  });

  it('is true when consecutiveRefusals meets the threshold', () => {
    expect(
      isFrustrated({
        latestVisitorText: 'wat zijn de openingstijden',
        consecutiveRefusals: 2,
        refusalStreakThreshold: 2,
      }),
    ).toBe(true);
  });

  it('is false when consecutiveRefusals is below the threshold and text is neutral', () => {
    expect(
      isFrustrated({
        latestVisitorText: 'wat zijn de openingstijden',
        consecutiveRefusals: 1,
        refusalStreakThreshold: 2,
      }),
    ).toBe(false);
  });

  it('is true when consecutiveRefusals exceeds the threshold', () => {
    expect(
      isFrustrated({
        latestVisitorText: 'wat zijn de openingstijden',
        consecutiveRefusals: 3,
        refusalStreakThreshold: 2,
      }),
    ).toBe(true);
  });
});
