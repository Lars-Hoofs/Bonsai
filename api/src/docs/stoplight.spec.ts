import { stoplightHtml } from './stoplight';

describe('stoplightHtml', () => {
  const html = stoplightHtml('/docs-json');

  it('renders the Stoplight Elements web component pointed at the spec', () => {
    expect(html).toContain('<elements-api');
    expect(html).toContain('apiDescriptionUrl="/docs-json"');
  });

  it('loads Stoplight Elements assets', () => {
    expect(html).toContain('@stoplight/elements/web-components.min.js');
    expect(html).toContain('@stoplight/elements/styles.min.css');
  });
});
